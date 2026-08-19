import { createHash } from "node:crypto";

const idFor = (value) => createHash("sha256").update(value).digest("hex").slice(0, 18);

export function splitLines(text) {
  if (!text) return [];
  const lines = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? [];
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function lcs(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out = [];
  const push = (type, value) => {
    const last = out.at(-1);
    if (last?.type === type) last.values.push(value);
    else out.push({ type, values: [value] });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push("equal", a[i]); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) { push("delete", a[i]); i += 1; }
    else { push("insert", b[j]); j += 1; }
  }
  while (i < a.length) push("delete", a[i++]);
  while (j < b.length) push("insert", b[j++]);
  return out;
}

function tokens(text, locale = "und") {
  if (!text) return [];
  try { return [...new Intl.Segmenter(locale, { granularity: "word" }).segment(text)].map((x) => x.segment); }
  catch { return Array.from(text); }
}

export function inlineDiff(before, after, locale = "und") {
  return lcs(tokens(before, locale), tokens(after, locale)).map((op) => ({ type: op.type, text: op.values.join("") }));
}

function sectionUpdate(text, current) {
  const result = [...current];
  for (const line of splitLines(text)) {
    const match = line.match(/^\s*(#{1,6})\s+(.+?)\s*(?:\r?\n)?$/);
    if (!match) continue;
    const level = match[1].length;
    result.splice(level - 1);
    result[level - 1] = match[2].replace(/\s+#+\s*$/, "");
  }
  return result;
}

export function buildSegments(base, proposal, { locale = "und", roundId = "round-1" } = {}) {
  const ops = lcs(splitLines(base), splitLines(proposal));
  const segments = [];
  let before = "";
  let after = "";
  let sectionPath = [];
  let order = 0;
  const flush = () => {
    if (!before && !after) return;
    segments.push({
      type: "change",
      id: `h_${idFor(`${roundId}\0${order}\0${before}\0${after}`)}`,
      order,
      sectionPath: [...sectionPath],
      beforeText: before,
      afterText: after,
      inlineOps: inlineDiff(before, after, locale),
      decision: { status: "pending" },
      comments: []
    });
    before = "";
    after = "";
    order += 1;
  };
  for (const op of ops) {
    const text = op.values.join("");
    if (op.type === "equal") {
      flush();
      segments.push({ type: "equal", baseText: text, proposalText: text });
      sectionPath = sectionUpdate(text, sectionPath);
    } else if (op.type === "delete") before += text;
    else after += text;
  }
  flush();
  const rebuiltBase = segments.map((x) => x.type === "equal" ? x.baseText : x.beforeText).join("");
  const rebuiltProposal = segments.map((x) => x.type === "equal" ? x.proposalText : x.afterText).join("");
  if (rebuiltBase !== base || rebuiltProposal !== proposal) throw new Error("Lossless diff invariant failed");
  return segments;
}

export function assemble(segments, pendingPolicy = "proposal") {
  return segments.map((segment) => {
    if (segment.type === "equal") return segment.baseText;
    if (segment.decision.status === "accepted") return segment.afterText;
    if (segment.decision.status === "rejected") return segment.beforeText;
    if (segment.decision.status === "edited") return segment.decision.editedText ?? "";
    return pendingPolicy === "base" ? segment.beforeText : segment.afterText;
  }).join("");
}
