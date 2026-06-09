import { Flashcard, CardType } from "./types";
import { createHash } from "crypto";

function cardId(filePath: string, front: string, line: number): string {
  return createHash("md5").update(`${filePath}::${line}::${front}`).digest("hex").slice(0, 12);
}

/**
 * A continuation line is part of the card's back content.
 * It must be indented OR start with a list marker (-, *, +, 1.)
 * An empty line always terminates.
 */
function isContinuationLine(line: string): boolean {
  if (line.trim() === "") return false;
  return /^[\t ]/.test(line) || /^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line);
}

export function parseFlashcards(content: string, filePath: string): Flashcard[] {
  const cards: Flashcard[] = [];
  const lines = content.split("\n");

  // Skip YAML frontmatter
  let startLine = 0;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === "---") { startLine = i + 1; break; }
    }
  }

  let i = startLine;
  while (i < lines.length) {
    const line = lines[i];

    // Skip fenced code blocks
    if (line.trim().startsWith("```")) {
      i++;
      while (i < lines.length && !lines[i]?.trim().startsWith("```")) i++;
      i++;
      continue;
    }

    // Detect ::: first (must come before :: check)
    const dropIdx = findSeparator(line, ":::");
    if (dropIdx !== -1) {
      const front = cleanFront(line.slice(0, dropIdx));
      const firstBack = line.slice(dropIdx + 3).trim();
      if (front) {
        const { back, consumed } = collectBack(firstBack, lines, i + 1);
        cards.push({ id: cardId(filePath, front, i), filePath, front, back, type: "dropdown", line: i });
        i += consumed;
      }
      i++;
      continue;
    }

    // Detect ::
    const basicIdx = findSeparator(line, "::");
    if (basicIdx !== -1) {
      const front = cleanFront(line.slice(0, basicIdx));
      const firstBack = line.slice(basicIdx + 2).trim();
      if (front) {
        const { back, consumed } = collectBack(firstBack, lines, i + 1);
        cards.push({ id: cardId(filePath, front, i), filePath, front, back, type: "basic", line: i });
        i += consumed;
      }
      i++;
      continue;
    }

    i++;
  }

  return cards;
}

/**
 * Collect the back content: start with the inline portion (same line),
 * then absorb all immediately following continuation lines.
 * Returns the combined back string and how many extra lines were consumed.
 */
function collectBack(inlinePart: string, lines: string[], nextLine: number): { back: string; consumed: number } {
  const parts: string[] = [];
  if (inlinePart) parts.push(inlinePart);

  let j = nextLine;
  while (j < lines.length && isContinuationLine(lines[j])) {
    parts.push(lines[j].trimStart()); // remove leading indent — Markdown renders it anyway
    j++;
  }

  return {
    back: parts.join("\n"),
    consumed: j - nextLine,
  };
}

/** Strip leading list markers and Obsidian bullet chars from the front */
function cleanFront(raw: string): string {
  return raw
    .replace(/^[\s]*[-*+]\s+/, "")   // leading bullet
    .replace(/^\s*\d+\.\s+/, "")      // leading numbered list
    .replace(/^\s*#+\s+/, "")         // leading heading marker
    .trim();
}

/** Find a separator that is NOT inside backtick spans or [[wikilinks]] */
function findSeparator(line: string, sep: string): number {
  let inCode = false;
  let inLink = 0;
  for (let i = 0; i <= line.length - sep.length; i++) {
    const ch = line[i];
    if (ch === "`") inCode = !inCode;
    if (!inCode && ch === "[") inLink++;
    if (!inCode && ch === "]") inLink = Math.max(0, inLink - 1);
    if (!inCode && inLink === 0 && line.slice(i, i + sep.length) === sep) {
      if (sep === "::" && line[i + 2] === ":") continue; // skip ::: when looking for ::
      return i;
    }
  }
  return -1;
}
