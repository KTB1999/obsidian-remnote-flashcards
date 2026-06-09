import { Flashcard, PluginData, ExamGroup, cardBelongsToGroup } from "./types";
import { isDue, todayStr, daysBetween } from "./sm2";

export interface DailySession {
  dueCards: Flashcard[];
  newCards: Flashcard[];
  totalDue: number;
  newCardQuota: number;
  daysUntilExam: number | null;
  groupName: string | null;
}

// Build a session for a specific set of cards (already filtered by caller)
export function buildDailySession(
  cards: Flashcard[],
  data: PluginData,
  examDate?: string,
  groupName?: string
): DailySession {
  const { reviews } = data;
  const today = todayStr();

  const dueCards: Flashcard[] = [];
  const newCards: Flashcard[] = [];

  for (const card of cards) {
    const rec = reviews[card.id];
    if (!rec) {
      newCards.push(card);
    } else if (isDue(rec)) {
      dueCards.push(card);
    }
  }

  let newCardQuota = data.settings.newCardsPerDay;
  let daysUntilExam: number | null = null;

  if (examDate) {
    const days = daysBetween(today, examDate);
    daysUntilExam = days;

    if (days > 0 && newCards.length > 0) {
      const effectiveDays = Math.max(1, Math.floor(days * 0.8));
      newCardQuota = Math.ceil(newCards.length / effectiveDays);
      newCardQuota = Math.min(newCardQuota, 50);
    } else if (days <= 0) {
      newCardQuota = newCards.length;
    }
  }

  return {
    dueCards,
    newCards: newCards.slice(0, newCardQuota),
    totalDue: dueCards.length,
    newCardQuota,
    daysUntilExam,
    groupName: groupName ?? null,
  };
}

export function getSessionCards(session: DailySession): Flashcard[] {
  return [...session.dueCards, ...session.newCards];
}

// Get cards for a specific exam group
export function cardsForGroup(allCards: Flashcard[], group: ExamGroup): Flashcard[] {
  return allCards.filter((c) => cardBelongsToGroup(c, group));
}

// Get cards not assigned to any exam group
export function cardsWithoutGroup(allCards: Flashcard[], data: PluginData): Flashcard[] {
  const { examGroups } = data.settings;
  if (examGroups.length === 0) return allCards;
  return allCards.filter((c) =>
    !examGroups.some((g) => cardBelongsToGroup(c, g))
  );
}

// Get cards for a specific file path
export function cardsForPath(allCards: Flashcard[], filePath: string): Flashcard[] {
  return allCards.filter((c) => c.filePath === filePath);
}

export function getStats(cards: Flashcard[], data: PluginData) {
  const reviews = data.reviews;
  let learned = 0;
  let due = 0;
  let unseen = 0;

  for (const card of cards) {
    const rec = reviews[card.id];
    if (!rec) {
      unseen++;
    } else if (isDue(rec)) {
      due++;
    } else {
      learned++;
    }
  }

  return { learned, due, unseen, total: cards.length };
}

// Summary across all exam groups for the daily reminder
export function getTotalDueCount(allCards: Flashcard[], data: PluginData): number {
  const { due } = getStats(allCards, data);
  return due;
}
