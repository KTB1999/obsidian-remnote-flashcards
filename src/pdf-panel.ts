import {
  ItemView, WorkspaceLeaf, TFile, Notice,
  FuzzySuggestModal, App, MarkdownView, MarkdownRenderer
} from "obsidian";
import type RemNoteFlashcardsPlugin from "./main";

export const PDF_PANEL_VIEW_TYPE = "remnote-pdf-panel";

// ── PDF file picker ───────────────────────────────────────────────────────────
class PdfFileSuggest extends FuzzySuggestModal<TFile> {
  private onChoose: (file: TFile) => void;
  constructor(app: App, onChoose: (file: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("PDF aus Vault auswählen…");
  }
  getItems(): TFile[]          { return this.app.vault.getFiles().filter(f => f.extension === "pdf"); }
  getItemText(f: TFile): string { return f.path; }
  onChooseItem(f: TFile): void  { this.onChoose(f); }
}

// ── Main PDF panel ────────────────────────────────────────────────────────────
export class PdfPanelView extends ItemView {
  private plugin: RemNoteFlashcardsPlugin;

  private notePath:    string | null = null;
  private pdfPaths:    string[]      = [];
  private activeIdx    = 0;
  private currentPage  = 1;

  // DOM refs
  private tabBar:      HTMLElement | null = null;
  private pageInput:   HTMLInputElement | null = null;
  private statusEl:    HTMLElement | null = null;
  private pdfContainer: HTMLElement | null = null;  // Obsidian embed lives here
  private dropOverlay: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: RemNoteFlashcardsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType():    string { return PDF_PANEL_VIEW_TYPE; }
  getDisplayText(): string { return "PDF Panel"; }
  getIcon():        string { return "file-text"; }

  async onOpen() {
    this.buildShell();
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.syncToActiveNote()));
    this.registerEvent(this.app.workspace.on("file-open",          () => this.syncToActiveNote()));
    this.syncToActiveNote();
  }

  async onClose() { this.contentEl.empty(); }

  // ── Sync to whichever note is open ───────────────────────────────────────
  private syncToActiveNote() {
    const active = this.app.workspace.getActiveFile();
    if (!active || active.extension !== "md") return;
    if (active.path === this.notePath) return;
    this.notePath  = active.path;
    this.pdfPaths  = [...(this.plugin.pluginData.pdfLinks[this.notePath] ?? [])];
    this.activeIdx = 0;
    this.currentPage = 1;
    this.refreshTabs();
    this.renderPdf();
  }

  // ── Build the static DOM shell ────────────────────────────────────────────
  private buildShell() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("remnote-pdf-panel");

    // ── Toolbar ──────────────────────────────────────────────────────────
    const toolbar = contentEl.createDiv("remnote-pdf-toolbar");
    this.tabBar   = toolbar.createDiv("remnote-pdf-tabs");

    const btnRow  = toolbar.createDiv("remnote-pdf-btn-row");

    const addBtn  = btnRow.createEl("button", { cls: "remnote-pdf-btn", title: "PDF aus Vault hinzufügen" });
    addBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> PDF`;
    addBtn.onclick = () => this.addPdfFromVault();

    const delBtn  = btnRow.createEl("button", { cls: "remnote-pdf-btn remnote-pdf-btn-danger", title: "Dieses PDF entfernen" });
    delBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;
    delBtn.onclick = () => this.removeActivePdf();

    // ── Nav bar ───────────────────────────────────────────────────────────
    const navBar  = contentEl.createDiv("remnote-pdf-nav");

    const prevBtn = navBar.createEl("button", { cls: "remnote-pdf-nav-btn", title: "Vorherige Seite (Alt+←)" });
    prevBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>`;
    prevBtn.onclick = () => this.gotoPage(this.currentPage - 1);

    navBar.createEl("span", { text: "Seite", cls: "remnote-pdf-page-label" });

    this.pageInput = navBar.createEl("input", { type: "number", cls: "remnote-pdf-page-input", value: "1" });
    this.pageInput.min = "1";
    this.pageInput.onchange = () => {
      const v = parseInt(this.pageInput!.value);
      if (!isNaN(v) && v > 0) this.gotoPage(v);
    };
    this.pageInput.onkeydown = (e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); };

    const nextBtn = navBar.createEl("button", { cls: "remnote-pdf-nav-btn", title: "Nächste Seite (Alt+→)" });
    nextBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>`;
    nextBtn.onclick = () => this.gotoPage(this.currentPage + 1);

    navBar.createDiv("remnote-pdf-nav-spacer");

    const linkBtn = navBar.createEl("button", { cls: "remnote-pdf-btn remnote-pdf-btn-link", title: "[[pdf#page=N]] in Notiz einfügen" });
    linkBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> Seite verknüpfen`;
    linkBtn.onclick = () => this.insertPageRef();

    // Alt+Arrow shortcuts
    this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
      if (!this.isVisible()) return;
      if ((e.target as HTMLElement).closest("input,textarea")) return;
      if (e.altKey && e.key === "ArrowLeft")  { e.preventDefault(); this.gotoPage(this.currentPage - 1); }
      if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); this.gotoPage(this.currentPage + 1); }
    });

    // ── Main area ─────────────────────────────────────────────────────────
    const mainArea = contentEl.createDiv("remnote-pdf-main");

    // Empty / no-PDF status
    this.statusEl = mainArea.createDiv("remnote-pdf-status");

    // Where Obsidian's native PDF embed renders
    this.pdfContainer = mainArea.createDiv("remnote-pdf-container");

    // Drop overlay (shown while dragging)
    this.dropOverlay = mainArea.createDiv("remnote-pdf-drop-overlay");
    this.dropOverlay.innerHTML = `
      <div class="remnote-pdf-drop-icon">📥</div>
      <div class="remnote-pdf-drop-title">PDF hier ablegen</div>
      <div class="remnote-pdf-drop-sub">Wird in Vault importiert und verknüpft</div>
    `;

    this.attachDragDrop(mainArea);
    this.refreshTabs();
    this.renderPdf();
  }

  // ── Render PDF using Obsidian's native embed ──────────────────────────────
  private async renderPdf() {
    if (!this.pdfContainer || !this.statusEl) return;
    this.pdfContainer.empty();

    if (this.pdfPaths.length === 0) {
      this.pdfContainer.style.display = "none";
      this.statusEl.style.display     = "flex";
      this.statusEl.innerHTML = this.notePath
        ? `<div class="remnote-pdf-status-icon">📄</div>
           <div class="remnote-pdf-status-text">Kein PDF verknüpft</div>
           <div class="remnote-pdf-status-sub">PDF aus Windows Explorer hier reinziehen<br>oder "+ PDF" für ein PDF aus dem Vault</div>`
        : `<div class="remnote-pdf-status-icon">📝</div>
           <div class="remnote-pdf-status-text">Keine Notiz geöffnet</div>
           <div class="remnote-pdf-status-sub">Öffne eine Notiz um ihre PDFs anzuzeigen</div>`;
      return;
    }

    this.pdfContainer.style.display = "block";
    this.statusEl.style.display     = "none";

    const pdfPath = this.pdfPaths[this.activeIdx];
    const pdfFile = this.app.vault.getAbstractFileByPath(pdfPath);
    if (!(pdfFile instanceof TFile)) {
      new Notice(`PDF nicht im Vault gefunden: ${pdfPath}`);
      return;
    }

    if (this.pageInput) this.pageInput.value = String(this.currentPage);

    // Use Obsidian's MarkdownRenderer with embed syntax.
    // This invokes Obsidian's own PDF viewer — text is selectable and copyable.
    // Use full vault path so it resolves correctly regardless of note location.
    const embedSyntax = `![[${pdfPath}#page=${this.currentPage}]]`;

    await MarkdownRenderer.render(
      this.app,
      embedSyntax,
      this.pdfContainer,
      this.notePath ?? pdfPath,
      this.plugin
    );

    // After render: expand the embed to fill the panel height
    this.expandEmbedHeight();
  }

  /** Make the embedded PDF viewer fill the available panel height */
  private expandEmbedHeight() {
    if (!this.pdfContainer) return;

    // Obsidian wraps the PDF in .pdf-embed > .pdf-embed-container > iframe
    const applyHeight = () => {
      const embed = this.pdfContainer!.querySelector<HTMLElement>(".pdf-embed");
      if (embed) {
        embed.style.height    = "100%";
        embed.style.maxHeight = "none";
      }
      // The inner iframe Obsidian creates
      const inner = this.pdfContainer!.querySelector<HTMLElement>(
        ".pdf-embed iframe, .pdf-embed object, .pdf-embed embed"
      );
      if (inner) {
        (inner as HTMLElement).style.height    = "100%";
        (inner as HTMLElement).style.minHeight = "400px";
      }
    };

    // Apply immediately and again after a short delay (embed may render async)
    applyHeight();
    setTimeout(applyHeight, 150);
    setTimeout(applyHeight, 500);
  }

  // ── Navigation ────────────────────────────────────────────────────────────
  private gotoPage(page: number) {
    if (page < 1) return;
    this.currentPage = page;
    if (this.pageInput) this.pageInput.value = String(page);

    // Try navigating the already-rendered PDF embed without full re-render
    const navigated = this.tryNavigateInPlace(page);
    if (!navigated) this.renderPdf(); // fallback: re-render
  }

  /**
   * Attempt to jump to a page inside the already-rendered Obsidian PDF embed
   * without destroying and re-creating the whole embed (avoids flicker).
   * Returns true if navigation succeeded.
   */
  private tryNavigateInPlace(page: number): boolean {
    if (!this.pdfContainer) return false;

    // Obsidian's PDF embed uses an iframe internally
    const iframe = this.pdfContainer.querySelector<HTMLIFrameElement>(
      ".pdf-embed iframe"
    );
    if (!iframe) return false;

    try {
      const src = iframe.src || "";
      if (!src) return false;
      const base = src.split("#")[0];
      iframe.src = `${base}#page=${page}`;
      return true;
    } catch {
      return false;
    }
  }

  // ── Insert [[pdf#page=N]] into active note ────────────────────────────────
  insertPageRef() {
    if (this.pdfPaths.length === 0) { new Notice("Kein PDF aktiv."); return; }
    const pdfName = this.pdfPaths[this.activeIdx].split("/").pop() ?? "";
    const ref     = `[[${pdfName}#page=${this.currentPage}]]`;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.editor) {
      view.editor.replaceRange(ref, view.editor.getCursor());
      new Notice(`✓ Referenz eingefügt: ${ref}`, 2000);
    } else {
      navigator.clipboard.writeText(ref)
        .then(() => new Notice(`Referenz kopiert: ${ref}`, 3000));
    }
  }

  // ── Public: jump to a specific PDF + page (called from link click handler) ─
  async openPdfAtPage(pdfPath: string, page: number) {
    // Add to this note's PDF list if not already there
    if (!this.pdfPaths.includes(pdfPath)) {
      await this.linkPdf(pdfPath); // also calls refreshTabs + renderPdf
    }

    // Switch to the correct tab
    const idx = this.pdfPaths.indexOf(pdfPath);
    if (idx !== -1 && idx !== this.activeIdx) {
      this.activeIdx = idx;
      this.refreshTabs();
    }

    // Navigate to the page
    this.currentPage = page;
    if (this.pageInput) this.pageInput.value = String(page);

    const navigated = this.tryNavigateInPlace(page);
    if (!navigated) await this.renderPdf();
  }

  // ── Drag & Drop ───────────────────────────────────────────────────────────
  private attachDragDrop(target: HTMLElement) {
    let depth = 0;

    target.addEventListener("dragenter", (e) => {
      if (!this.hasPdfFiles(e.dataTransfer)) return;
      e.preventDefault(); depth++;
      if (depth === 1) this.showOverlay(true);
    });
    target.addEventListener("dragleave", () => {
      depth--; if (depth <= 0) { depth = 0; this.showOverlay(false); }
    });
    target.addEventListener("dragover", (e) => {
      if (!this.hasPdfFiles(e.dataTransfer)) return;
      e.preventDefault(); e.dataTransfer!.dropEffect = "copy";
    });
    target.addEventListener("drop", async (e) => {
      e.preventDefault(); depth = 0; this.showOverlay(false);
      const files = e.dataTransfer?.files;
      if (!files) return;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (f.name.toLowerCase().endsWith(".pdf") || f.type === "application/pdf")
          await this.importDroppedPdf(f);
      }
    });
  }

  private hasPdfFiles(dt: DataTransfer | null): boolean {
    return !!dt && Array.from(dt.types).includes("Files");
  }

  private showOverlay(show: boolean) {
    if (this.dropOverlay) this.dropOverlay.style.display = show ? "flex" : "none";
  }

  // ── Import PDF dropped from OS ────────────────────────────────────────────
  private async importDroppedPdf(file: File) {
    if (!this.notePath) { new Notice("Keine Notiz geöffnet."); return; }

    const fileName    = file.name;
    const folder      = (this.plugin.pluginData.settings.pdfAttachmentFolder || "Attachments/PDFs").replace(/\/$/, "");
    const destPath    = `${folder}/${fileName}`;
    const vaultBase   = ((this.app.vault.adapter as any).basePath ?? "").replace(/\\/g, "/");
    const electronPath = ((file as any).path ?? "").replace(/\\/g, "/");

    // Already inside the vault?
    if (vaultBase && electronPath.startsWith(vaultBase)) {
      const rel = electronPath.slice(vaultBase.length).replace(/^\//, "");
      await this.linkPdf(rel);
      new Notice(`"${fileName}" ist bereits im Vault — verknüpft`, 2000);
      return;
    }

    // Same name already at destination?
    if (await this.app.vault.adapter.exists(destPath)) {
      await this.linkPdf(destPath);
      new Notice(`"${fileName}" existiert bereits im Vault — verknüpft`, 2000);
      return;
    }

    if (!await this.app.vault.adapter.exists(folder))
      await this.app.vault.createFolder(folder);

    const notice = new Notice(`Importiere "${fileName}"…`, 0);
    try {
      await this.app.vault.adapter.writeBinary(destPath, await file.arrayBuffer());
      notice.hide();
      await this.linkPdf(destPath);
      new Notice(`✓ "${fileName}" → ${destPath}`, 4000);
    } catch (err: any) {
      notice.hide();
      new Notice(`Import fehlgeschlagen: ${err.message ?? err}`, 5000);
    }
  }

  // ── Link a vault PDF to the current note ─────────────────────────────────
  private async linkPdf(vaultPath: string) {
    if (!this.notePath) return;
    if (this.pdfPaths.includes(vaultPath)) {
      const idx = this.pdfPaths.indexOf(vaultPath);
      this.activeIdx = idx; this.currentPage = 1;
      this.refreshTabs(); this.renderPdf(); return;
    }
    this.pdfPaths.push(vaultPath);
    this.plugin.pluginData.pdfLinks[this.notePath] = [...this.pdfPaths];
    await this.plugin.savePluginData();
    this.activeIdx = this.pdfPaths.length - 1; this.currentPage = 1;
    this.refreshTabs(); this.renderPdf();
  }

  // ── Tab bar ───────────────────────────────────────────────────────────────
  private refreshTabs() {
    if (!this.tabBar) return;
    this.tabBar.empty();
    if (this.pdfPaths.length === 0) {
      this.tabBar.createEl("span", {
        text: this.notePath ? "Kein PDF — PDF reinziehen oder + klicken" : "Keine Notiz geöffnet",
        cls: "remnote-pdf-no-pdf",
      });
      return;
    }
    for (let i = 0; i < this.pdfPaths.length; i++) {
      const name = this.pdfPaths[i].split("/").pop()?.replace(/\.pdf$/i, "") ?? "";
      const tab  = this.tabBar.createEl("button", {
        cls:   "remnote-pdf-tab" + (i === this.activeIdx ? " active" : ""),
        title: this.pdfPaths[i],
      });
      tab.setText(name);
      tab.onclick = () => { this.activeIdx = i; this.currentPage = 1; this.refreshTabs(); this.renderPdf(); };
    }
  }

  // ── Manage linked PDFs ────────────────────────────────────────────────────
  private addPdfFromVault() {
    if (!this.notePath) { new Notice("Keine Notiz geöffnet."); return; }
    new PdfFileSuggest(this.app, (f) => this.linkPdf(f.path)).open();
  }

  private async removeActivePdf() {
    if (this.pdfPaths.length === 0) return;
    const removed = this.pdfPaths[this.activeIdx].split("/").pop();
    this.pdfPaths.splice(this.activeIdx, 1);
    if (this.notePath) {
      if (this.pdfPaths.length === 0) delete this.plugin.pluginData.pdfLinks[this.notePath];
      else this.plugin.pluginData.pdfLinks[this.notePath] = [...this.pdfPaths];
      await this.plugin.savePluginData();
    }
    this.activeIdx = Math.max(0, this.activeIdx - 1);
    this.currentPage = 1;
    this.refreshTabs(); this.renderPdf();
    new Notice(`"${removed}" entfernt`, 2000);
  }

  private isVisible(): boolean { return this.leaf.view === this; }
}
