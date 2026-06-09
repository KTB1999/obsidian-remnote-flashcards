import { App, Modal, TFile, TFolder, Notice } from "obsidian";
import { Flashcard, ExamGroup } from "./types";
import { getStats, buildDailySession, getSessionCards, cardsForGroup, cardsForPath, cardsWithoutGroup } from "./scheduler";
import { ReviewModal } from "./modal";
import { daysBetween, todayStr } from "./sm2";
import type RemNoteFlashcardsPlugin from "./main";

export class SessionPickerModal extends Modal {
  private plugin: RemNoteFlashcardsPlugin;
  private allCards: Flashcard[];

  constructor(app: App, plugin: RemNoteFlashcardsPlugin, allCards: Flashcard[]) {
    super(app);
    this.plugin = plugin;
    this.allCards = allCards;
  }

  onOpen() {
    this.modalEl.addClass("remnote-picker-modal");
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Lernsitzung starten", cls: "remnote-picker-title" });

    const data = this.plugin.pluginData;
    const groups = data.settings.examGroups;

    // === Exam Groups ===
    if (groups.length > 0) {
      contentEl.createEl("h3", { text: "Prüfungen", cls: "remnote-picker-section" });

      for (const group of groups) {
        const groupCards = cardsForGroup(this.allCards, group);
        const session = buildDailySession(groupCards, data, group.examDate, group.name);
        const stats = getStats(groupCards, data);
        const today = session.dueCards.length + session.newCards.length;
        const daysLeft = group.examDate ? daysBetween(todayStr(), group.examDate) : null;

        const row = contentEl.createDiv("remnote-picker-row");

        // Left: info
        const info = row.createDiv("remnote-picker-info");
        info.createEl("div", { text: group.name, cls: "remnote-picker-name" });
        const meta = info.createDiv("remnote-picker-meta");

        if (daysLeft !== null) {
          const dayEl = meta.createEl("span", {
            text: daysLeft > 0 ? `📅 ${daysLeft} Tage` : daysLeft === 0 ? "📅 Heute!" : "⚠️ Vorbei",
            cls: daysLeft <= 3 ? "remnote-picker-urgent" : "remnote-picker-day",
          });
        }
        meta.createEl("span", { text: ` · ${today} heute`, cls: "remnote-picker-due" });
        meta.createEl("span", { text: ` · ${stats.unseen} neu`, cls: "remnote-picker-new" });
        meta.createEl("span", { text: ` · ${stats.total} gesamt`, cls: "remnote-picker-total" });

        // Right: button
        const startBtn = row.createEl("button", {
          text: today > 0 ? `Lernen (${today})` : "Alle gelernt ✓",
          cls: today > 0 ? "remnote-btn remnote-picker-btn" : "remnote-btn remnote-picker-btn-done",
        });
        startBtn.disabled = today === 0;
        startBtn.onclick = () => {
          this.close();
          const cards = getSessionCards(session);
          new ReviewModal(this.app, this.plugin, cards, data).open();
        };
      }
    }

    // === Ungrouped / all cards ===
    contentEl.createEl("h3", { text: "Weitere Optionen", cls: "remnote-picker-section" });

    // All cards
    {
      const ungroupedCards = groups.length > 0
        ? cardsWithoutGroup(this.allCards, data)
        : this.allCards;
      const sessionAll = buildDailySession(this.allCards, data);
      const todayAll = sessionAll.dueCards.length + sessionAll.newCards.length;

      const row = contentEl.createDiv("remnote-picker-row");
      const info = row.createDiv("remnote-picker-info");
      info.createEl("div", { text: "Alle Karten", cls: "remnote-picker-name" });
      info.createDiv("remnote-picker-meta").createEl("span", {
        text: `${todayAll} heute fällig · ${this.allCards.length} gesamt`,
        cls: "remnote-picker-total",
      });
      const btn = row.createEl("button", {
        text: todayAll > 0 ? `Lernen (${todayAll})` : "Alle gelernt ✓",
        cls: todayAll > 0 ? "remnote-btn remnote-picker-btn" : "remnote-btn remnote-picker-btn-done",
      });
      btn.disabled = todayAll === 0;
      btn.onclick = () => {
        this.close();
        new ReviewModal(this.app, this.plugin, getSessionCards(sessionAll), data).open();
      };
    }

    // Active note
    {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) {
        const noteCards = cardsForPath(this.allCards, activeFile.path);
        const stats = getStats(noteCards, data);

        const row = contentEl.createDiv("remnote-picker-row");
        const info = row.createDiv("remnote-picker-info");
        info.createEl("div", { text: `Aktive Notiz`, cls: "remnote-picker-name" });
        info.createDiv("remnote-picker-meta").createEl("span", {
          text: `${activeFile.basename} · ${stats.due} fällig · ${stats.total} gesamt`,
          cls: "remnote-picker-total",
        });
        const btn = row.createEl("button", {
          text: noteCards.length > 0 ? `Lernen (${noteCards.length})` : "Keine Karten",
          cls: "remnote-btn remnote-picker-btn",
        });
        btn.disabled = noteCards.length === 0;
        btn.onclick = () => {
          this.close();
          new ReviewModal(this.app, this.plugin, noteCards, data).open();
        };
      }
    }

    // Browse by file picker
    contentEl.createEl("h3", { text: "Notiz auswählen", cls: "remnote-picker-section" });
    this.renderFileBrowser(contentEl);
  }

  private renderFileBrowser(container: HTMLElement) {
    const data = this.plugin.pluginData;

    // Group cards by file
    const byFile = new Map<string, Flashcard[]>();
    for (const card of this.allCards) {
      if (!byFile.has(card.filePath)) byFile.set(card.filePath, []);
      byFile.get(card.filePath)!.push(card);
    }

    if (byFile.size === 0) {
      container.createEl("p", { text: "Keine Karteikarten im Vault gefunden.", cls: "remnote-picker-empty" });
      return;
    }

    const fileList = container.createDiv("remnote-file-list");

    // Sort by due count descending
    const sorted = [...byFile.entries()].sort(([, a], [, b]) => {
      const dueA = getStats(a, data).due;
      const dueB = getStats(b, data).due;
      return dueB - dueA;
    });

    for (const [filePath, cards] of sorted) {
      const stats = getStats(cards, data);
      const fileName = filePath.split("/").pop()?.replace(".md", "") ?? filePath;

      const row = fileList.createDiv("remnote-picker-row remnote-file-row");
      const info = row.createDiv("remnote-picker-info");
      info.createEl("div", { text: fileName, cls: "remnote-picker-name remnote-picker-name-sm" });
      const meta = info.createDiv("remnote-picker-meta");
      if (stats.due > 0) meta.createEl("span", { text: `${stats.due} fällig`, cls: "remnote-picker-due" });
      if (stats.unseen > 0) meta.createEl("span", { text: ` · ${stats.unseen} neu`, cls: "remnote-picker-new" });
      meta.createEl("span", { text: ` · ${stats.total} gesamt`, cls: "remnote-picker-total" });

      const btn = row.createEl("button", {
        text: "Lernen",
        cls: "remnote-btn remnote-picker-btn-sm",
      });
      btn.onclick = () => {
        this.close();
        new ReviewModal(this.app, this.plugin, cards, data).open();
      };
    }
  }
}
