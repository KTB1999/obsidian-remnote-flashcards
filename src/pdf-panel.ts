import {
  ItemView, WorkspaceLeaf, TFile, Notice,
  Modal, App, MarkdownView
} from "obsidian";
import type RemNoteFlashcardsPlugin from "./main";

export const PDF_PANEL_VIEW_TYPE = "remnote-pdf-panel";

// ── PDF multi-select modal ────────────────────────────────────────────────────
class PdfMultiSelectModal extends Modal {
  private onConfirm: (vaultFiles: TFile[], deviceFiles: File[]) => void;
  private selected  = new Set<string>();
  private pendingDeviceFiles: File[] = [];

  constructor(app: App, onConfirm: (vaultFiles: TFile[], deviceFiles: File[]) => void) {
    super(app);
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("remnote-pdf-multiselect-modal");
    contentEl.createEl("h3", { text: "PDFs hinzufügen", cls: "remnote-pdf-modal-title" });

    const searchInput = contentEl.createEl("input", {
      type: "text",
      cls:  "remnote-pdf-modal-search",
      placeholder: "Vault-PDFs suchen…",
    });

    const allPdfs = this.app.vault.getFiles().filter(f => f.extension === "pdf");
    const listEl  = contentEl.createDiv("remnote-pdf-modal-list");

    const renderList = (query: string) => {
      listEl.empty();
      const q        = query.toLowerCase();
      const filtered = q ? allPdfs.filter(f => f.path.toLowerCase().includes(q)) : allPdfs;

      if (filtered.length === 0) {
        listEl.createEl("p", { text: "Keine PDFs im Vault gefunden.", cls: "remnote-pdf-modal-empty" });
        return;
      }

      for (const pdf of filtered) {
        const row      = listEl.createDiv("remnote-pdf-modal-row");
        const checkbox = row.createEl("input", { type: "checkbox" });
        checkbox.checked = this.selected.has(pdf.path);

        const name = row.createEl("span", { cls: "remnote-pdf-modal-row-name" });
        name.createEl("span", { text: pdf.name.replace(/\.pdf$/i, ""), cls: "remnote-pdf-modal-fname" });
        name.createEl("span", { text: pdf.parent?.path ?? "", cls: "remnote-pdf-modal-fpath" });

        const toggle = () => {
          checkbox.checked ? this.selected.add(pdf.path) : this.selected.delete(pdf.path);
          row.toggleClass("selected", checkbox.checked);
        };
        checkbox.onchange = toggle;
        row.onclick = (e) => {
          if ((e.target as HTMLElement).tagName === "INPUT") return;
          checkbox.checked = !checkbox.checked;
          toggle();
        };
        row.toggleClass("selected", checkbox.checked);
      }
    };

    searchInput.oninput = () => renderList(searchInput.value);
    renderList("");

    const uploadSection = contentEl.createDiv("remnote-pdf-modal-upload");
    const uploadBtn = uploadSection.createEl("button", {
      text: "📁 Vom Gerät hochladen",
      cls:  "remnote-btn",
    });
    const uploadLabel = uploadSection.createEl("span", {
      cls:  "remnote-pdf-modal-upload-label",
      text: "",
    });

    uploadBtn.onclick = () => {
      const input    = document.createElement("input");
      input.type     = "file";
      input.accept   = ".pdf,application/pdf";
      input.multiple = true;
      input.onchange = () => {
        if (!input.files) return;
        for (let i = 0; i < input.files.length; i++) this.pendingDeviceFiles.push(input.files[i]);
        uploadLabel.textContent = this.pendingDeviceFiles.length + " Datei(en) ausgewählt";
      };
      input.click();
    };

    const btnRow     = contentEl.createDiv("remnote-pdf-modal-actions");
    const confirmBtn = btnRow.createEl("button", { text: "Hinzufügen", cls: "remnote-btn remnote-btn-cta" });
    const cancelBtn  = btnRow.createEl("button", { text: "Abbrechen",  cls: "remnote-btn" });

    confirmBtn.onclick = () => {
      const chosen = allPdfs.filter(f => this.selected.has(f.path));
      this.onConfirm(chosen, this.pendingDeviceFiles);
      this.close();
    };
    cancelBtn.onclick = () => this.close();
  }

  onClose() { this.contentEl.empty(); }
}

// ── Main PDF panel ────────────────────────────────────────────────────────────
export class PdfPanelView extends ItemView {
  private plugin: RemNoteFlashcardsPlugin;

  private notePath:    string | null = null;
  private pdfPaths:    string[]      = [];
  private activeIdx    = 0;
  private currentPage  = 1;
  private saveTimer:   ReturnType<typeof setTimeout> | null = null;
  private renderRetry  = 0;

  // DOM refs
  private tabBar:       HTMLElement | null = null;
  private pdfNameEl:    HTMLElement | null = null;
  private pageInput:    HTMLInputElement | null = null;
  private statusEl:     HTMLElement | null = null;
  private pdfContainer: HTMLElement | null = null;
  private dropOverlay:  HTMLElement | null = null;
  private pdfIframe:    HTMLIFrameElement | null = null;

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

  async onClose() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.contentEl.empty();
  }

  // ── Robust 4-level file resolver ──────────────────────────────────────────
  private resolveFile(vaultPath: string): TFile | null {
    const all = this.app.vault.getFiles();

    // 1. Exact path
    const exact = all.find(f => f.path === vaultPath);
    if (exact) return exact;

    // 2. Case-insensitive path (Windows / macOS HFS+)
    const lower = vaultPath.toLowerCase();
    const byCI  = all.find(f => f.path.toLowerCase() === lower);
    if (byCI) { this.healPath(vaultPath, byCI.path); return byCI; }

    // 3. Filename-only match — handles re-uploads and folder moves
    const filename = vaultPath.split("/").pop() ?? "";
    if (!filename) return null;
    const byName = all.find(f => f.name === filename);
    if (byName) { this.healPath(vaultPath, byName.path); return byName; }

    // 4. Case-insensitive filename match
    const filenameLower = filename.toLowerCase();
    const byNameCI = all.find(f => f.name.toLowerCase() === filenameLower);
    if (byNameCI) { this.healPath(vaultPath, byNameCI.path); return byNameCI; }

    return null;
  }

  /** Auto-heal: update stored path when file is found at a different location */
  private healPath(oldPath: string, newPath: string) {
    const idx = this.pdfPaths.indexOf(oldPath);
    if (idx !== -1) this.pdfPaths[idx] = newPath;
    this.scheduleSave();
  }

  // ── Frontmatter I/O ──────────────────────────────────────────────────────
  private readFrontmatterState(file: TFile): { paths: string[]; lastPath: string | null; lastPage: number } {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;

    let paths: string[] = [];
    const raw = fm?.["pdf-links"];
    if (raw != null) {
      paths = (Array.isArray(raw) ? raw : [raw]).filter((p): p is string => typeof p === "string");
    } else {
      // Migrate from legacy data.json on first open after update
      const legacy = this.plugin.pluginData.pdfLinks?.[file.path];
      if (legacy?.length) paths = [...legacy];
    }

    return {
      paths,
      lastPath: typeof fm?.["pdf-last"] === "string"     ? fm["pdf-last"]      : null,
      lastPage: typeof fm?.["pdf-last-page"] === "number" ? fm["pdf-last-page"] : 1,
    };
  }

  private async writeFrontmatterState(file: TFile) {
    const lastPdfPath = this.pdfPaths[this.activeIdx] ?? null;
    try {
      await (this.app as any).fileManager.processFrontMatter(file, (fm: Record<string, any>) => {
        if (this.pdfPaths.length > 0) fm["pdf-links"] = [...this.pdfPaths];
        else delete fm["pdf-links"];
        if (lastPdfPath) {
          fm["pdf-last"]      = lastPdfPath;
          fm["pdf-last-page"] = this.currentPage;
        } else {
          delete fm["pdf-last"];
          delete fm["pdf-last-page"];
        }
      });
      // Remove from legacy data.json once migrated to frontmatter
      if (this.plugin.pluginData.pdfLinks?.[file.path]) {
        delete this.plugin.pluginData.pdfLinks[file.path];
        await this.plugin.savePluginData();
      }
    } catch {
      // processFrontMatter unavailable — fall back to data.json
      if (this.pdfPaths.length > 0) this.plugin.pluginData.pdfLinks[file.path] = [...this.pdfPaths];
      else delete this.plugin.pluginData.pdfLinks[file.path];
      await this.plugin.savePluginData();
    }
  }

  /** Debounced save — for page navigation and auto-heal path updates */
  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 800);
  }

  /** Immediate save — flushes any pending debounced save */
  private async saveNow() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.notePath) return;
    const noteFile = this.app.vault.getAbstractFileByPath(this.notePath);
    if (noteFile instanceof TFile) await this.writeFrontmatterState(noteFile);
  }

  // ── Sync to whichever note is open ───────────────────────────────────────
  private async syncToActiveNote() {
    const active = this.app.workspace.getActiveFile();
    if (!active || active.extension !== "md") return;
    if (active.path === this.notePath) return;

    // Flush pending save for the previous note before switching
    if (this.saveTimer) await this.saveNow();

    this.notePath = active.path;
    const { paths, lastPath, lastPage } = this.readFrontmatterState(active);
    this.pdfPaths = paths;

    // Restore last-viewed PDF and page for this note
    if (lastPath && paths.includes(lastPath)) {
      this.activeIdx   = paths.indexOf(lastPath);
      this.currentPage = lastPage;
    } else {
      this.activeIdx   = 0;
      this.currentPage = 1;
    }

    this.renderRetry = 0;
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

    const btnRow = toolbar.createDiv("remnote-pdf-btn-row");

    const addBtn = btnRow.createEl("button", { cls: "remnote-pdf-btn", title: "PDF aus Vault hinzufügen" });
    addBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> PDF';
    addBtn.onclick = () => this.addPdfFromVault();

    const delBtn = btnRow.createEl("button", { cls: "remnote-pdf-btn remnote-pdf-btn-danger", title: "Dieses PDF entfernen" });
    delBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
    delBtn.onclick = () => this.removeActivePdf();

    // ── Nav bar ───────────────────────────────────────────────────────────
    const navBar = contentEl.createDiv("remnote-pdf-nav");

    const prevBtn = navBar.createEl("button", { cls: "remnote-pdf-nav-btn", title: "Vorherige Seite (Alt+←)" });
    prevBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>';
    prevBtn.onclick = () => this.gotoPage(this.currentPage - 1);

    navBar.createEl("span", { text: "Seite", cls: "remnote-pdf-page-label" });

    this.pageInput = navBar.createEl("input", { type: "number", cls: "remnote-pdf-page-input", value: "1" });
    this.pageInput.min = "1";
    this.pageInput.onchange  = () => {
      const v = parseInt(this.pageInput!.value);
      if (!isNaN(v) && v > 0) this.gotoPage(v);
    };
    this.pageInput.onkeydown = (e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); };

    const nextBtn = navBar.createEl("button", { cls: "remnote-pdf-nav-btn", title: "Nächste Seite (Alt+→)" });
    nextBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>';
    nextBtn.onclick = () => this.gotoPage(this.currentPage + 1);

    // Filename display — fills remaining nav space between page controls and link button
    this.pdfNameEl = navBar.createEl("span", { cls: "remnote-pdf-name-display", text: "" });

    const linkBtn = navBar.createEl("button", { cls: "remnote-pdf-btn remnote-pdf-btn-link", title: "[[pdf#page=N|*]] in Notiz einfügen" });
    linkBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> Seite verknüpfen';
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

    this.statusEl     = mainArea.createDiv("remnote-pdf-status");
    this.pdfContainer = mainArea.createDiv("remnote-pdf-container");

    this.dropOverlay  = mainArea.createDiv("remnote-pdf-drop-overlay");
    this.dropOverlay.innerHTML =
      '<div class="remnote-pdf-drop-icon">📥</div>' +
      '<div class="remnote-pdf-drop-title">PDF hier ablegen</div>' +
      '<div class="remnote-pdf-drop-sub">Wird in Vault importiert und verknüpft</div>';

    this.attachDragDrop(mainArea);
    this.refreshTabs();
    this.renderPdf();
  }

  // ── Tab bar with ◄ ► sort buttons on the active tab ──────────────────────
  private refreshTabs() {
    if (!this.tabBar) return;
    this.tabBar.empty();

    if (this.pdfPaths.length === 0) {
      this.tabBar.createEl("span", {
        text: this.notePath ? "Kein PDF — PDF reinziehen oder + klicken" : "Keine Notiz geöffnet",
        cls:  "remnote-pdf-no-pdf",
      });
      return;
    }

    for (let i = 0; i < this.pdfPaths.length; i++) {
      const name     = this.pdfPaths[i].split("/").pop()?.replace(/\.pdf$/i, "") ?? "";
      const isActive = i === this.activeIdx;
      const hasLeft  = isActive && i > 0;
      const hasRight = isActive && i < this.pdfPaths.length - 1;

      const wrapper = this.tabBar.createDiv({
        cls: "remnote-pdf-tab-wrapper" + (isActive ? " active" : ""),
      });

      if (hasLeft) {
        const lb = wrapper.createEl("button", {
          cls:   "remnote-pdf-sort-btn remnote-pdf-sort-left",
          title: "Nach links verschieben",
        });
        lb.textContent = "◄";
        lb.onclick = (e) => { e.stopPropagation(); this.movePdf(i, i - 1); };
      }

      let radiusCls = "";
      if (hasLeft && hasRight) radiusCls = " remnote-pdf-tab-mid";
      else if (hasLeft)        radiusCls = " remnote-pdf-tab-right";
      else if (hasRight)       radiusCls = " remnote-pdf-tab-left";

      const tabBtn = wrapper.createEl("button", {
        cls:   "remnote-pdf-tab" + (isActive ? " active" : "") + radiusCls,
        title: this.pdfPaths[i],
      });
      tabBtn.setText(name);
      tabBtn.onclick = () => {
        this.activeIdx   = i;
        this.currentPage = 1;
        this.refreshTabs();
        this.renderPdf();
      };

      if (hasRight) {
        const rb = wrapper.createEl("button", {
          cls:   "remnote-pdf-sort-btn remnote-pdf-sort-right",
          title: "Nach rechts verschieben",
        });
        rb.textContent = "►";
        rb.onclick = (e) => { e.stopPropagation(); this.movePdf(i, i + 1); };
      }
    }

    // Scroll active tab into view
    requestAnimationFrame(() => {
      const activeWrapper = this.tabBar?.querySelector<HTMLElement>(".remnote-pdf-tab-wrapper.active");
      activeWrapper?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }

  /** Move PDF from fromIdx to toIdx, save, and refresh */
  private async movePdf(fromIdx: number, toIdx: number) {
    if (toIdx < 0 || toIdx >= this.pdfPaths.length) return;
    const arr = [...this.pdfPaths];
    const [item] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, item);
    this.pdfPaths  = arr;
    this.activeIdx = toIdx;
    await this.saveNow();
    this.refreshTabs();
  }

  // ── Render PDF using Obsidian native embed ────────────────────────────────
  private async renderPdf() {
    if (!this.pdfContainer || !this.statusEl) return;
    this.pdfContainer.empty();
    this.pdfIframe = null;

    if (this.pdfPaths.length === 0) {
      this.pdfContainer.style.display = "none";
      this.statusEl.style.display     = "flex";
      if (this.pdfNameEl) this.pdfNameEl.textContent = "";
      this.statusEl.innerHTML = this.notePath
        ? '<div class="remnote-pdf-status-icon">📄</div>' +
          '<div class="remnote-pdf-status-text">Kein PDF verknüpft</div>' +
          '<div class="remnote-pdf-status-sub">PDF aus Windows Explorer hier reinziehen<br>oder „+ PDF“ für ein PDF aus dem Vault</div>'
        : '<div class="remnote-pdf-status-icon">📝</div>' +
          '<div class="remnote-pdf-status-text">Keine Notiz geöffnet</div>' +
          '<div class="remnote-pdf-status-sub">Öffne eine Notiz um ihre PDFs anzuzeigen</div>';
      return;
    }

    this.pdfContainer.style.display = "block";
    this.statusEl.style.display     = "none";

    const storedPath = this.pdfPaths[this.activeIdx];
    const pdfFile    = this.resolveFile(storedPath);

    if (!pdfFile) {
      // File may have just been written to disk — vault cache needs time to index it
      if (this.renderRetry < 4) {
        this.renderRetry++;
        setTimeout(() => this.renderPdf(), 600 * this.renderRetry);
        return;
      }
      this.renderRetry = 0;
      new Notice("PDF nicht im Vault gefunden: " + storedPath, 5000);
      this.pdfContainer.style.display = "none";
      this.statusEl.style.display     = "flex";
      this.statusEl.innerHTML =
        '<div class="remnote-pdf-status-icon">⚠️</div>' +
        '<div class="remnote-pdf-status-text">PDF nicht gefunden</div>' +
        '<div class="remnote-pdf-status-sub">' + storedPath + '</div>';
      return;
    }
    this.renderRetry = 0;

    if (this.pdfNameEl) this.pdfNameEl.textContent = pdfFile.name;
    if (this.pageInput)  this.pageInput.value        = String(this.currentPage);

    // Use Chromium's native PDF viewer via vault resource URL.
    // This avoids the PDF.js canvas blank-on-init issue that affects Obsidian's
    // inline embed when the host container hasn't settled its dimensions yet.
    const resourceUrl = (this.app.vault as any).getResourcePath(pdfFile) as string;

    this.pdfIframe = document.createElement("iframe");
    this.pdfIframe.src = resourceUrl + "#page=" + this.currentPage;
    this.pdfIframe.setAttribute("style",
      "position:absolute;inset:0;width:100%;height:100%;border:none;display:block;"
    );
    this.pdfContainer!.appendChild(this.pdfIframe);

    this.scheduleSave();
  }

  // ── Navigation ────────────────────────────────────────────────────────────
  private gotoPage(page: number) {
    if (page < 1) return;
    this.currentPage = page;
    if (this.pageInput) this.pageInput.value = String(page);

    // Update iframe src directly — avoids full re-render
    if (this.pdfIframe) {
      try {
        const base = this.pdfIframe.src.split("#")[0];
        this.pdfIframe.src = base + "#page=" + page;
      } catch {
        this.renderPdf();
      }
    } else {
      this.renderPdf();
    }

    this.scheduleSave();
  }

  // ── Insert [[pdf#page=N|*]] into active note ──────────────────────────────
  insertPageRef() {
    if (this.pdfPaths.length === 0) { new Notice("Kein PDF aktiv."); return; }
    const pdfName = this.pdfPaths[this.activeIdx].split("/").pop() ?? "";
    const ref     = "[[" + pdfName + "#page=" + this.currentPage + "|*]]";

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.editor) {
      view.editor.replaceRange(ref, view.editor.getCursor());
      new Notice("✓ Referenz eingefügt: " + ref, 2000);
    } else {
      navigator.clipboard.writeText(ref)
        .then(() => new Notice("Referenz kopiert: " + ref, 3000));
    }
  }

  // ── Public: jump to a specific PDF + page ─────────────────────────────────
  async openPdfAtPage(pdfPath: string, page: number) {
    if (!this.pdfPaths.includes(pdfPath)) {
      await this.linkPdf(pdfPath);
    }
    const idx = this.pdfPaths.indexOf(pdfPath);
    if (idx !== -1 && idx !== this.activeIdx) {
      this.activeIdx = idx;
      this.refreshTabs();
    }
    this.currentPage = page;
    if (this.pageInput) this.pageInput.value = String(page);

    if (this.pdfIframe) {
      try {
        const base = this.pdfIframe.src.split("#")[0];
        this.pdfIframe.src = base + "#page=" + page;
      } catch { await this.renderPdf(); }
    } else {
      await this.renderPdf();
    }
  }

  // ── Drag & Drop (OS file → vault) ─────────────────────────────────────────
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

    const fileName     = file.name;
    const folder       = (this.plugin.pluginData.settings.pdfAttachmentFolder || "Attachments/PDFs").replace(/\/$/, "");
    const destPath     = folder + "/" + fileName;
    const vaultBase    = ((this.app.vault.adapter as any).basePath ?? "").replace(/\\/g, "/");
    const electronPath = ((file as any).path ?? "").replace(/\\/g, "/");

    if (vaultBase && electronPath.startsWith(vaultBase)) {
      const rel = electronPath.slice(vaultBase.length).replace(/^\//, "");
      await this.linkPdf(rel);
      new Notice('"' + fileName + '" ist bereits im Vault — verknüpft', 2000);
      return;
    }

    if (await this.app.vault.adapter.exists(destPath)) {
      await this.linkPdf(destPath);
      new Notice('"' + fileName + '" existiert bereits im Vault — verknüpft', 2000);
      return;
    }

    if (!await this.app.vault.adapter.exists(folder))
      await this.app.vault.createFolder(folder);

    const notice = new Notice('Importiere "' + fileName + '"…', 0);
    try {
      await this.app.vault.adapter.writeBinary(destPath, await file.arrayBuffer());
      notice.hide();
      this.renderRetry = 0;
      await this.linkPdf(destPath);
      new Notice('✓ "' + fileName + '" → ' + destPath, 4000);
    } catch (err: any) {
      notice.hide();
      new Notice("Import fehlgeschlagen: " + (err.message ?? err), 5000);
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
    await this.saveNow();
    this.activeIdx = this.pdfPaths.length - 1; this.currentPage = 1;
    this.refreshTabs(); this.renderPdf();
  }

  // ── Manage linked PDFs ────────────────────────────────────────────────────
  private addPdfFromVault() {
    if (!this.notePath) { new Notice("Keine Notiz geöffnet."); return; }
    new PdfMultiSelectModal(this.app, async (vaultFiles, deviceFiles) => {
      for (const f of vaultFiles)  await this.linkPdf(f.path);
      for (const f of deviceFiles) await this.importDroppedPdf(f);
    }).open();
  }

  private async removeActivePdf() {
    if (this.pdfPaths.length === 0) return;
    const removed = this.pdfPaths[this.activeIdx].split("/").pop();
    this.pdfPaths.splice(this.activeIdx, 1);
    await this.saveNow();
    this.activeIdx   = Math.max(0, this.activeIdx - 1);
    this.currentPage = 1;
    this.refreshTabs(); this.renderPdf();
    new Notice('"' + removed + '" entfernt', 2000);
  }

  private isVisible(): boolean { return this.leaf.view === this; }
}
