import { App, Modal, TFile, Notice } from "obsidian";
import { Flashcard } from "./types";
import { getStats, buildDailySession, getSessionCards, cardsForGroup, cardsForPath, cardsForFolder, cardsWithoutGroup } from "./scheduler";
import { ReviewModal } from "./modal";
import { daysBetween, todayStr } from "./sm2";
import type RemNoteFlashcardsPlugin from "./main";

export class SessionPickerModal extends Modal {
  private plugin: RemNoteFlashcardsPlugin;
  private allCards: Flashcard[];
  private shuffled = false;

  constructor(app: App, plugin: RemNoteFlashcardsPlugin, allCards: Flashcard[]) {
    super(app);
    this.plugin   = plugin;
    this.allCards = allCards;
  }

  onOpen()  { this.modalEl.addClass("remnote-picker-modal"); this.render(); }
  onClose() { this.contentEl.empty(); }

  private launch(cards: Flashcard[], filterId: string, filterLabel: string) {
    this.close();
    new ReviewModal(this.app, this.plugin, cards, this.plugin.pluginData, {
      shuffle:     this.shuffled,
      filterId,
      filterLabel,
    }).open();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();

    const data   = this.plugin.pluginData;
    const groups = data.settings.examGroups;

    // ── Header row: title + shuffle toggle ──────────────────────────────────
    const header = contentEl.createDiv("remnote-picker-header");
    header.createEl("h2", { text: "Lernsitzung starten", cls: "remnote-picker-title" });

    const shuffleBtn = header.createEl("button", {
      cls:   "remnote-picker-shuffle" + (this.shuffled ? " active" : ""),
      title: "Reihenfolge zufällig mischen",
    });
    shuffleBtn.innerHTML = `🔀 Zufällig`;
    shuffleBtn.onclick = () => {
      this.shuffled = !this.shuffled;
      shuffleBtn.toggleClass("active", this.shuffled);
    };

    // ── Resume last session ──────────────────────────────────────────────────
    const saved = data.lastSession;
    if (saved && saved.currentIndex < saved.cardIds.length) {
      const remaining = saved.cardIds.length - saved.currentIndex;
      contentEl.createEl("h3", { text: "Weitermachen", cls: "remnote-picker-section" });

      const row = contentEl.createDiv("remnote-picker-row remnote-resume-row");
      const info = row.createDiv("remnote-picker-info");
      info.createEl("div", { text: `🔄 ${saved.filterLabel || "Letzte Sitzung"}`, cls: "remnote-picker-name" });
      info.createDiv("remnote-picker-meta").createEl("span", {
        text: `${remaining} Karte${remaining !== 1 ? "n" : ""} übrig · Karte ${saved.currentIndex + 1} / ${saved.cardIds.length}`,
        cls:  "remnote-picker-due",
      });

      const resumeBtn = row.createEl("button", { text: `Weitermachen (${remaining})`, cls: "remnote-btn remnote-picker-btn" });
      resumeBtn.onclick = () => {
        // Reconstruct the card list in saved order from currentIndex
        const idMap = new Map(this.allCards.map(c => [c.id, c]));
        const resumeCards = saved.cardIds
          .slice(saved.currentIndex)
          .map(id => idMap.get(id))
          .filter((c): c is Flashcard => c !== undefined);

        if (resumeCards.length === 0) {
          new Notice("Keine Karten mehr gefunden — Session neu starten.");
          data.lastSession = null;
          this.plugin.savePluginData();
          this.render();
          return;
        }

        this.close();
        new ReviewModal(this.app, this.plugin, resumeCards, data, {
          shuffle:     false, // preserve original order when resuming
          filterId:    saved.filterId,
          filterLabel: saved.filterLabel,
        }).open();
      };
    }

    // ── Exam groups ──────────────────────────────────────────────────────────
    if (groups.length > 0) {
      contentEl.createEl("h3", { text: "Prüfungen", cls: "remnote-picker-section" });

      for (const group of groups) {
        const groupCards = cardsForGroup(this.allCards, group);
        const session    = buildDailySession(groupCards, data, group.examDate, group.name);
        const stats      = getStats(groupCards, data);
        const today      = session.dueCards.length + session.newCards.length;
        const daysLeft   = group.examDate ? daysBetween(todayStr(), group.examDate) : null;

        const row = contentEl.createDiv("remnote-picker-row");
        const info = row.createDiv("remnote-picker-info");
        info.createEl("div", { text: group.name, cls: "remnote-picker-name" });
        const meta = info.createDiv("remnote-picker-meta");
        if (daysLeft !== null)
          meta.createEl("span", {
            text: daysLeft > 0 ? `📅 ${daysLeft} Tage` : daysLeft === 0 ? "📅 Heute!" : "⚠️ Vorbei",
            cls:  daysLeft <= 3 ? "remnote-picker-urgent" : "remnote-picker-day",
          });
        meta.createEl("span", { text: ` · ${today} heute`,     cls: "remnote-picker-due" });
        meta.createEl("span", { text: ` · ${stats.unseen} neu`, cls: "remnote-picker-new" });
        meta.createEl("span", { text: ` · ${stats.total} gesamt`, cls: "remnote-picker-total" });

        const startBtn = row.createEl("button", {
          text: today > 0 ? `Lernen (${today})` : "Alle gelernt ✓",
          cls:  today > 0 ? "remnote-btn remnote-picker-btn" : "remnote-btn remnote-picker-btn-done",
        });
        startBtn.disabled = today === 0;
        startBtn.onclick  = () => this.launch(getSessionCards(session), `group:${group.id}`, group.name);
      }
    }

    // ── Quick options ────────────────────────────────────────────────────────
    contentEl.createEl("h3", { text: "Weitere Optionen", cls: "remnote-picker-section" });

    // All cards
    {
      const sessionAll = buildDailySession(this.allCards, data);
      const todayAll   = sessionAll.dueCards.length + sessionAll.newCards.length;
      const row  = contentEl.createDiv("remnote-picker-row");
      const info = row.createDiv("remnote-picker-info");
      info.createEl("div", { text: "Alle Karten", cls: "remnote-picker-name" });
      info.createDiv("remnote-picker-meta").createEl("span", {
        text: `${todayAll} heute fällig · ${this.allCards.length} gesamt`,
        cls:  "remnote-picker-total",
      });
      const btn = row.createEl("button", {
        text: todayAll > 0 ? `Lernen (${todayAll})` : "Alle gelernt ✓",
        cls:  todayAll > 0 ? "remnote-btn remnote-picker-btn" : "remnote-btn remnote-picker-btn-done",
      });
      btn.disabled = todayAll === 0;
      btn.onclick  = () => this.launch(getSessionCards(sessionAll), "all", "Alle Karten");
    }

    // Active note
    {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) {
        const noteCards = cardsForPath(this.allCards, activeFile.path);
        const stats     = getStats(noteCards, data);
        const row  = contentEl.createDiv("remnote-picker-row");
        const info = row.createDiv("remnote-picker-info");
        info.createEl("div", { text: "Aktive Notiz", cls: "remnote-picker-name" });
        info.createDiv("remnote-picker-meta").createEl("span", {
          text: `${activeFile.basename} · ${stats.due} fällig · ${stats.total} gesamt`,
          cls:  "remnote-picker-total",
        });
        const btn = row.createEl("button", {
          text: noteCards.length > 0 ? `Lernen (${noteCards.length})` : "Keine Karten",
          cls:  "remnote-btn remnote-picker-btn",
        });
        btn.disabled = noteCards.length === 0;
        btn.onclick  = () => this.launch(noteCards, `file:${activeFile.path}`, activeFile.basename);
      }
    }

    // ── Folder & note browser ────────────────────────────────────────────────
    contentEl.createEl("h3", { text: "Nach Ordner / Notiz", cls: "remnote-picker-section" });
    this.renderFolderBrowser(contentEl);
  }

  private renderFolderBrowser(container: HTMLElement) {
    const data = this.plugin.pluginData;

    // Build folder → { files → cards } map
    const byFolder = new Map<string, Map<string, Flashcard[]>>();
    for (const card of this.allCards) {
      const lastSlash = card.filePath.lastIndexOf("/");
      const folder    = lastSlash !== -1 ? card.filePath.slice(0, lastSlash) : "(root)";
      if (!byFolder.has(folder)) byFolder.set(folder, new Map());
      const folderMap = byFolder.get(folder)!;
      if (!folderMap.has(card.filePath)) folderMap.set(card.filePath, []);
      folderMap.get(card.filePath)!.push(card);
    }

    if (byFolder.size === 0) {
      container.createEl("p", { text: "Keine Karteikarten im Vault gefunden.", cls: "remnote-picker-empty" });
      return;
    }

    // Sort folders: most due first
    const sortedFolders = [...byFolder.entries()].sort(([, aMap], [, bMap]) => {
      const dueA = getStats([...aMap.values()].flat(), data).due;
      const dueB = getStats([...bMap.values()].flat(), data).due;
      return dueB - dueA;
    });

    for (const [folder, fileMap] of sortedFolders) {
      const folderCards = [...fileMap.values()].flat();
      const folderStats = getStats(folderCards, data);
      const folderName  = folder === "(root)" ? "Vault-Wurzel" : folder.split("/").pop() ?? folder;

      // ── Folder row ────────────────────────────────────────────────────────
      const folderRow  = container.createDiv("remnote-folder-row");
      const folderLeft = folderRow.createDiv("remnote-folder-left");

      const toggleEl = folderLeft.createSpan({ text: "▶", cls: "remnote-folder-toggle" });
      const folderInfo = folderLeft.createDiv("remnote-folder-info");
      folderInfo.createEl("span", { text: `📁 ${folderName}`, cls: "remnote-folder-name" });
      const folderMeta = folderInfo.createEl("span", { cls: "remnote-folder-meta" });
      if (folderStats.due > 0)    folderMeta.createSpan({ text: ` ${folderStats.due} fällig`, cls: "remnote-picker-due" });
      if (folderStats.unseen > 0) folderMeta.createSpan({ text: ` · ${folderStats.unseen} neu`, cls: "remnote-picker-new" });
      folderMeta.createSpan({ text: ` · ${folderStats.total} gesamt`, cls: "remnote-picker-total" });

      const folderBtn = folderRow.createEl("button", {
        text: `📁 Ordner lernen (${folderCards.length})`,
        cls:  "remnote-btn remnote-picker-btn-sm",
      });
      folderBtn.onclick = () => this.launch(folderCards, `folder:${folder}`, folderName);

      // ── Collapsible file list ─────────────────────────────────────────────
      const fileList = container.createDiv("remnote-folder-files");
      fileList.style.display = "none";

      // Sort files: most due first
      const sortedFiles = [...fileMap.entries()].sort(([, a], [, b]) =>
        getStats(b, data).due - getStats(a, data).due
      );

      for (const [filePath, cards] of sortedFiles) {
        const stats    = getStats(cards, data);
        const fileName = filePath.split("/").pop()?.replace(".md", "") ?? filePath;

        const row  = fileList.createDiv("remnote-picker-row remnote-file-row");
        const info = row.createDiv("remnote-picker-info");
        info.createEl("div", { text: fileName, cls: "remnote-picker-name remnote-picker-name-sm" });
        const meta = info.createDiv("remnote-picker-meta");
        if (stats.due > 0)    meta.createEl("span", { text: `${stats.due} fällig`,   cls: "remnote-picker-due" });
        if (stats.unseen > 0) meta.createEl("span", { text: ` · ${stats.unseen} neu`, cls: "remnote-picker-new" });
        meta.createEl("span", { text: ` · ${stats.total} gesamt`, cls: "remnote-picker-total" });

        const btn = row.createEl("button", { text: "Lernen", cls: "remnote-btn remnote-picker-btn-sm" });
        btn.onclick = () => this.launch(cards, `file:${filePath}`, fileName);
      }

      // Toggle collapse
      const toggleCollapse = () => {
        const open = fileList.style.display !== "none";
        fileList.style.display = open ? "none" : "block";
        toggleEl.setText(open ? "▶" : "▼");
      };
      folderLeft.onclick = toggleCollapse;
    }
  }
}
