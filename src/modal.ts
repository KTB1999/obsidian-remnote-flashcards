import { App, Modal, MarkdownRenderer, Notice, TFile } from "obsidian";
import { Flashcard, Rating, PluginData } from "./types";
import { applyRating, newRecord } from "./sm2";
import { aiExplainAnswer } from "./ai";
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

  onOpen() {
    this.modalEl.addClass("remnote-review-modal");
    this.renderCard();
  }

  onClose() {
    if (this.keyHandler) {
      document.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = null;
    }
    this.contentEl.empty();
  }

  private get currentCard(): Flashcard {
    return this.cards[this.currentIndex];
  }

  private async renderCard() {
    const { contentEl } = this;
    contentEl.empty();

    // Remove any previous keyboard handler
    if (this.keyHandler) {
      document.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = null;
    }

    if (this.currentIndex >= this.cards.length) {
      this.renderFinished();
      return;
    }

    const card = this.currentCard;

    // --- Progress bar ---
    const progressWrap = contentEl.createDiv("remnote-progress-wrap");
    const progressBar = progressWrap.createDiv("remnote-progress-bar");
    progressBar.style.width = `${(this.currentIndex / this.cards.length) * 100}%`;
    progressWrap.createEl("span", {
      text: `${this.currentIndex + 1} / ${this.cards.length}`,
      cls: "remnote-progress-text",
    });

    // --- Top row: badge + source link ---
    const topRow = contentEl.createDiv("remnote-top-row");
    const badge = topRow.createDiv("remnote-card-badge");
    badge.setText(card.type === "basic" ? "Karteikarte" : "Dropdown");

    const sourceBtn = topRow.createEl("button", {
      cls: "remnote-btn-source",
      title: "In Notiz öffnen",
    });
    sourceBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg> Quelle`;
    sourceBtn.onclick = () => this.openSource(card);

    // --- Front of card ---
    const frontEl = contentEl.createDiv("remnote-card-front");
    await MarkdownRenderer.render(this.app, card.front, frontEl, card.filePath, this.plugin);

    // --- Card body by type ---
    if (card.type === "dropdown") {
      const dropEl = contentEl.createDiv("remnote-dropdown-answer");
      dropEl.addClass("remnote-blurred");
      await MarkdownRenderer.render(this.app, card.back, dropEl, card.filePath, this.plugin);

      const revealBtn = contentEl.createEl("button", {
        text: "Antwort anzeigen",
        cls: "remnote-btn remnote-btn-reveal",
      });
      revealBtn.onclick = () => {
        dropEl.removeClass("remnote-blurred");
        revealBtn.style.display = "none";
        this.showAnswerActions(contentEl, card);
      };

      // Space bar to reveal
      this.keyHandler = (e: KeyboardEvent) => {
        if (e.key === " " && !this.isRatingVisible(contentEl)) {
          e.preventDefault();
          revealBtn.click();
        }
      };
      document.addEventListener("keydown", this.keyHandler);
    } else {
      const flipBtn = contentEl.createEl("button", {
        text: "Umdrehen  [Space]",
        cls: "remnote-btn remnote-btn-reveal",
      });
      flipBtn.onclick = async () => {
        flipBtn.style.display = "none";
        const answerEl = contentEl.createDiv("remnote-card-back");
        await MarkdownRenderer.render(this.app, card.back, answerEl, card.filePath, this.plugin);
        this.showAnswerActions(contentEl, card);
      };

      this.keyHandler = (e: KeyboardEvent) => {
        if (e.key === " " && !this.isRatingVisible(contentEl)) {
          e.preventDefault();
          flipBtn.click();
        }
      };
      document.addEventListener("keydown", this.keyHandler);
    }
  }

  private isRatingVisible(container: HTMLElement): boolean {
    return !!container.querySelector(".remnote-rating-wrap");
  }

  private showAnswerActions(container: HTMLElement, card: Flashcard) {
    // AI explain button (only after showing answer)
    if (this.plugin.pluginData.settings.aiEnabled) {
      const aiRow = container.createDiv("remnote-ai-row");
      const aiBtn = aiRow.createEl("button", {
        text: "✦ Erklären",
        cls: "remnote-btn remnote-btn-ai",
      });
      aiBtn.onclick = async () => {
        aiBtn.disabled = true;
        aiBtn.setText("Erkläre...");
        try {
          const explanation = await aiExplainAnswer(
            card.front,
            card.back,
            this.plugin.pluginData.settings
          );
          aiBtn.style.display = "none";
          const aiEl = container.createDiv("remnote-ai-answer");
          aiEl.createEl("span", { text: "✦ ", cls: "remnote-ai-label" });
          await MarkdownRenderer.render(this.app, explanation, aiEl, card.filePath, this.plugin);
        } catch (e) {
          aiBtn.disabled = false;
          aiBtn.setText("✦ Erklären");
          new Notice("AI Fehler: " + e.message);
        }
      };
    }

    this.showRatingButtons(container, card);
  }

  private showRatingButtons(container: HTMLElement, card: Flashcard) {
    const ratingWrap = container.createDiv("remnote-rating-wrap");
    ratingWrap.createEl("p", {
      text: "Wie gut wusstest du die Antwort?",
      cls: "remnote-rating-label",
    });

    const buttons: { rating: Rating; label: string; key: string }[] = [
      { rating: "again", label: "Wieder",  key: "1" },
      { rating: "hard",  label: "Schwer",  key: "2" },
      { rating: "good",  label: "Gut",     key: "3" },
      { rating: "easy",  label: "Einfach", key: "4" },
    ];

    const btnRow = ratingWrap.createDiv("remnote-rating-buttons");
    for (const { rating, label, key } of buttons) {
      const btn = btnRow.createEl("button", {
        cls: `remnote-btn remnote-btn-rating remnote-rating-${rating}`,
      });
      btn.innerHTML = `<span class="remnote-rating-key">${key}</span>${label}`;
      btn.onclick = () => this.submitRating(rating);
    }

    // Keyboard shortcuts 1-4
    if (this.keyHandler) {
      document.removeEventListener("keydown", this.keyHandler);
    }
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === "1") this.submitRating("again");
      else if (e.key === "2") this.submitRating("hard");
      else if (e.key === "3") this.submitRating("good");
      else if (e.key === "4") this.submitRating("easy");
      else return;
      document.removeEventListener("keydown", this.keyHandler!);
      this.keyHandler = null;
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
    if (!(file instanceof TFile)) {
      new Notice("Datei nicht gefunden: " + card.filePath);
      return;
    }
    this.close();
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    // Scroll to the card's line
    const view = (leaf as any).view;
    if (view?.editor) {
      view.editor.setCursor({ line: card.line, ch: 0 });
      view.editor.scrollIntoView(
        { from: { line: card.line, ch: 0 }, to: { line: card.line, ch: 999 } },
        true
      );
    }
  }

  private renderFinished() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createDiv("remnote-finished-icon").setText("✓");
    contentEl.createEl("h2", { text: "Sitzung abgeschlossen!", cls: "remnote-finished-title" });
    contentEl.createEl("p", {
      text: `${this.cards.length} Karten bearbeitet.`,
      cls: "remnote-finished-sub",
    });
    const doneBtn = contentEl.createEl("button", {
      text: "Schließen",
      cls: "remnote-btn remnote-btn-reveal",
    });
    doneBtn.onclick = () => this.close();
  }
}
