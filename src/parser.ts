import { Flashcard, CardType } from "./types";

// Pure JS FNV-1a hash — works on desktop AND mobile (no Node crypto needed)
function cardId(filePath: string, front: string, line: number): string {
  const str = `${filePath}:${line}:${front}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, "0");
}

/**
 * A continuation line belongs to the card's back content.
 * Must be indented OR start with a list marker. Empty line terminates.
 */
function isContinuationLine(line: string): boolean {
  if (line.trim() === "") return false;
  return /^[\t ]/.test(line) || /^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line);
}

/** Returns true when the back content contains sub-bullets with :: or ::: */
function isMultilayer(back: string): boolean {
  return back.split("\n").some((l) => {
    const stripped = l.replace(/^\s*[-*+]\s+/, "").trim();
    return findSeparator(stripped, "::") !== -1;
  });
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

    // Detect ::: first (before ::)
    const dropIdx = findSeparator(line, ":::");
    if (dropIdx !== -1) {
      const front = cleanFront(line.slice(0, dropIdx));
      const firstBack = line.slice(dropIdx + 3).trim();
      if (front) {
        const { back, consumed } = collectBack(firstBack, lines, i + 1);
        // If sub-bullets themselves contain :: → multilayer card
        const type: CardType = isMultilayer(back) ? "multilayer" : "dropdown";
        cards.push({ id: cardId(filePath, front, i), filePath, front, back, type, line: i });
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

function collectBack(inlinePart: string, lines: string[], nextLine: number): { back: string; consumed: number } {
  const parts: string[] = [];
  if (inlinePart) parts.push(inlinePart);

  let j = nextLine;
  while (j < lines.length && isContinuationLine(lines[j])) {
    parts.push(lines[j]); // keep original indentation for multilayer depth detection
    j++;
  }

  return { back: parts.join("\n"), consumed: j - nextLine };
}

function cleanFront(raw: string): string {
  return raw
    .replace(/^[\s]*[-*+]\s+/, "")
    .replace(/^\s*\d+\.\s+/, "")
    .replace(/^\s*#+\s+/, "")
    .trim();
}

/** Find a separator not inside backtick spans or [[wikilinks]] */
export function findSeparator(line: string, sep: string): number {
  let inCode = false;
  let inLink = 0;
  for (let i = 0; i <= line.length - sep.length; i++) {
    const ch = line[i];
    if (ch === "`") inCode = !inCode;
    if (!inCode && ch === "[") inLink++;
    if (!inCode && ch === "]") inLink = Math.max(0, inLink - 1);
    if (!inCode && inLink === 0 && line.slice(i, i + sep.length) === sep) {
      if (sep === "::" && line[i + 2] === ":") continue; // skip ::: when searching for ::
      return i;
    }
  }
  return -1;
}
