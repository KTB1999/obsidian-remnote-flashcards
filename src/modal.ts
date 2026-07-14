import { App, Modal, MarkdownRenderer, Notice, TFile } from "obsidian";
import { Flashcard, Rating, PluginData, SessionState } from "./types";
import { applyRating, newRecord, isDue } from "./sm2";
import { aiExplainAnswer } from "./ai";
import { findSeparator } from "./parser";
import type RemNoteFlashcardsPlugin from "./main";

export interface ReviewOptions {
  shuffle?: boolean;
  filterId?: string;
  filterLabel?: string;
}

type SessionAction = Rating | "skip";

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const RATING_ICON: Record<Rating, string>  = { again: "🔴", hard: "🟡", good: "🟢", easy: "🔵" };
const RATING_LABEL: Record<Rating, string> = { again: "Wieder", hard: "Schwer", good: "Gut", easy: "Einfach" };

function cardStatusIcon(card: Flashcard, data: PluginData, sessionResults: { card: Flashcard; action: SessionAction }[]): string {
  // Check if already answered this session
  const entry = sessionResults.find(r => r.card.id === card.id);
  if (entry) {
    if (entry.action === "skip") return "⏭";
    return RATING_ICON[entry.action as Rating];
  }
  const rec = data.reviews[card.id];
  if (!rec) return "⬜";            // never reviewed
  if (isDue(rec)) return "🔴";      // due today
  return "✅";                       // learned, not yet due
}

export class ReviewModal extends Modal {
  private plugin: RemNoteFlashcardsPlugin;
  private cards: Flashcard[];
  private currentIndex: number = 0;
  private data: PluginData;
  private options: ReviewOptions;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  private history: number[] = [];
  private sessionResults: { card: Flashcard; action: SessionAction }[] = [];

  constructor(
    app: App,
    plugin: RemNoteFlashcardsPlugin,
    cards: Flashcard[],
    data: PluginData,
    options: ReviewOptions = {}
  ) {
    super(app);
    this.plugin  = plugin;
    this.data    = data;
    this.options = options;
    this.cards   = options.shuffle ? shuffleArray(cards) : [...cards];
  }

  onOpen()  { this.modalEl.addClass("remnote-review-modal"); this.renderCard(); }
  onClose() {
    if (this.keyHandler) { document.removeEventListener("keydown", this.keyHandler); this.keyHandler = null; }
    this.contentEl.empty();
    this.plugin.pluginData.lastSession = null;
    this.plugin.savePluginData();
  }

  private get currentCard(): Flashcard { return this.cards[this.currentIndex]; }

  private saveProgress() {
    this.plugin.pluginData.lastSession = {
      cardIds:     this.cards.map(c => c.id),
      currentIndex: this.currentIndex,
      shuffled:    this.options.shuffle ?? false,
      filterId:    this.options.filterId ?? "unknown",
      filterLabel: this.options.filterLabel ?? "",
    } as SessionState;
    this.plugin.savePluginData();
  }

  // ── Progress row ──────────────────────────────────────────────────────────
  private buildProgressRow(contentEl: HTMLElement) {
    const progressWrap = contentEl.createDiv("remnote-progress-wrap");
    const progressBar  = progressWrap.createDiv("remnote-progress-bar");
    progressBar.style.width = `${(this.currentIndex / this.cards.length) * 100}%`;

    const row = progressWrap.createDiv("remnote-progress-row");

    // Back
    const backBtn = row.createEl("button", { cls: "remnote-btn-back" });
    backBtn.innerHTML = `← Zurück`;
    backBtn.disabled  = this.history.length === 0;
    backBtn.onclick   = () => this.goBack();

    // Skip
    const skipBtn = row.createEl("button", { cls: "remnote-btn-skip" });
    skipBtn.innerHTML = `⏭ Überspringen`;
    skipBtn.onclick   = () => this.skipCard();

    // Shuffle indicator (shown when session was shuffled)
    if (this.options.shuffle) {
      row.createEl("span", { text: "🔀", cls: "remnote-shuffle-indicator", title: "Zufällige Reihenfolge aktiv" });
    }

    // Counter (clickable → navigation dropdown)
    const counterBtn = row.createEl("button", { cls: "remnote-progress-counter" });
    counterBtn.setText(`${this.currentIndex + 1} / ${this.cards.length} ▾`);
    counterBtn.onclick = (e) => { e.stopPropagation(); this.toggleNavDropdown(counterBtn); };
  }

  // ── Navigation dropdown ───────────────────────────────────────────────────
  private toggleNavDropdown(anchor: HTMLElement) {
    const existing = this.contentEl.querySelector<HTMLElement>(".remnote-nav-dropdown");
    if (existing) { existing.remove(); return; }

    const dropdown = this.contentEl.createDiv("remnote-nav-dropdown");

    for (let i = 0; i < this.cards.length; i++) {
      const card  = this.cards[i];
      const icon  = cardStatusIcon(card, this.data, this.sessionResults);
      const front = card.front.replace(/^#+\s+/, "").slice(0, 50) + (card.front.length > 50 ? "…" : "");

      const item = dropdown.createDiv("remnote-nav-item" + (i === this.currentIndex ? " current" : ""));
      item.createSpan({ text: icon,        cls: "remnote-nav-icon" });
      item.createSpan({ text: front,       cls: "remnote-nav-front" });
      item.createSpan({ text: `${i + 1}`,  cls: "remnote-nav-num" });

      item.onclick = () => {
        dropdown.remove();
        this.currentIndex = i;
        this.renderCard();
      };
    }

    // Scroll current item into view
    setTimeout(() => {
      const cur = dropdown.querySelector<HTMLElement>(".remnote-nav-item.current");
      cur?.scrollIntoView({ block: "center" });
    }, 0);

    // Close on outside click
    const closeHandler = (e: MouseEvent) => {
      if (!dropdown.contains(e.target as Node) && e.target !== anchor) {
        dropdown.remove();
        document.removeEventListener("mousedown", closeHandler);
      }
    };
    setTimeout(() => document.addEventListener("mousedown", closeHandler), 0);
  }

  // ── Skip ──────────────────────────────────────────────────────────────────
  private skipCard() {
    const card = this.currentCard;
    this.sessionResults.push({ card, action: "skip" });
    this.history.push(this.currentIndex);
    this.currentIndex++;
    this.saveProgress();
    this.renderCard();
  }

  // ── Back ──────────────────────────────────────────────────────────────────
  private goBack() {
    if (this.history.length === 0) return;
    this.currentIndex = this.history.pop()!;
    this.sessionResults.pop();
    this.renderCard();
  }

  // ── Main render ───────────────────────────────────────────────────────────
  private async renderCard() {
    const { contentEl } = this;
    contentEl.empty();
    if (this.keyHandler) { document.removeEventListener("keydown", this.keyHandler); this.keyHandler = null; }

    if (this.currentIndex >= this.cards.length) { this.renderFinished(); return; }

    this.buildProgressRow(contentEl);

    const card = this.currentCard;

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

    if      (card.type === "multilayer") await this.renderMultilayer(contentEl, card);
    else if (card.type === "dropdown")   await this.renderDropdown(contentEl, card);
    else                                  await this.renderBasic(contentEl, card);
  }

  // ── Basic ─────────────────────────────────────────────────────────────────
  private async renderBasic(container: HTMLElement, card: Flashcard) {
    const flipBtn = container.createEl("button", { text: "Umdrehen  [Space]", cls: "remnote-btn remnote-btn-reveal" });
    flipBtn.onclick = async () => {
      flipBtn.style.display = "none";
      const answerEl = container.createDiv("remnote-card-back");
      await MarkdownRenderer.render(this.app, card.back, answerEl, card.filePath, this.plugin);
      this.showAnswerActions(container, card);
    };
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === " "         && !this.isRatingVisible(container)) { e.preventDefault(); flipBtn.click(); }
      if (e.key === "Backspace" && !this.isRatingVisible(container)) { e.preventDefault(); this.goBack(); }
    };
    document.addEventListener("keydown", this.keyHandler);
  }

  // ── Dropdown ──────────────────────────────────────────────────────────────
  private async renderDropdown(container: HTMLElement, card: Flashcard) {
    const dropEl = container.createDiv("remnote-dropdown-answer remnote-blurred");
    await MarkdownRenderer.render(this.app, card.back, dropEl, card.filePath, this.plugin);

    const revealBtn = container.createEl("button", { text: "Antwort anzeigen", cls: "remnote-btn remnote-btn-reveal" });
    revealBtn.onclick = () => {
      dropEl.removeClass("remnote-blurred");
      revealBtn.style.display = "none";
      this.showAnswerActions(container, card);
    };
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === " "         && !this.isRatingVisible(container)) { e.preventDefault(); revealBtn.click(); }
      if (e.key === "Backspace" && !this.isRatingVisible(container)) { e.preventDefault(); this.goBack(); }
    };
    document.addEventListener("keydown", this.keyHandler);
  }

  // ── Multilayer ────────────────────────────────────────────────────────────
  private async renderMultilayer(container: HTMLElement, card: Flashcard) {
    const revealBtn = container.createEl("button", { text: "Unterfragen anzeigen  [Space]", cls: "remnote-btn remnote-btn-reveal" });
    revealBtn.onclick = async () => {
      revealBtn.style.display = "none";
      if (this.keyHandler) { document.removeEventListener("keydown", this.keyHandler); this.keyHandler = null; }
      const mlContainer = container.createDiv("remnote-multilayer-container");
      await this.renderMultilayerItems(card.back, mlContainer, card);
    };
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === " "         && !this.isRatingVisible(container)) { e.preventDefault(); revealBtn.click(); }
      if (e.key === "Backspace" && !this.isRatingVisible(container)) { e.preventDefault(); this.goBack(); }
    };
    document.addEventListener("keydown", this.keyHandler);
  }

  private async renderMultilayerItems(back: string, container: HTMLElement, card: Flashcard) {
    const ratingOrder: Rating[] = ["again", "hard", "good", "easy"];
    const ratingValue = (r: Rating): number => ratingOrder.indexOf(r);

    const lines = back.split("\n");
    const parsedItems: Array<{ qText: string; aText: string; isRateable: boolean }> = [];

    let i = 0;
    while (i < lines.length) {
      const line    = lines[i];
      const trimmed = line.trim();
      if (!trimmed) { i++; continue; }
      const content = trimmed.replace(/^[-*+]\s+/, "");
      const indent  = line.match(/^(\s*)/)?.[1]?.length ?? 0;

      const dropIdx = findSeparator(content, ":::");
      if (dropIdx !== -1) {
        const qText = content.slice(0, dropIdx).trim();
        const aText = content.slice(dropIdx + 3).trim();
        const subLines: string[] = [];
        let j = i + 1;
        while (j < lines.length) {
          const nextIndent = lines[j].match(/^(\s*)/)?.[1]?.length ?? 0;
          if (!lines[j].trim() || nextIndent <= indent) break;
          subLines.push(lines[j]); j++;
        }
        const fullAnswer = [aText, ...subLines].filter(Boolean).join("\n");
        parsedItems.push({ qText, aText: fullAnswer, isRateable: true });
        i = j; continue;
      }

      const basicIdx = findSeparator(content, "::");
      if (basicIdx !== -1) {
        parsedItems.push({
          qText: content.slice(0, basicIdx).trim(),
          aText: content.slice(basicIdx + 2).trim(),
          isRateable: true,
        });
        i++; continue;
      }

      parsedItems.push({ qText: content, aText: "", isRateable: false });
      i++;
    }

    const rateableItems = parsedItems.filter(it => it.isRateable);
    if (rateableItems.length === 0) {
      await this.renderMultilayerBack(back, container, card.filePath);
      this.showAnswerActions(container, card);
      return;
    }

    const ratings = new Map<number, Rating>();

    for (let idx = 0; idx < parsedItems.length; idx++) {
      const item = parsedItems[idx];

      if (!item.isRateable) {
        const plain = container.createDiv("remnote-ml-plain");
        await MarkdownRenderer.render(this.app, item.qText, plain, card.filePath, this.plugin);
        continue;
      }

      const rateableIdx = rateableItems.indexOf(item);
      const row = container.createDiv("remnote-ml-row remnote-ml-progressive");

      const qEl = row.createDiv("remnote-ml-question remnote-ml-clickable");
      await MarkdownRenderer.render(this.app, item.qText, qEl, card.filePath, this.plugin);
      qEl.createSpan({ text: " ▶", cls: "remnote-ml-expand-hint" });

      const expandArea = row.createDiv("remnote-ml-expand-area");
      expandArea.style.display = "none";

      let expanded = false;
      qEl.onclick = async () => {
        if (expanded) return;
        expanded = true;
        qEl.classList.remove("remnote-ml-clickable");
        qEl.querySelector<HTMLElement>(".remnote-ml-expand-hint")?.remove();
        expandArea.style.display = "block";

        const aEl = expandArea.createDiv("remnote-ml-answer");
        await MarkdownRenderer.render(this.app, item.aText, aEl, card.filePath, this.plugin);

        const itemRatingWrap = expandArea.createDiv("remnote-ml-item-rating");
        const btnRow = itemRatingWrap.createDiv("remnote-ml-item-btn-row");

        const ratingDefs: { rating: Rating; label: string }[] = [
          { rating: "again", label: "Wieder" },
          { rating: "hard",  label: "Schwer" },
          { rating: "good",  label: "Gut" },
          { rating: "easy",  label: "Einfach" },
        ];

        for (const { rating, label } of ratingDefs) {
          const btn = btnRow.createEl("button", {
            cls: `remnote-btn remnote-ml-item-btn remnote-rating-${rating}`,
            text: label,
          });
          btn.onclick = () => {
            btnRow.querySelectorAll<HTMLButtonElement>("button").forEach(b => {
              b.disabled = true;
              b.classList.remove("remnote-ml-item-btn-selected");
            });
            btn.classList.add("remnote-ml-item-btn-selected");
            ratings.set(rateableIdx, rating);

            if (ratings.size >= rateableItems.length) {
              const worst = Array.from(ratings.values()).reduce((w, r) =>
                ratingValue(r) < ratingValue(w) ? r : w
              );
              setTimeout(() => this.submitRating(worst), 350);
            }
          };
        }
      };
    }
  }

  private async renderMultilayerBack(back: string, container: HTMLElement, filePath: string) {
    const lines = back.split("\n");
    let i = 0;
    while (i < lines.length) {
      const line    = lines[i];
      const trimmed = line.trim();
      if (!trimmed) { i++; continue; }
      const content = trimmed.replace(/^[-*+]\s+/, "");
      const indent  = line.match(/^(\s*)/)?.[1]?.length ?? 0;

      const dropIdx = findSeparator(content, ":::");
      if (dropIdx !== -1) {
        const qText    = content.slice(0, dropIdx).trim();
        const aText    = content.slice(dropIdx + 3).trim();
        const subLines: string[] = [];
        let j = i + 1;
        while (j < lines.length) {
          const nextIndent = lines[j].match(/^(\s*)/)?.[1]?.length ?? 0;
          if (!lines[j].trim() || nextIndent <= indent) break;
          subLines.push(lines[j]); j++;
        }
        const row = container.createDiv("remnote-ml-row remnote-ml-has-nested");
        const qEl = row.createDiv("remnote-ml-question");
        await MarkdownRenderer.render(this.app, qText, qEl, filePath, this.plugin);
        if (aText) {
          const sep = row.createSpan({ text: "→", cls: "remnote-ml-sep" });
          const aEl = row.createDiv("remnote-ml-answer remnote-blurred");
          await MarkdownRenderer.render(this.app, aText, aEl, filePath, this.plugin);
          sep.onclick = aEl.onclick = () => aEl.removeClass("remnote-blurred");
        }
        if (subLines.length > 0) {
          const toggleBtn    = row.createEl("button", { text: "+ Details", cls: "remnote-ml-toggle" });
          const subContainer = row.createDiv("remnote-ml-subcontainer");
          subContainer.style.display = "none";
          await this.renderMultilayerBack(subLines.join("\n"), subContainer, filePath);
          toggleBtn.onclick = () => {
            const open = subContainer.style.display !== "none";
            subContainer.style.display = open ? "none" : "block";
            toggleBtn.setText(open ? "+ Details" : "− Details");
          };
        }
        i = j; continue;
      }

      const basicIdx = findSeparator(content, "::");
      if (basicIdx !== -1) {
        const qText = content.slice(0, basicIdx).trim();
        const aText = content.slice(basicIdx + 2).trim();
        const row   = container.createDiv("remnote-ml-row");
        const qEl   = row.createDiv("remnote-ml-question");
        await MarkdownRenderer.render(this.app, qText, qEl, filePath, this.plugin);
        if (aText) {
          const sep = row.createSpan({ text: "→", cls: "remnote-ml-sep" });
          const aEl = row.createDiv("remnote-ml-answer remnote-blurred");
          await MarkdownRenderer.render(this.app, aText, aEl, filePath, this.plugin);
          sep.onclick = aEl.onclick = () => aEl.removeClass("remnote-blurred");
        }
        i++; continue;
      }

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
      if (e.key === "Backspace") { e.preventDefault(); document.removeEventListener("keydown", this.keyHandler!); this.keyHandler = null; this.goBack(); }
    };
    document.addEventListener("keydown", this.keyHandler);
  }

  private async submitRating(rating: Rating) {
    const card     = this.currentCard;
    const existing = this.data.reviews[card.id] ?? newRecord(card.id);
    this.data.reviews[card.id] = applyRating(existing, rating);
    this.sessionResults.push({ card, action: rating });
    this.history.push(this.currentIndex);
    this.currentIndex++;
    await this.plugin.savePluginData();
    this.saveProgress();
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

  // ── End-of-session performance view ──────────────────────────────────────
  private renderFinished() {
    const { contentEl } = this;
    contentEl.empty();

    const rated   = this.sessionResults.filter(r => r.action !== "skip");
    const skipped = this.sessionResults.filter(r => r.action === "skip");

    contentEl.createDiv("remnote-finished-icon").setText("✓");
    contentEl.createEl("h2", { text: "Sitzung abgeschlossen!", cls: "remnote-finished-title" });
    contentEl.createEl("p", {
      text: `${rated.length} bewertet · ${skipped.length} übersprungen`,
      cls: "remnote-finished-sub",
    });

    if (rated.length > 0) {
      const counts: Record<Rating, number> = { again: 0, hard: 0, good: 0, easy: 0 };
      for (const r of rated) counts[r.action as Rating]++;

      const summaryRow = contentEl.createDiv("remnote-finished-summary");
      for (const rating of ["again", "hard", "good", "easy"] as Rating[]) {
        if (counts[rating] === 0) continue;
        const chip = summaryRow.createDiv(`remnote-finished-chip remnote-rating-chip-${rating}`);
        chip.setText(`${RATING_ICON[rating]} ${counts[rating]}× ${RATING_LABEL[rating]}`);
      }
    }

    if (this.sessionResults.length > 0) {
      const tableWrap = contentEl.createDiv("remnote-finished-table-wrap");
      const table     = tableWrap.createEl("table", { cls: "remnote-finished-table" });
      const hrow      = table.createEl("thead").createEl("tr");
      hrow.createEl("th", { text: "Karte" });
      hrow.createEl("th", { text: "Bewertung" });
      hrow.createEl("th", { text: "Nächste Wdh." });

      const tbody = table.createEl("tbody");
      for (const { card, action } of this.sessionResults) {
        const rec  = this.data.reviews[card.id];
        const next = action === "skip" ? "—"
          : rec ? (rec.interval === 1 ? "Morgen" : `In ${rec.interval} Tagen`) : "—";
        const tr = tbody.createEl("tr");
        tr.createEl("td", { text: card.front.slice(0, 50) + (card.front.length > 50 ? "…" : "") });
        const ratingTd = tr.createEl("td");
        if (action === "skip") {
          ratingTd.createSpan({ text: "⏭ Übersprungen", cls: "remnote-result-badge remnote-result-skipped" });
        } else {
          ratingTd.createSpan({ text: `${RATING_ICON[action as Rating]} ${RATING_LABEL[action as Rating]}`, cls: `remnote-result-badge remnote-rating-${action}` });
        }
        tr.createEl("td", { text: next, cls: "remnote-result-next" });
      }
    }

    const doneBtn = contentEl.createEl("button", { text: "Schließen", cls: "remnote-btn remnote-btn-reveal remnote-finished-close" });
    doneBtn.onclick = () => this.close();
  }
}
