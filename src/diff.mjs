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
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
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
    if (a[i] === b[j]) {
      push("equal", a[i]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push("delete", a[i]);
      i += 1;
    } else {
      push("insert", b[j]);
      j += 1;
    }
  }
  while (i < a.length) push("delete", a[i++]);
  while (j < b.length) push("insert", b[j++]);
  return out;
}

function tokens(text, locale = "und") {
  if (!text) return [];
  try {
    return [...new Intl.Segmenter(locale, { granularity: "word" }).segment(text)].map((item) => item.segment);
  } catch {
    return Array.from(text);
  }
}

export function inlineDiff(before, after, locale = "und") {
  const beforeTokens = tokens(before, locale);
  const afterTokens = tokens(after, locale);
  let operations;
  if (beforeTokens.length * afterTokens.length <= 2_000_000) {
    operations = lcs(beforeTokens, afterTokens).map((operation) => ({
      type: operation.type,
      text: operation.values.join("")
    }));
  } else {
    let prefix = 0;
    while (prefix < beforeTokens.length && prefix < afterTokens.length && beforeTokens[prefix] === afterTokens[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < beforeTokens.length - prefix &&
      suffix < afterTokens.length - prefix &&
      beforeTokens[beforeTokens.length - 1 - suffix] === afterTokens[afterTokens.length - 1 - suffix]
    ) suffix += 1;
    operations = [];
    const push = (type, values) => {
      const text = values.join("");
      if (text) operations.push({ type, text });
    };
    push("equal", beforeTokens.slice(0, prefix));
    push("delete", beforeTokens.slice(prefix, beforeTokens.length - suffix));
    push("insert", afterTokens.slice(prefix, afterTokens.length - suffix));
    if (suffix) push("equal", beforeTokens.slice(beforeTokens.length - suffix));
  }
  return operations;
}

function updateSectionPath(text, current) {
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

export function sectionPathAt(base, offset) {
  return updateSectionPath(base.slice(0, offset), []);
}

export function buildPatchSegments(base, canonicalPatches, { locale = "und", roundId = "round-1" } = {}) {
  const patches = [...canonicalPatches].sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  const segments = [];
  let cursor = 0;
  let order = 0;

  for (const patch of patches) {
    if (patch.start < cursor) throw new Error(`Patch ${patch.id} is out of order or overlaps a prior patch`);
    if (patch.start > cursor) {
      const equal = base.slice(cursor, patch.start);
      segments.push({ type: "equal", baseText: equal, proposalText: equal });
    }

    segments.push({
      type: "change",
      id: patch.id,
      patchId: patch.id,
      order,
      operation: patch.operation,
      sectionPath: sectionPathAt(base, patch.start),
      start: patch.start,
      end: patch.end,
      beforeText: patch.beforeText,
      afterText: patch.afterText,
      inlineOps: inlineDiff(patch.beforeText, patch.afterText, locale),
      decision: { status: "pending" },
      comments: structuredClone(patch.comments),
      target: structuredClone(patch.target)
    });
    cursor = patch.end;
    order += 1;
  }

  if (cursor < base.length) {
    const equal = base.slice(cursor);
    segments.push({ type: "equal", baseText: equal, proposalText: equal });
  }

  const rebuiltBase = segments.map((segment) => segment.type === "equal" ? segment.baseText : segment.beforeText).join("");
  const rebuiltProposal = segments.map((segment) => segment.type === "equal" ? segment.proposalText : segment.afterText).join("");
  if (rebuiltBase !== base) throw new Error("Lossless patch invariant failed for the base document");

  return { segments, proposalText: rebuiltProposal, roundId };
}

export function buildSegments(base, proposal, { locale = "und", roundId = "round-1" } = {}) {
  const operations = lcs(splitLines(base), splitLines(proposal));
  const segments = [];
  let before = "";
  let after = "";
  let sectionPath = [];
  let order = 0;

  const flush = () => {
    if (!before && !after) return;
    const id = `legacy_${idFor(`${roundId}\0${order}\0${before}\0${after}`)}`;
    segments.push({
      type: "change",
      id,
      patchId: id,
      order,
      operation: before && after ? "replace" : before ? "delete" : "insert_after",
      sectionPath: [...sectionPath],
      beforeText: before,
      afterText: after,
      inlineOps: inlineDiff(before, after, locale),
      decision: { status: "pending" },
      comments: [],
      target: { oldText: before }
    });
    before = "";
    after = "";
    order += 1;
  };

  for (const operation of operations) {
    const text = operation.values.join("");
    if (operation.type === "equal") {
      flush();
      segments.push({ type: "equal", baseText: text, proposalText: text });
      sectionPath = updateSectionPath(text, sectionPath);
    } else if (operation.type === "delete") {
      before += text;
    } else {
      after += text;
    }
  }
  flush();

  const rebuiltBase = segments.map((segment) => segment.type === "equal" ? segment.baseText : segment.beforeText).join("");
  const rebuiltProposal = segments.map((segment) => segment.type === "equal" ? segment.proposalText : segment.afterText).join("");
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

export function semanticPatchKey(segment) {
  return [
    segment.operation,
    segment.start ?? "",
    segment.end ?? "",
    segment.beforeText,
    segment.afterText,
    ...(segment.sectionPath ?? [])
  ].join("\0");
}
