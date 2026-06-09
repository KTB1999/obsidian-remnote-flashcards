import { App, PluginSettingTab, Setting, Notice, Modal, ButtonComponent } from "obsidian";
import type RemNoteFlashcardsPlugin from "./main";
import { aiGenerateAnswer } from "./ai";
import { ExamGroup } from "./types";

// ---- Mini-modal to edit one exam group ----
class ExamGroupModal extends Modal {
  private group: ExamGroup;
  private onSave: (g: ExamGroup) => void;

  constructor(app: App, group: ExamGroup, onSave: (g: ExamGroup) => void) {
    super(app);
    this.group = { ...group, paths: [...group.paths] };
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("remnote-group-modal");
    contentEl.createEl("h3", { text: "Prüfungsgruppe bearbeiten" });

    new Setting(contentEl)
      .setName("Name")
      .setDesc("z.B. 'Obstbau Klausur'")
      .addText((t) =>
        t.setValue(this.group.name).onChange((v) => (this.group.name = v))
      );

    new Setting(contentEl)
      .setName("Prüfungsdatum")
      .setDesc("Format: YYYY-MM-DD")
      .addText((t) =>
        t
          .setPlaceholder("2026-07-15")
          .setValue(this.group.examDate)
          .onChange((v) => (this.group.examDate = v))
      );

    new Setting(contentEl)
      .setName("Verknüpfte Pfade")
      .setDesc(
        "Eine Notiz oder ein Ordner pro Zeile.\n" +
        "Ordner: 'Sources/VL Notizen/Agrarwissenschaften/'\n" +
        "Notiz: 'Sources/VL Notizen/Agrarwissenschaften/Obstbau SS2026.md'"
      )
      .addTextArea((ta) => {
        ta.setValue(this.group.paths.join("\n"));
        ta.inputEl.rows = 5;
        ta.inputEl.style.width = "100%";
        ta.onChange((v) => {
          this.group.paths = v
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
        });
      });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Speichern")
        .setCta()
        .onClick(() => {
          if (!this.group.name) {
            new Notice("Bitte einen Namen eingeben.");
            return;
          }
          this.onSave(this.group);
          this.close();
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---- Main settings tab ----
export class RemNoteSettingsTab extends PluginSettingTab {
  plugin: RemNoteFlashcardsPlugin;

  constructor(app: App, plugin: RemNoteFlashcardsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "RemNote Flashcards — Einstellungen" });

    // ===== PRÜFUNGSPLANUNG =====
    containerEl.createEl("h3", { text: "Prüfungen" });

    const groups = this.plugin.pluginData.settings.examGroups;

    // Render existing groups
    const groupsContainer = containerEl.createDiv("remnote-settings-groups");
    this.renderGroupList(groupsContainer);

    new Setting(containerEl)
      .setName("Neue Prüfung hinzufügen")
      .setDesc("Erstelle eine Prüfungsgruppe und verknüpfe sie mit Notizen oder Ordnern.")
      .addButton((btn) =>
        btn.setButtonText("+ Hinzufügen").onClick(() => {
          const newGroup: ExamGroup = {
            id: Date.now().toString(),
            name: "",
            examDate: "",
            paths: [],
          };
          new ExamGroupModal(this.app, newGroup, async (saved) => {
            this.plugin.pluginData.settings.examGroups.push(saved);
            await this.plugin.savePluginData();
            this.display(); // re-render settings
          }).open();
        })
      );

    new Setting(containerEl)
      .setName("Neue Karten pro Tag (Fallback)")
      .setDesc("Wird verwendet, wenn kein Prüfungsdatum für eine Karte gesetzt ist.")
      .addSlider((slider) =>
        slider
          .setLimits(5, 100, 5)
          .setValue(this.plugin.pluginData.settings.newCardsPerDay)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.pluginData.settings.newCardsPerDay = value;
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Tägliche Erinnerung")
      .setDesc("Zeigt beim Start eine Benachrichtigung, wenn Karten fällig sind.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.pluginData.settings.dailyReminderEnabled)
          .onChange(async (value) => {
            this.plugin.pluginData.settings.dailyReminderEnabled = value;
            await this.plugin.savePluginData();
          })
      );

    // ===== PDF PANEL =====
    containerEl.createEl("h3", { text: "PDF Panel" });

    new Setting(containerEl)
      .setName("Zielordner für importierte PDFs")
      .setDesc(
        "PDFs die per Drag & Drop importiert werden, landen hier im Vault.\n" +
        "Dieser Ordner wird von OneDrive automatisch auf alle Geräte synchronisiert."
      )
      .addText((text) =>
        text
          .setPlaceholder("Attachments/PDFs")
          .setValue(this.plugin.pluginData.settings.pdfAttachmentFolder)
          .onChange(async (value) => {
            this.plugin.pluginData.settings.pdfAttachmentFolder = value || "Attachments/PDFs";
            await this.plugin.savePluginData();
          })
      );

    // ===== KARTEN-SYNTAX =====
    containerEl.createEl("h3", { text: "Karten-Syntax" });

    new Setting(containerEl)
      .setName("Basic-Karte Trennzeichen")
      .setDesc("Standard: ::  →  Frage :: Antwort")
      .addText((text) =>
        text
          .setValue(this.plugin.pluginData.settings.cardSyntaxBasic)
          .onChange(async (value) => {
            this.plugin.pluginData.settings.cardSyntaxBasic = value || "::";
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("Dropdown-Karte Trennzeichen")
      .setDesc("Standard: :::  →  Begriff ::: Definition")
      .addText((text) =>
        text
          .setValue(this.plugin.pluginData.settings.cardSyntaxDropdown)
          .onChange(async (value) => {
            this.plugin.pluginData.settings.cardSyntaxDropdown = value || ":::";
            await this.plugin.savePluginData();
          })
      );

    // ===== AI =====
    containerEl.createEl("h3", { text: "AI" });

    new Setting(containerEl)
      .setName("AI aktivieren")
      .setDesc(
        "Aktiviert zwei Funktionen:\n" +
        "1. Command 'AI Antwort generieren' beim Schreiben (Strg+P)\n" +
        "2. '✦ Erklären'-Button nach dem Umdrehen einer Karte"
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.pluginData.settings.aiEnabled)
          .onChange(async (value) => {
            this.plugin.pluginData.settings.aiEnabled = value;
            await this.plugin.savePluginData();
          })
      );

    // ── Provider presets ──────────────────────────────────────────────────
    const presets: Record<string, { url: string; model: string; keyHint: string }> = {
      "🖥️ Ollama (lokal)": {
        url:     "http://localhost:11434/v1",
        model:   "starter-agent",
        keyHint: "ollama",
      },
      "⚡ NVIDIA NIM": {
        url:     "https://integrate.api.nvidia.com/v1",
        model:   "meta/llama-3.1-8b-instruct",
        keyHint: "nvapi-… (kostenlos auf build.nvidia.com)",
      },
      "☁️ OpenAI": {
        url:     "https://api.openai.com/v1",
        model:   "gpt-4o-mini",
        keyHint: "sk-… (platform.openai.com)",
      },
      "🔀 OpenRouter": {
        url:     "https://openrouter.ai/api/v1",
        model:   "meta-llama/llama-3.1-8b-instruct:free",
        keyHint: "sk-or-… (openrouter.ai — hat kostenlose Modelle)",
      },
    };

    let urlInputRef:   HTMLInputElement | null = null;
    let modelInputRef: HTMLInputElement | null = null;
    let keyHintEl:     HTMLElement | null      = null;
    // (keyInputRef intentionally omitted — presets never fill the API key field)

    const presetSetting = new Setting(containerEl)
      .setName("Provider Preset")
      .setDesc("Schnellauswahl — füllt URL und Modell aus. API Key separat eintragen.");

    for (const [label, preset] of Object.entries(presets)) {
      presetSetting.addButton((btn) =>
        btn.setButtonText(label).onClick(async () => {
          this.plugin.pluginData.settings.aiBaseUrl = preset.url;
          this.plugin.pluginData.settings.aiModel   = preset.model;
          await this.plugin.savePluginData();
          if (urlInputRef)   urlInputRef.value   = preset.url;
          if (modelInputRef) modelInputRef.value = preset.model;
          if (keyHintEl)     keyHintEl.textContent = `Key-Format: ${preset.keyHint}`;
          new Notice(`✓ ${label} geladen`, 2000);
        })
      );
    }

    // ── Manual fields ─────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("OpenAI-kompatibler API-Endpunkt.")
      .addText((text) => {
        urlInputRef = text.inputEl;
        text
          .setValue(this.plugin.pluginData.settings.aiBaseUrl)
          .onChange(async (value) => {
            this.plugin.pluginData.settings.aiBaseUrl = value;
            await this.plugin.savePluginData();
          });
      });

    const keySetting = new Setting(containerEl)
      .setName("API Key")
      .setDesc("Für Ollama: 'ollama'. Für Cloud-Provider: dein persönlicher Key.");
    keyHintEl = keySetting.descEl.createEl("span", { cls: "remnote-key-hint" });
    keySetting.addText((text) => {
      text.inputEl.type = "password";
      text
        .setPlaceholder("API Key eingeben…")
        .setValue(this.plugin.pluginData.settings.aiApiKey)
        .onChange(async (value) => {
          this.plugin.pluginData.settings.aiApiKey = value;
          await this.plugin.savePluginData();
        });
    });

    new Setting(containerEl)
      .setName("Modell")
      .setDesc("Modellname exakt wie vom Provider erwartet.")
      .addText((text) => {
        modelInputRef = text.inputEl;
        text
          .setValue(this.plugin.pluginData.settings.aiModel)
          .onChange(async (value) => {
            this.plugin.pluginData.settings.aiModel = value;
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName("Verbindung testen")
      .setDesc("Sendet eine kurze Testfrage — bestätigt dass Key, URL und Modell korrekt sind.")
      .addButton((btn) =>
        btn.setButtonText("Test").setCta().onClick(async () => {
          const tmpSettings = { ...this.plugin.pluginData.settings, aiEnabled: true };
          try {
            const result = await aiGenerateAnswer(
              "What is photosynthesis? Answer in one sentence.",
              "",
              tmpSettings
            );
            new Notice("✓ AI OK: " + result.slice(0, 120), 6000);
          } catch (e: any) {
            new Notice("✗ AI Fehler: " + e.message, 8000);
          }
        })
      );
  }

  private renderGroupList(container: HTMLElement) {
    container.empty();
    const groups = this.plugin.pluginData.settings.examGroups;

    if (groups.length === 0) {
      container.createEl("p", {
        text: "Noch keine Prüfungen angelegt.",
        cls: "remnote-settings-empty",
      });
      return;
    }

    for (const group of groups) {
      const row = container.createDiv("remnote-settings-group-row");

      const info = row.createDiv("remnote-settings-group-info");
      info.createEl("span", { text: group.name, cls: "remnote-settings-group-name" });
      info.createEl("span", {
        text: group.examDate ? `  📅 ${group.examDate}` : "  (kein Datum)",
        cls: "remnote-settings-group-date",
      });
      info.createEl("span", {
        text: `  ${group.paths.length} Pfad(e)`,
        cls: "remnote-settings-group-paths",
      });

      const actions = row.createDiv("remnote-settings-group-actions");

      // Edit button
      const editBtn = actions.createEl("button", { text: "Bearbeiten", cls: "remnote-btn-small" });
      editBtn.onclick = () => {
        new ExamGroupModal(this.app, group, async (saved) => {
          const idx = this.plugin.pluginData.settings.examGroups.findIndex((g) => g.id === saved.id);
          if (idx !== -1) {
            this.plugin.pluginData.settings.examGroups[idx] = saved;
          }
          await this.plugin.savePluginData();
          this.display();
        }).open();
      };

      // Delete button
      const delBtn = actions.createEl("button", { text: "×", cls: "remnote-btn-small remnote-btn-delete" });
      delBtn.onclick = async () => {
        this.plugin.pluginData.settings.examGroups =
          this.plugin.pluginData.settings.examGroups.filter((g) => g.id !== group.id);
        await this.plugin.savePluginData();
        this.display();
      };
    }
  }
}
