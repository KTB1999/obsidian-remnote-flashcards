import { Flashcard, CardType } from "./types";

// Pure JS FNV-1a hash — works on desktop AND mobile (no Node crypto needed)
function hash(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, "0");
}

// The line number is deliberately not part of the id: editing a note above a
// card must not orphan that card's review record.
function cardId(filePath: string, front: string, occurrence: number): string {
  return hash(`${filePath}\n${front}` + (occurrence > 0 ? `\n${occurrence}` : ""));
}

/** Id scheme up to v1.7.5 — only used to carry existing reviews over. */
function legacyCardId(filePath: string, front: string, line: number): string {
  return hash(`${filePath}:${line}:${front}`);
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
  const seenFronts = new Map<string, number>();

  const add = (front: string, legacyFront: string, back: string, type: CardType, line: number) => {
    const occurrence = seenFronts.get(front) ?? 0;
    seenFronts.set(front, occurrence + 1);
    cards.push({
      id: cardId(filePath, front, occurrence),
      legacyId: legacyCardId(filePath, legacyFront, line),
      filePath, front, back, type, line,
    });
  };

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
      const head       = line.slice(0, dropIdx);
      const legacyFront = cleanFront(head);
      if (legacyFront) {
        // "Front :: Beschreibung :::" — the description belongs to the answer
        const innerIdx = findSeparator(head, "::");
        const rawFront = innerIdx !== -1 ? cleanFront(head.slice(0, innerIdx)) : legacyFront;
        const inline   = [
          innerIdx !== -1 ? head.slice(innerIdx + 2).trim() : "",
          line.slice(dropIdx + 3).trim(),
        ].filter(Boolean).join(" ");

        const { rest, consumed } = collectUntilBlank(lines, i + 1);
        const [front, firstLine] = closeSplitMarker(rawFront || legacyFront, inline);
        const back = [firstLine, dedent(rest)].filter(Boolean).join("\n");
        const type: CardType = isMultilayer(back) ? "multilayer" : "dropdown";
        add(front, legacyFront, back, type, i);
        i += consumed;
      }
      i++;
      continue;
    }

    // Detect ::
    const basicIdx = findSeparator(line, "::");
    if (basicIdx !== -1) {
      const legacyFront = cleanFront(line.slice(0, basicIdx));
      if (legacyFront) {
        const [front, back] = closeSplitMarker(legacyFront, line.slice(basicIdx + 2).trim());
        add(front, legacyFront, back, "basic", i);
      }
      i++;
      continue;
    }

    i++;
  }

  return cards;
}

/** Collect lines until an empty line — used by ::: cards. */
function collectUntilBlank(lines: string[], nextLine: number): { rest: string[]; consumed: number } {
  const rest: string[] = [];
  let j = nextLine;
  while (j < lines.length && lines[j].trim() !== "") {
    rest.push(lines[j]);
    j++;
  }
  return { rest, consumed: j - nextLine };
}

// Sub-bullets are usually indented under their question. Rendered as-is, a
// leading tab turns the whole answer into a Markdown code block.
function dedent(lines: string[]): string {
  const clean  = lines.map((l) => l.replace(/\s+$/, ""));
  const indent = Math.min(...clean.map((l) => l.match(/^[\t ]*/)![0].length));
  return clean.map((l) => l.slice(indent)).join("\n");
}

// "**Begriff ::** Antwort" puts the separator inside the bold span; move the
// closing marker back to the front so neither side shows stray asterisks.
function closeSplitMarker(front: string, back: string): [string, string] {
  for (const marker of ["**", "=="]) {
    const opened = front.split(marker).length - 1;
    if (opened % 2 === 1 && back.startsWith(marker)) {
      return [front.trimEnd() + marker, back.slice(marker.length).trimStart()];
    }
  }
  return [front, back];
}

function cleanFront(raw: string): string {
  return raw
    .replace(/^[\s]*[-*+]\s+/, "")
    .replace(/^\s*\d+\.\s+/, "")
    .replace(/^\s*#+\s+/, "")
    .trim();
}

export interface MultilayerItem {
  key: string;       // level 1 — always visible after reveal
  answer: string;    // level 2 — shown when the key is opened
  sub: string;       // deeper-indented lines under this item
  rateable: boolean; // false for plain lines without a separator
}

/** Split the back of a multilayer card into its individually rated parts. */
export function parseMultilayerItems(back: string): MultilayerItem[] {
  const lines = back.split("\n");
  const indentOf = (l: string) => l.match(/^[\t ]*/)![0].length;
  const items: MultilayerItem[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const content = line.trim().replace(/^[-*+]\s+/, "");

    const dropIdx  = findSeparator(content, ":::");
    const head     = dropIdx !== -1 ? content.slice(0, dropIdx) : content;
    const tail     = dropIdx !== -1 ? content.slice(dropIdx + 3).trim() : "";
    const basicIdx = findSeparator(head, "::");

    if (dropIdx === -1 && basicIdx === -1) {
      items.push({ key: content, answer: "", sub: "", rateable: false });
      i++;
      continue;
    }

    const indent = indentOf(line);
    const sub: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && indentOf(lines[j]) > indent) { sub.push(lines[j]); j++; }

    const key    = (basicIdx !== -1 ? head.slice(0, basicIdx) : head).trim();
    const answer = [basicIdx !== -1 ? head.slice(basicIdx + 2).trim() : "", tail].filter(Boolean).join(" ");
    items.push({ key, answer, sub: sub.join("\n"), rateable: true });
    i = j;
  }

  return items;
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
