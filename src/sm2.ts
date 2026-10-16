import { ReviewRecord, Rating, RATING_QUALITY } from "./types";

const MIN_EF = 1.3;

// Local calendar date. toISOString() is UTC, which is still "yesterday" for
// the first hours after midnight in Europe — due cards would not show up.
function localDateStr(d: Date): string {
  const m   = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function todayStr(): string {
  return localDateStr(new Date());
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return localDateStr(new Date(y, m - 1, d + days));
}

export function daysBetween(a: string, b: string): number {
  const msPerDay = 86400000;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / msPerDay);
}

export function newRecord(cardId: string): ReviewRecord {
  return {
    cardId,
    interval: 0,
    easeFactor: 2.5,
    repetitions: 0,
    dueDate: todayStr(),
    lastReviewed: null,
  };
}

export function applyRating(record: ReviewRecord, rating: Rating): ReviewRecord {
  const q = RATING_QUALITY[rating];
  const today = todayStr();
  let { interval, easeFactor, repetitions } = record;

  if (q < 3) {
    // Failed — reset
    repetitions = 0;
    interval = 1;
  } else {
    if (repetitions === 0) {
      interval = 1;
    } else if (repetitions === 1) {
      interval = 6;
    } else {
      interval = Math.round(interval * easeFactor);
    }
    repetitions += 1;
  }

  // Update ease factor
  easeFactor = easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (easeFactor < MIN_EF) easeFactor = MIN_EF;

  return {
    ...record,
    interval,
    easeFactor,
    repetitions,
    dueDate: addDays(today, interval),
    lastReviewed: today,
  };
}

export function isDue(record: ReviewRecord): boolean {
  return record.dueDate <= todayStr();
}
