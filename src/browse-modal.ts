import { App, Modal, MarkdownRenderer, TFile, Notice } from "obsidian";
import { Flashcard, PluginData, ReviewRecord } from "./types";
import { isDue } from "./sm2";
import type RemNoteFlashcardsPlugin from "./main";

type BrowseTab = "all" | "new" | "again" | "hard" | "good" | "easy";

interface CardWithStatus {
  card: Flashcard;
  tab: BrowseTab;
  record: ReviewRecord | null;
}

function classifyCard(card: Flashcard, data: PluginData): BrowseTab {
  const rec = data.reviews[card.id];
  if (!rec) return "new";
  if (rec.repetitions === 0) return "again";          // failed / reset
  if (rec.interval <= 6) return "hard";
  if (rec.interval <= 20) return "good";
  return "easy";
}

const TAB_LABELS: Record<BrowseTab, string> = {
  all:   "Alle",
  new:   "Neu",
  again: "Wieder",
  hard:  "Schwer",
  good:  "Gut",
  easy:  "Einfach",
};

const TAB_COLORS: Record<BrowseTab, string> = {
  all:   "",
  new:   "#888",
  again: "#e05252",
  hard:  "#d4870a",
  good:  "#2d8a4e",
  easy:  "#1a7abf",
};

export class BrowseModal extends Modal {
  private plugin: RemNoteFlashcardsPlugin;
  private allCards: Flashcard[];
  private data: PluginData;
  private activeTab: BrowseTab = "all";
  private expandedIds = new Set<string>();
  private searchQuery = "";

  constructor(app: App, plugin: RemNoteFlashcardsPlugin, allCards: Flashcard[], data: PluginData) {
    super(app);
    this.plugin = plugin;
    this.allCards = allCards;
    this.data = data;
  }

  onOpen() {
    this.modalEl.addClass("remnote-browse-modal");
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  private buildList(): CardWithStatus[] {
    return this.allCards.map((card) => ({
      card,
      tab: classifyCard(card, this.data),
      record: this.data.reviews[card.id] ?? null,
    }));
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();

    const all = this.buildList();

    // Count per tab
    const counts: Record<BrowseTab, number> = { all: all.length, new: 0, again: 0, hard: 0, good: 0, easy: 0 };
    for (const c of all) counts[c.tab]++;

    // ── Header ──
    contentEl.createEl("h2", { text: "Karteikarten", cls: "remnote-browse-title" });

    // ── Search ──
    const searchRow = contentEl.createDiv("remnote-browse-search-row");
    const searchInput = searchRow.createEl("input", {
      type: "text",
      placeholder: "Suchen...",
      cls: "remnote-browse-search",
    });
    searchInput.value = this.searchQuery;
    searchInput.oninput = () => {
      this.searchQuery = searchInput.value;
      this.renderList(listContainer, all, counts);
    };

    // ── Tab bar ──
    const tabBar = contentEl.createDiv("remnote-browse-tabs");
    const tabs: BrowseTab[] = ["all", "new", "again", "hard", "good", "easy"];
    for (const tab of tabs) {
      const btn = tabBar.createEl("button", {
        cls: "remnote-browse-tab" + (tab === this.activeTab ? " active" : ""),
      });
      btn.innerHTML =
        `<span class="remnote-browse-tab-label">${TAB_LABELS[tab]}</span>` +
        `<span class="remnote-browse-tab-count" style="background:${TAB_COLORS[tab] || "var(--tag-background)"}">` +
        `${counts[tab]}</span>`;
      btn.onclick = () => {
        this.activeTab = tab;
        tabBar.querySelectorAll(".remnote-browse-tab").forEach((el) => el.removeClass("active"));
        btn.addClass("active");
        this.renderList(listContainer, all, counts);
      };
    }

    // ── Card list ──
    const listContainer = contentEl.createDiv("remnote-browse-list");
    this.renderList(listContainer, all, counts);
  }

  private renderList(container: HTMLElement, all: CardWithStatus[], counts: Record<BrowseTab, number>) {
    container.empty();

    const q = this.searchQuery.toLowerCase();
    const filtered = all.filter((c) => {
      if (this.activeTab !== "all" && c.tab !== this.activeTab) return false;
      if (q && !c.card.front.toLowerCase().includes(q) && !c.card.back.toLowerCase().includes(q)) return false;
      return true;
    });

    if (filtered.length === 0) {
      container.createEl("p", { text: "Keine Karten gefunden.", cls: "remnote-browse-empty" });
      return;
    }

    for (const { card, tab, record } of filtered) {
      const isExpanded = this.expandedIds.has(card.id);
      const row = container.createDiv("remnote-browse-card" + (isExpanded ? " expanded" : ""));

      // ── Card header ──
      const header = row.createDiv("remnote-browse-card-header");

      // Status dot
      const dot = header.createSpan("remnote-browse-dot");
      dot.style.background = TAB_COLORS[tab] || "var(--tag-background)";
      dot.title = TAB_LABELS[tab];

      // Front text
      const frontEl = header.createDiv("remnote-browse-front");
      MarkdownRenderer.render(this.app, card.front, frontEl, card.filePath, this.plugin);

      // Right side: file badge + source btn
      const meta = header.createDiv("remnote-browse-meta");
      meta.createEl("span", {
        text: card.filePath.split("/").pop()?.replace(".md", "") ?? "",
        cls: "remnote-browse-file",
      });
      if (record) {
        meta.createEl("span", {
          text: `↻ ${record.interval}d`,
          cls: "remnote-browse-interval",
          title: `Nächste Wiederholung: ${record.dueDate}`,
        });
      }
      const srcBtn = meta.createEl("button", { cls: "remnote-btn-source remnote-browse-src-btn", title: "In Notiz öffnen" });
      srcBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
      srcBtn.onclick = (e) => { e.stopPropagation(); this.openSource(card); };

      // Click header to expand/collapse
      header.onclick = (e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        if (isExpanded) {
          this.expandedIds.delete(card.id);
        } else {
          this.expandedIds.add(card.id);
        }
        this.renderList(container, all, counts);
      };

      // ── Expanded back ──
      if (isExpanded) {
        const backEl = row.createDiv("remnote-browse-back");
        MarkdownRenderer.render(this.app, card.back, backEl, card.filePath, this.plugin);

        if (record) {
          const statsEl = row.createDiv("remnote-browse-stats");
          statsEl.innerHTML =
            `<span>Wiederholungen: <b>${record.repetitions}</b></span>` +
            `<span>Intervall: <b>${record.interval} Tage</b></span>` +
            `<span>Ease: <b>${record.easeFactor.toFixed(2)}</b></span>` +
            `<span>Fällig: <b>${record.dueDate}</b></span>`;
        }
      }
    }
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
    const view = (leaf as any).view;
    if (view?.editor) {
      view.editor.setCursor({ line: card.line, ch: 0 });
      view.editor.scrollIntoView(
        { from: { line: card.line, ch: 0 }, to: { line: card.line, ch: 999 } },
        true
      );
    }
  }
}
