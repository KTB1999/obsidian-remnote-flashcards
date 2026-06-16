import { App, Modal, MarkdownRenderer, Notice, TFile } from "obsidian";
import { Flashcard, Rating, PluginData } from "./types";
import { applyRating, newRecord } from "./sm2";
import { aiExplainAnswer } from "./ai";
import { findSeparator } from "./parser";
import type RemNoteFlashcardsPlugin from "./main";

export class ReviewModal extends Modal {
  private plugin: RemNoteFlashcardsPlugin;
  private cards: Flashcard[];
  private currentIndex: number = 0;
  private data: PluginData;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(app: App, plugin: RemNoteFlashcardsPlugin, cards: Flashcard[], data: PluginData) {
    super(app);
    this.plugin = plugin;
    this.cards = cards;
    this.data = data;
  }

  onOpen()  { this.modalEl.addClass("remnote-review-modal"); this.renderCard(); }
  onClose() {
    if (this.keyHandler) { document.removeEventListener("keydown", this.keyHandler); this.keyHandler = null; }
    this.contentEl.empty();
  }

  private get currentCard(): Flashcard { return this.cards[this.currentIndex]; }

  private async renderCard() {
    const { contentEl } = this;
    contentEl.empty();
    if (this.keyHandler) { document.removeEventListener("keydown", this.keyHandler); this.keyHandler = null; }

    if (this.currentIndex >= this.cards.length) { this.renderFinished(); return; }

    const card = this.currentCard;

    // Progress bar
    const progressWrap = contentEl.createDiv("remnote-progress-wrap");
    const progressBar = progressWrap.createDiv("remnote-progress-bar");
    progressBar.style.width = `${(this.currentIndex / this.cards.length) * 100}%`;
    progressWrap.createEl("span", { text: `${this.currentIndex + 1} / ${this.cards.length}`, cls: "remnote-progress-text" });

    // Top row: badge + source
    const topRow = contentEl.createDiv("remnote-top-row");
    const badge  = topRow.createDiv("remnote-card-badge");
    badge.setText(card.type === "basic" ? "Karteikarte" : card.type === "multilayer" ? "Mehrschichtig" : "Dropdown");

    const sourceBtn = topRow.createEl("button", { cls: "remnote-btn-source", title: "In Notiz öffnen" });
    sourceBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg> Quelle`;
    sourceBtn.onclick = () => this.openSource(card);

    // Front
    const frontEl = contentEl.createDiv("remnote-card-front");
    await MarkdownRenderer.render(this.app, card.front, frontEl, card.filePath, this.plugin);

    if (card.type === "multilayer") {
      await this.renderMultilayer(contentEl, card);
    } else if (card.type === "dropdown") {
      await this.renderDropdown(contentEl, card);
    } else {
      await this.renderBasic(contentEl, card);
    }
  }

  // ── Basic (flip) card ─────────────────────────────────────────────────────
  private async renderBasic(container: HTMLElement, card: Flashcard) {
    const flipBtn = container.createEl("button", { text: "Umdrehen  [Space]", cls: "remnote-btn remnote-btn-reveal" });
    flipBtn.onclick = async () => {
      flipBtn.style.display = "none";
      const answerEl = container.createDiv("remnote-card-back");
      await MarkdownRenderer.render(this.app, card.back, answerEl, card.filePath, this.plugin);
      this.showAnswerActions(container, card);
    };
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === " " && !this.isRatingVisible(container)) { e.preventDefault(); flipBtn.click(); }
    };
    document.addEventListener("keydown", this.keyHandler);
  }

  // ── Dropdown (cloze) card ─────────────────────────────────────────────────
  private async renderDropdown(container: HTMLElement, card: Flashcard) {
    const dropEl = container.createDiv("remnote-dropdown-answer");
    dropEl.addClass("remnote-blurred");
    await MarkdownRenderer.render(this.app, card.back, dropEl, card.filePath, this.plugin);

    const revealBtn = container.createEl("button", { text: "Antwort anzeigen", cls: "remnote-btn remnote-btn-reveal" });
    revealBtn.onclick = () => {
      dropEl.removeClass("remnote-blurred");
      revealBtn.style.display = "none";
      this.showAnswerActions(container, card);
    };
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === " " && !this.isRatingVisible(container)) { e.preventDefault(); revealBtn.click(); }
    };
    document.addEventListener("keydown", this.keyHandler);
  }

  // ── Multilayer card ───────────────────────────────────────────────────────
  private async renderMultilayer(container: HTMLElement, card: Flashcard) {
    const revealBtn = container.createEl("button", { text: "Unterfragen anzeigen  [Space]", cls: "remnote-btn remnote-btn-reveal" });

    revealBtn.onclick = async () => {
      revealBtn.style.display = "none";
      const mlContainer = container.createDiv("remnote-multilayer-container");
      await this.renderMultilayerBack(card.back, mlContainer, card.filePath);
      this.showAnswerActions(container, card);
    };

    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === " " && !this.isRatingVisible(container)) { e.preventDefault(); revealBtn.click(); }
    };
    document.addEventListener("keydown", this.keyHandler);
  }

  /**
   * Render multilayer back content.
   * Lines matching `- Question :: Answer` become interactive rows:
   *   - Question is always visible
   *   - Answer is blurred, click to reveal
   * Lines with `:::` get a nested sub-section toggle.
   * Plain lines render as normal markdown.
   */
  private async renderMultilayerBack(back: string, container: HTMLElement, filePath: string) {
    const lines = back.split("\n");
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) { i++; continue; }

      // Strip bullet marker to inspect content
      const content = trimmed.replace(/^[-*+]\s+/, "");
      const indent   = line.match(/^(\s*)/)?.[1]?.length ?? 0;

      // Check for ::: separator in this line
      const dropIdx = findSeparator(content, ":::");
      if (dropIdx !== -1) {
        const qText = content.slice(0, dropIdx).trim();
        const aText = content.slice(dropIdx + 3).trim();

        // Collect nested sub-items (deeper indent)
        const subLines: string[] = [];
        let j = i + 1;
        while (j < lines.length) {
          const nextTrimmed = lines[j].trim();
          const nextIndent  = lines[j].match(/^(\s*)/)?.[1]?.length ?? 0;
          if (!nextTrimmed || nextIndent <= indent) break;
          subLines.push(lines[j]);
          j++;
        }

        const row = container.createDiv("remnote-ml-row remnote-ml-has-nested");

        // Question part (always visible)
        const qEl = row.createDiv("remnote-ml-question");
        await MarkdownRenderer.render(this.app, qText, qEl, filePath, this.plugin);

        // Answer part (blurred, click to reveal)
        if (aText) {
          const sep = row.createSpan({ text: "→", cls: "remnote-ml-sep" });
          const aEl = row.createDiv("remnote-ml-answer remnote-blurred");
          await MarkdownRenderer.render(this.app, aText, aEl, filePath, this.plugin);
          sep.onclick = aEl.onclick = () => aEl.removeClass("remnote-blurred");
        }

        // Nested sub-items (collapsed, expand button)
        if (subLines.length > 0) {
          const toggleBtn = row.createEl("button", { text: "+ Details", cls: "remnote-ml-toggle" });
          const subContainer = row.createDiv("remnote-ml-subcontainer");
          subContainer.style.display = "none";
          await this.renderMultilayerBack(subLines.join("\n"), subContainer, filePath);
          toggleBtn.onclick = () => {
            const open = subContainer.style.display !== "none";
            subContainer.style.display = open ? "none" : "block";
            toggleBtn.setText(open ? "+ Details" : "− Details");
          };
        }

        i = j;
        continue;
      }

      // Check for :: separator
      const basicIdx = findSeparator(content, "::");
      if (basicIdx !== -1) {
        const qText = content.slice(0, basicIdx).trim();
        const aText = content.slice(basicIdx + 2).trim();

        const row = container.createDiv("remnote-ml-row");

        const qEl = row.createDiv("remnote-ml-question");
        await MarkdownRenderer.render(this.app, qText, qEl, filePath, this.plugin);

        if (aText) {
          const sep = row.createSpan({ text: "→", cls: "remnote-ml-sep" });
          const aEl = row.createDiv("remnote-ml-answer remnote-blurred");
          await MarkdownRenderer.render(this.app, aText, aEl, filePath, this.plugin);
          sep.onclick = aEl.onclick = () => aEl.removeClass("remnote-blurred");
        }

        i++;
        continue;
      }

      // Plain line — render as markdown
      const plain = container.createDiv("remnote-ml-plain");
      await MarkdownRenderer.render(this.app, trimmed.replace(/^[-*+]\s+/, ""), plain, filePath, this.plugin);
      i++;
    }
  }

  // ── Shared ────────────────────────────────────────────────────────────────
  private isRatingVisible(container: HTMLElement): boolean {
    return !!container.querySelector(".remnote-rating-wrap");
  }

  private showAnswerActions(container: HTMLElement, card: Flashcard) {
    if (this.plugin.pluginData.settings.aiEnabled) {
      const aiRow = container.createDiv("remnote-ai-row");
      const aiBtn = aiRow.createEl("button", { text: "✦ Erklären", cls: "remnote-btn remnote-btn-ai" });
      aiBtn.onclick = async () => {
        aiBtn.disabled = true; aiBtn.setText("Erkläre...");
        try {
          const explanation = await aiExplainAnswer(card.front, card.back, this.plugin.pluginData.settings);
          aiBtn.style.display = "none";
          const aiEl = container.createDiv("remnote-ai-answer");
          aiEl.createEl("span", { text: "✦ ", cls: "remnote-ai-label" });
          await MarkdownRenderer.render(this.app, explanation, aiEl, card.filePath, this.plugin);
        } catch (e) {
          aiBtn.disabled = false; aiBtn.setText("✦ Erklären");
          new Notice("AI Fehler: " + e.message);
        }
      };
    }
    this.showRatingButtons(container, card);
  }

  private showRatingButtons(container: HTMLElement, card: Flashcard) {
    const ratingWrap = container.createDiv("remnote-rating-wrap");
    ratingWrap.createEl("p", { text: "Wie gut wusstest du die Antwort?", cls: "remnote-rating-label" });

    const buttons: { rating: Rating; label: string; key: string }[] = [
      { rating: "again", label: "Wieder",  key: "1" },
      { rating: "hard",  label: "Schwer",  key: "2" },
      { rating: "good",  label: "Gut",     key: "3" },
      { rating: "easy",  label: "Einfach", key: "4" },
    ];
    const btnRow = ratingWrap.createDiv("remnote-rating-buttons");
    for (const { rating, label, key } of buttons) {
      const btn = btnRow.createEl("button", { cls: `remnote-btn remnote-btn-rating remnote-rating-${rating}` });
      btn.innerHTML = `<span class="remnote-rating-key">${key}</span>${label}`;
      btn.onclick = () => this.submitRating(rating);
    }

    if (this.keyHandler) document.removeEventListener("keydown", this.keyHandler);
    this.keyHandler = (e: KeyboardEvent) => {
      const map: Record<string, Rating> = { "1": "again", "2": "hard", "3": "good", "4": "easy" };
      if (map[e.key]) { this.submitRating(map[e.key]); document.removeEventListener("keydown", this.keyHandler!); this.keyHandler = null; }
    };
    document.addEventListener("keydown", this.keyHandler);
  }

  private async submitRating(rating: Rating) {
    const card = this.currentCard;
    const existing = this.data.reviews[card.id] ?? newRecord(card.id);
    this.data.reviews[card.id] = applyRating(existing, rating);
    await this.plugin.savePluginData();
    this.currentIndex++;
    await this.renderCard();
  }

  private async openSource(card: Flashcard) {
    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    if (!(file instanceof TFile)) { new Notice("Datei nicht gefunden: " + card.filePath); return; }
    this.close();
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    const view = (leaf as any).view;
    if (view?.editor) {
      view.editor.setCursor({ line: card.line, ch: 0 });
      view.editor.scrollIntoView({ from: { line: card.line, ch: 0 }, to: { line: card.line, ch: 999 } }, true);
    }
  }

  private renderFinished() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createDiv("remnote-finished-icon").setText("✓");
    contentEl.createEl("h2", { text: "Sitzung abgeschlossen!", cls: "remnote-finished-title" });
    contentEl.createEl("p", { text: `${this.cards.length} Karten bearbeitet.`, cls: "remnote-finished-sub" });
    const doneBtn = contentEl.createEl("button", { text: "Schließen", cls: "remnote-btn remnote-btn-reveal" });
    doneBtn.onclick = () => this.close();
  }
}
