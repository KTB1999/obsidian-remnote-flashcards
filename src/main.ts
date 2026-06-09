import { Plugin, TFile, Notice, Editor, MarkdownView } from "obsidian";
import { PluginData, DEFAULT_SETTINGS, Flashcard, cardBelongsToGroup } from "./types";
import { parseFlashcards } from "./parser";
import { getStats, buildDailySession, getTotalDueCount } from "./scheduler";
import { ReviewModal } from "./modal";
import { SessionPickerModal } from "./session-picker";
import { BrowseModal } from "./browse-modal";
import { RemNoteSettingsTab } from "./settings";
import { todayStr } from "./sm2";
import { aiGenerateAnswer } from "./ai";
import { PdfPanelView, PDF_PANEL_VIEW_TYPE } from "./pdf-panel";

export default class RemNoteFlashcardsPlugin extends Plugin {
  pluginData: PluginData = {
    settings: { ...DEFAULT_SETTINGS },
    reviews: {},
    lastReminderDate: "",
    pdfLinks: {},
  };

  allCards: Flashcard[] = [];
  private ribbonBadgeEl: HTMLElement | null = null;

  async onload() {
    await this.loadPluginData();

    // Register PDF panel view
    this.registerView(PDF_PANEL_VIEW_TYPE, (leaf) => new PdfPanelView(leaf, this));

    // Ribbon icon — flashcards
    const ribbonIcon = this.addRibbonIcon("layers", "RemNote Flashcards", async () => {
      await this.openSessionPicker();
    });
    this.ribbonBadgeEl = ribbonIcon.createSpan("remnote-ribbon-badge");

    // Ribbon icon — PDF panel
    this.addRibbonIcon("file-text", "PDF Panel öffnen", () => this.openPdfPanel());

    // ── Commands ──────────────────────────────────────────────
    this.addCommand({
      id: "open-session-picker",
      name: "Lernsitzung starten",
      callback: () => this.openSessionPicker(),
    });

    this.addCommand({
      id: "review-current-note",
      name: "Aktive Notiz lernen",
      callback: () => this.reviewCurrentNote(),
    });

    this.addCommand({
      id: "show-stats",
      name: "Statistiken anzeigen",
      callback: () => this.showStats(),
    });

    this.addCommand({
      id: "browse-cards",
      name: "Karteikarten durchsuchen",
      callback: () => this.browseCards(),
    });

    this.addCommand({
      id: "open-pdf-panel",
      name: "PDF Panel öffnen",
      callback: () => this.openPdfPanel(),
    });

    this.addCommand({
      id: "pdf-insert-page-ref",
      name: "PDF: Seitenreferenz in Notiz einfügen",
      callback: () => this.pdfInsertRef(),
    });

    // AI autofill: generates answer for "Frage :: " on the current line
    this.addCommand({
      id: "ai-autofill-card",
      name: "AI: Antwort für Karte auf dieser Zeile generieren",
      editorCallback: async (editor: Editor) => {
        await this.aiAutofillCard(editor);
      },
    });

    this.addSettingTab(new RemNoteSettingsTab(this.app, this));

    // ── Intercept [[file.pdf#page=N]] clicks → open PDF Panel at that page ──
    this.registerMarkdownPostProcessor((el) => {
      el.querySelectorAll<HTMLElement>("a.internal-link").forEach((linkEl) => {
        const href = linkEl.getAttribute("data-href") ?? linkEl.getAttribute("href") ?? "";
        // Only handle links that point to a .pdf file
        if (!href.match(/\.pdf(#|$)/i)) return;

        // Parse filename and page number out of the href
        const hashIdx  = href.lastIndexOf("#");
        const pdfRef   = hashIdx !== -1 ? href.slice(0, hashIdx) : href;
        const fragment = hashIdx !== -1 ? href.slice(hashIdx + 1) : "";
        const pageNum  = parseInt(fragment.replace(/^page=/i, "")) || 1;

        linkEl.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();

          // Find the PDF anywhere in the vault (by full path, name, or basename)
          const pdfFile = this.app.vault.getFiles().find(
            (f) => f.name === pdfRef || f.path === pdfRef || f.basename === pdfRef
          );
          if (!pdfFile) {
            new Notice(`PDF nicht gefunden: ${pdfRef}`);
            return;
          }

          // Open panel (no-op if already open)
          await this.openPdfPanel();
          // Brief delay so the panel view finishes mounting on first open
          await new Promise<void>((r) => setTimeout(r, 80));

          const leaves = this.app.workspace.getLeavesOfType(PDF_PANEL_VIEW_TYPE);
          if (leaves.length === 0) return;
          const view = leaves[0].view as PdfPanelView;
          await view.openPdfAtPage(pdfFile.path, pageNum);
        });
      });
    });

    // Scan vault after layout is ready
    this.app.workspace.onLayoutReady(async () => {
      await this.scanVault();
      this.updateBadge();
      this.checkDailyReminder();
    });

    // Re-scan on file changes
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (file instanceof TFile && file.extension === "md") {
          await this.scanFile(file);
          this.updateBadge();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("create", async (file) => {
        if (file instanceof TFile && file.extension === "md") {
          await this.scanFile(file);
          this.updateBadge();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          this.allCards = this.allCards.filter((c) => c.filePath !== file.path);
          this.updateBadge();
        }
      })
    );
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(PDF_PANEL_VIEW_TYPE);
  }

  // ── Data persistence ───────────────────────────────────────
  async loadPluginData() {
    const raw = await this.loadData();
    if (raw) {
      this.pluginData = {
        settings: { ...DEFAULT_SETTINGS, ...raw.settings },
        reviews: raw.reviews ?? {},
        lastReminderDate: raw.lastReminderDate ?? "",
        pdfLinks: raw.pdfLinks ?? {},
      };
      // Migrate old single examDate field
      const s = this.pluginData.settings as any;
      if (s.examDate && this.pluginData.settings.examGroups.length === 0) {
        this.pluginData.settings.examGroups = [{
          id: "migrated",
          name: "Prüfung",
          examDate: s.examDate,
          paths: [],
        }];
        delete s.examDate;
        await this.savePluginData();
      }
    }
  }

  async savePluginData() {
    await this.saveData(this.pluginData);
  }

  // ── Vault scanning ─────────────────────────────────────────
  async scanVault() {
    this.allCards = [];
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      await this.scanFile(file, false);
    }
  }

  private async scanFile(file: TFile, merge = true) {
    const content = await this.app.vault.read(file);
    const cards = parseFlashcards(content, file.path);
    if (merge) {
      this.allCards = this.allCards.filter((c) => c.filePath !== file.path);
      this.allCards.push(...cards);
    } else {
      this.allCards.push(...cards);
    }
  }

  // ── Badge ──────────────────────────────────────────────────
  private updateBadge() {
    if (!this.ribbonBadgeEl) return;
    const due = getTotalDueCount(this.allCards, this.pluginData);
    if (due > 0) {
      this.ribbonBadgeEl.setText(due > 99 ? "99+" : String(due));
      this.ribbonBadgeEl.style.display = "flex";
    } else {
      this.ribbonBadgeEl.style.display = "none";
    }
  }

  // ── Daily reminder ─────────────────────────────────────────
  private checkDailyReminder() {
    if (!this.pluginData.settings.dailyReminderEnabled) return;
    const today = todayStr();
    if (this.pluginData.lastReminderDate === today) return;

    const due = getTotalDueCount(this.allCards, this.pluginData);
    if (due > 0) {
      // Find the most urgent exam
      const groups = this.pluginData.settings.examGroups;
      let urgentMsg = "";
      if (groups.length > 0) {
        const sorted = groups
          .filter((g) => g.examDate)
          .sort((a, b) => a.examDate.localeCompare(b.examDate));
        if (sorted.length > 0) {
          const next = sorted[0];
          const days = Math.max(0, Math.round(
            (new Date(next.examDate).getTime() - Date.now()) / 86400000
          ));
          urgentMsg = ` — ${next.name} in ${days} Tagen`;
        }
      }
      new Notice(
        `📚 RemNote Flashcards: ${due} Karten heute fällig${urgentMsg}.\nKlicke auf das Karten-Icon in der Sidebar.`,
        8000
      );
    }

    this.pluginData.lastReminderDate = today;
    this.savePluginData();
  }

  // ── Session actions ────────────────────────────────────────
  async openSessionPicker() {
    await this.scanVault();
    new SessionPickerModal(this.app, this, this.allCards).open();
  }

  async reviewCurrentNote() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("Keine aktive Notiz geöffnet.");
      return;
    }
    await this.scanFile(activeFile);
    const cards = this.allCards.filter((c) => c.filePath === activeFile.path);
    if (cards.length === 0) {
      new Notice("Keine Karteikarten in dieser Notiz.\nVerwende :: oder ::: zum Erstellen.");
      return;
    }
    new ReviewModal(this.app, this, cards, this.pluginData).open();
  }

  async showStats() {
    await this.scanVault();
    const stats = getStats(this.allCards, this.pluginData);
    const groups = this.pluginData.settings.examGroups;

    let groupLines = "";
    if (groups.length > 0) {
      for (const g of groups) {
        const { due, total } = getStats(
          this.allCards.filter((c) => cardBelongsToGroup(c, g)),
          this.pluginData
        );
        groupLines += `\n  ${g.name}: ${due} fällig / ${total} gesamt`;
      }
    }

    new Notice(
      `📊 RemNote Flashcards\n\n` +
      `Gesamt: ${stats.total} Karten\n` +
      `✅ Gelernt: ${stats.learned}\n` +
      `🔴 Fällig: ${stats.due}\n` +
      `🆕 Neu: ${stats.unseen}` +
      (groupLines ? `\n\nNach Prüfung:${groupLines}` : ""),
      12000
    );
  }

  async browseCards() {
    await this.scanVault();
    new BrowseModal(this.app, this, this.allCards, this.pluginData).open();
  }

  // ── PDF Panel ──────────────────────────────────────────────
  async openPdfPanel() {
    // Reuse existing panel leaf if already open, otherwise open in right split
    const existing = this.app.workspace.getLeavesOfType(PDF_PANEL_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: PDF_PANEL_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  pdfInsertRef() {
    // Delegate to the open panel view if it exists
    const leaves = this.app.workspace.getLeavesOfType(PDF_PANEL_VIEW_TYPE);
    if (leaves.length === 0) {
      new Notice("PDF Panel ist nicht geöffnet. Öffne es zuerst mit 'PDF Panel öffnen'.");
      return;
    }
    const view = leaves[0].view as PdfPanelView;
    (view as any).insertPageRef();
  }

  // ── AI Autofill (while writing) ────────────────────────────
  async aiAutofillCard(editor: Editor) {
    if (!this.pluginData.settings.aiEnabled) {
      new Notice("AI ist nicht aktiviert. Bitte in Einstellungen → AI aktivieren.");
      return;
    }

    const cursor = editor.getCursor();
    const lineText = editor.getLine(cursor.line);

    // Detect ::: or :: separator, and check if answer is already filled
    let front = "";
    let insertPos = lineText.length;

    // Try ::: first
    const tripleIdx = lineText.indexOf(":::");
    if (tripleIdx !== -1) {
      const after = lineText.slice(tripleIdx + 3).trim();
      if (after !== "") {
        new Notice("Diese Zeile hat bereits eine Antwort.");
        return;
      }
      front = lineText.slice(0, tripleIdx).trim();
      insertPos = lineText.length;
    } else {
      // Try ::
      const basicIdx = lineText.indexOf("::");
      if (basicIdx !== -1) {
        const after = lineText.slice(basicIdx + 2).trim();
        if (after !== "") {
          new Notice("Diese Zeile hat bereits eine Antwort.");
          return;
        }
        front = lineText.slice(0, basicIdx).trim();
        insertPos = lineText.length;
      }
    }

    if (!front) {
      new Notice("Kein :: oder ::: auf dieser Zeile gefunden.\nBeispiel: Frage :: ");
      return;
    }

    const notice = new Notice("✦ AI generiert Antwort...", 0);
    try {
      const answer = await aiGenerateAnswer(front, "", this.pluginData.settings);
      notice.hide();
      if (!answer) {
        new Notice("AI hat keine Antwort zurückgegeben.");
        return;
      }
      // Insert answer after the separator (with a space)
      editor.replaceRange(
        " " + answer,
        { line: cursor.line, ch: insertPos },
        { line: cursor.line, ch: insertPos }
      );
      new Notice("✓ Antwort eingefügt", 2000);
    } catch (e) {
      notice.hide();
      new Notice("AI Fehler: " + e.message);
    }
  }
}
