export type CardType = "basic" | "dropdown";

export interface Flashcard {
  id: string;          // hash of filePath + line + front
  filePath: string;
  front: string;
  back: string;
  type: CardType;
  line: number;        // line number in source file (0-indexed)
}

// SM-2 review record stored per card
export interface ReviewRecord {
  cardId: string;
  interval: number;    // days until next review
  easeFactor: number;  // SM-2 EF, starts at 2.5
  repetitions: number; // consecutive successful reviews
  dueDate: string;     // ISO date string YYYY-MM-DD
  lastReviewed: string | null;
}

// Rating categories (maps to SM-2 quality scores)
export type Rating = "again" | "hard" | "good" | "easy";
export const RATING_QUALITY: Record<Rating, number> = {
  again: 0,
  hard: 3,
  good: 4,
  easy: 5,
};

// One exam group = one Klausur with associated notes/folders
export interface ExamGroup {
  id: string;
  name: string;         // e.g. "Obstbau Klausur"
  examDate: string;     // YYYY-MM-DD
  paths: string[];      // folder paths (ending in /) or exact file paths
}

export interface PluginSettings {
  examGroups: ExamGroup[];
  dailyReminderEnabled: boolean;
  aiEnabled: boolean;
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;
  newCardsPerDay: number;
  cardSyntaxBasic: string;
  cardSyntaxDropdown: string;
  pdfAttachmentFolder: string; // vault-relative folder for imported PDFs
}

export const DEFAULT_SETTINGS: PluginSettings = {
  examGroups: [],
  dailyReminderEnabled: true,
  aiEnabled: false,
  aiBaseUrl: "http://localhost:11434/v1",
  aiApiKey: "ollama",
  aiModel: "",
  newCardsPerDay: 20,
  cardSyntaxBasic: "::",
  cardSyntaxDropdown: ":::",
  pdfAttachmentFolder: "Attachments/PDFs",
};

export interface PluginData {
  settings: PluginSettings;
  reviews: Record<string, ReviewRecord>;  // cardId → ReviewRecord
  lastReminderDate: string;
  pdfLinks: Record<string, string[]>;     // notePath → [pdfPath, ...]
}

// Helper: does a card's filePath belong to an exam group?
export function cardBelongsToGroup(card: Flashcard, group: ExamGroup): boolean {
  for (const p of group.paths) {
    if (p.endsWith("/")) {
      // folder path
      if (card.filePath.startsWith(p)) return true;
    } else {
      // exact file path
      if (card.filePath === p) return true;
    }
  }
  return false;
}
