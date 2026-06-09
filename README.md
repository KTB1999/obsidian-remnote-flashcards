# RemNote Flashcards for Obsidian

A feature-rich flashcard and PDF study plugin for [Obsidian](https://obsidian.md), inspired by RemNote. Replace your RemNote subscription with a fully local, self-hosted study system — including spaced repetition, AI explanations, and a PDF side panel.

---

## Features

### Flashcards & Spaced Repetition
- **`::` syntax** — basic flip cards: `Question :: Answer`
- **`:::` syntax** — dropdown/cloze cards: `Term ::: Definition`
- **Multi-line cards** — sub-bullets after `::` or `:::` become the back side
- **SM-2 algorithm** — proven spaced repetition (same algorithm as Anki)
- **4-category rating** — Wieder / Schwer / Gut / Einfach (Again / Hard / Good / Easy)
- **Keyboard shortcuts** — Space to reveal, 1–4 to rate

### Exam-Aware Scheduling
- Set multiple exam groups, each with a date and linked notes/folders
- Daily card quota auto-calculated: `remaining cards ÷ days until exam`
- Session picker shows days remaining and due count per exam

### AI Integration (optional)
- **AI autofill** — generate an answer for a `Question ::` card while writing (Cmd/Ctrl+P → "AI Antwort generieren")
- **AI explain** — "✦ Erklären" button during review shows why the answer is correct
- Works with **any OpenAI-compatible provider** — bring your own API key:

| Provider | Free tier | Base URL |
|---|---|---|
| Ollama (local) | Free (runs on your GPU) | `http://localhost:11434/v1` |
| NVIDIA NIM | ✅ Free credits | `https://integrate.api.nvidia.com/v1` |
| OpenAI | ❌ Paid | `https://api.openai.com/v1` |
| OpenRouter | ✅ Free models available | `https://openrouter.ai/api/v1` |

No API key is bundled — each user connects their own account.

### PDF Side Panel
- Link one or more PDFs to any note — panel auto-syncs when you switch notes
- Drag & drop PDFs from Windows Explorer directly into the panel
- Page navigation with keyboard shortcuts (Alt+← / Alt+→)
- **"Seite verknüpfen"** — inserts `[[file.pdf#page=5]]` reference into your note
- **Click any `[[pdf#page=N]]` link** in a note → panel jumps to that page
- Text selection and copy works natively (uses Obsidian's built-in PDF viewer)
- PDFs stored in vault → sync to all devices via OneDrive / iCloud

### Browse & Stats
- Browse all cards filtered by status: Neu / Wieder / Schwer / Gut / Einfach
- Search across all cards
- Expandable rows show back content + SM-2 stats (interval, ease factor, due date)
- Daily ribbon badge showing how many cards are due

---

## Installation

### Via BRAT (recommended — one click)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from the Obsidian Community Plugins
2. Open BRAT settings → "Add Beta Plugin"
3. Enter: `https://github.com/kiranbest1999/obsidian-remnote-flashcards`
4. Enable the plugin in Settings → Community Plugins

### Manual

1. Download `main.js`, `styles.css`, `manifest.json` from the [latest release](https://github.com/kiranbest1999/obsidian-remnote-flashcards/releases/latest)
2. Create folder: `[your vault]/.obsidian/plugins/obsidian-remnote-flashcards/`
3. Copy the three files into that folder
4. Enable the plugin in Settings → Community Plugins

---

## Quick Start

### Create flashcards
```markdown
What is photosynthesis? :: Plants convert sunlight into glucose using CO₂ and water.

Mitosis ::: Cell division producing two genetically identical daughter cells
  - Phases: Prophase → Metaphase → Anaphase → Telophase
  - Results in 2 diploid cells
```

### Link a PDF to a note
1. Open any note
2. Open the PDF panel (file-text icon in the ribbon, or Cmd/Ctrl+P → "PDF Panel öffnen")
3. Drag a PDF into the panel, or click "+ PDF" to pick from your vault
4. Navigate to a page → click "Seite verknüpfen" → inserts `[[lecture.pdf#page=12]]` into your note

### Start a review session
- Click the layers icon in the ribbon
- Choose an exam group, the active note, or browse by file

### Set up AI (optional)
1. Settings → RemNote Flashcards → AI
2. Click a provider preset (e.g. "⚡ NVIDIA NIM")
3. Enter your API key
4. Toggle "AI aktivieren" ON

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` | Reveal card / flip |
| `1` | Wieder (Again) |
| `2` | Schwer (Hard) |
| `3` | Gut (Good) |
| `4` | Einfach (Easy) |
| `Alt+←` | Previous PDF page |
| `Alt+→` | Next PDF page |

---

## Mobile / iPad

All core features work on mobile. Requirements:
- Vault synced via OneDrive or iCloud
- Obsidian mobile installed, vault opened, plugin enabled
- AI requires a cloud provider (Ollama on localhost won't reach from mobile)

Drag & drop is desktop-only — add PDFs via the "+ PDF" button on mobile.

---

## Building from Source

```bash
git clone https://github.com/kiranbest1999/obsidian-remnote-flashcards
cd obsidian-remnote-flashcards
npm install
npm run build
```

Copy `main.js`, `styles.css`, `manifest.json` to your vault's plugin folder.

---

## License

MIT — see [LICENSE](LICENSE)
