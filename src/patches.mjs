import { randomUUID } from "node:crypto";
import { hash, cleanId, PatchValidationError, normalizeComment } from "./patch-model.mjs";

export { DEFAULT_TOPICS, PatchValidationError, normalizeTopics, normalizeComment } from "./patch-model.mjs";

function allOccurrences(text, needle) {
  const found = [];
  let from = 0;
  while (from <= text.length) {
    const index = text.indexOf(needle, from);
    if (index < 0) break;
    found.push(index);
    from = index + Math.max(1, needle.length);
  }
  return found;
}

function resolveAnchor(base, target, patchId) {
  if (!target || typeof target !== "object") throw new PatchValidationError("INVALID_TARGET", `Patch ${patchId} requires a target`, { patchId });
  const oldText = String(target.oldText ?? "");
  if (!oldText) throw new PatchValidationError("EMPTY_ANCHOR", `Patch ${patchId} requires a non-empty target.oldText`, { patchId });

  let candidates = allOccurrences(base, oldText);
  const before = target.contextBefore == null ? null : String(target.contextBefore);
  const after = target.contextAfter == null ? null : String(target.contextAfter);
  if (before != null) candidates = candidates.filter((index) => base.slice(0, index).endsWith(before));
  if (after != null) candidates = candidates.filter((index) => base.slice(index + oldText.length).startsWith(after));
  if (Number.isInteger(target.expectedStart)) candidates = candidates.filter((index) => index === target.expectedStart);

  if (candidates.length === 0) {
    throw new PatchValidationError("ANCHOR_NOT_FOUND", `Patch ${patchId} target could not be found in the base document`, { patchId });
  }
  if (candidates.length > 1) {
    throw new PatchValidationError("ANCHOR_AMBIGUOUS", `Patch ${patchId} target matched ${candidates.length} locations; provide contextBefore/contextAfter`, {
      patchId,
      candidateCount: candidates.length,
      candidates: candidates.slice(0, 20)
    });
  }
  return { index: candidates[0], oldText, contextBefore: before, contextAfter: after };
}

function patchesConflict(a, b) {
  const aInsertion = a.start === a.end;
  const bInsertion = b.start === b.end;
  if (aInsertion && bInsertion) return a.start === b.start;
  if (aInsertion) return a.start >= b.start && a.start <= b.end;
  if (bInsertion) return b.start >= a.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

export function canonicalizePatchSet(base, input, topics) {
  if (typeof base !== "string") throw new PatchValidationError("INVALID_BASE", "Base document must be a string");
  const patchSet = input?.patchSet ?? input;
  if (!patchSet || typeof patchSet !== "object") throw new PatchValidationError("INVALID_PATCHSET", "patchSet is required");
  if (!Array.isArray(patchSet.patches) || patchSet.patches.length === 0) {
    throw new PatchValidationError("EMPTY_PATCHSET", "patchSet.patches must contain at least one patch");
  }
  if (patchSet.patches.length > 1_000) throw new PatchValidationError("PATCH_LIMIT", "A patch set may contain at most 1,000 patches");

  const topicIds = new Set(topics.map((topic) => topic.id));
  const patchIds = new Set();
  const commentsIds = new Set();
  const canonical = patchSet.patches.map((patch, index) => {
    if (!patch || typeof patch !== "object") throw new PatchValidationError("INVALID_PATCH", `Patch ${index} must be an object`);
    const operation = patch.operation;
    if (!["replace", "delete", "insert_before", "insert_after"].includes(operation)) {
      throw new PatchValidationError("INVALID_OPERATION", `Patch ${index} has unsupported operation ${operation}`);
    }
    const id = cleanId(patch.id, `patch_${hash(`${index}\0${operation}\0${JSON.stringify(patch.target)}`).slice(0, 20)}`);
    if (patchIds.has(id)) throw new PatchValidationError("DUPLICATE_PATCH_ID", `Duplicate patch ID: ${id}`, { patchId: id });
    patchIds.add(id);

    const anchor = resolveAnchor(base, patch.target, id);
    let start;
    let end;
    let beforeText;
    let afterText;
    if (operation === "replace" || operation === "delete") {
      start = anchor.index;
      end = anchor.index + anchor.oldText.length;
      beforeText = anchor.oldText;
      afterText = operation === "delete" ? "" : String(patch.newText ?? "");
      if (operation === "replace" && typeof patch.newText !== "string") {
        throw new PatchValidationError("MISSING_NEW_TEXT", `Patch ${id} requires newText`, { patchId: id });
      }
    } else {
      start = operation === "insert_before" ? anchor.index : anchor.index + anchor.oldText.length;
      end = start;
      beforeText = "";
      if (typeof patch.newText !== "string") throw new PatchValidationError("MISSING_NEW_TEXT", `Patch ${id} requires newText`, { patchId: id });
      afterText = patch.newText;
    }

    if (!Array.isArray(patch.comments) || patch.comments.length === 0) {
      throw new PatchValidationError("MISSING_PATCH_COMMENT", `Patch ${id} must include at least one categorized comment`, { patchId: id });
    }
    const comments = patch.comments.map((comment, commentIndex) => normalizeComment(comment, { patchId: id, topicIds, index: commentIndex }));
    for (const comment of comments) {
      if (commentsIds.has(comment.id)) throw new PatchValidationError("DUPLICATE_COMMENT_ID", `Duplicate comment ID: ${comment.id}`, { patchId: id });
      commentsIds.add(comment.id);
    }

    return {
      id,
      operation,
      start,
      end,
      beforeText,
      afterText,
      target: {
        oldText: anchor.oldText,
        contextBefore: anchor.contextBefore,
        contextAfter: anchor.contextAfter,
        expectedStart: anchor.index
      },
      comments
    };
  });

  for (let i = 0; i < canonical.length; i += 1) {
    for (let j = i + 1; j < canonical.length; j += 1) {
      if (patchesConflict(canonical[i], canonical[j])) {
        throw new PatchValidationError("PATCH_OVERLAP", `Patches ${canonical[i].id} and ${canonical[j].id} overlap or share an unsafe boundary`, {
          patchIds: [canonical[i].id, canonical[j].id]
        });
      }
    }
  }

  canonical.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  return {
    id: cleanId(patchSet.id, `patchset_${randomUUID().replaceAll("-", "")}`),
    summary: String(patchSet.summary ?? ""),
    patches: canonical
  };
}
