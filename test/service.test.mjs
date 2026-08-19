import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildPatchSegments, assemble } from "../src/diff.mjs";
import { PatchValidationError, canonicalizePatchSet, normalizeTopics } from "../src/patches.mjs";
import { ConflictError, ReviewService } from "../src/service.mjs";
import { startViewer, tools } from "../src/server.mjs";
import { uiHtml, UI_MIME, UI_URI } from "../src/ui.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

async function root(t) {
  const value = await mkdtemp(path.join(tmpdir(), "article-review-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}

async function service(t) {
  return new ReviewService({ workspaceRoot: await root(t) }).init();
}

const topics = [
  { id: "architecture", label: "Architecture" },
  { id: "logic", label: "Logic" },
  { id: "methods", label: "Methods" },
  { id: "clarity", label: "Clarity" }
];

function patchReview(base, patchSet, extra = {}) {
  return {
    title: "Patch review",
    format: "markdown",
    base: { type: "inline", content: base },
    topics,
    patchSet,
    ...extra
  };
}

function rationale(topicId, body, extra = {}) {
  return { topicId, kind: "proposal_rationale", body, ...extra };
}

test("decisions, manual edits, idempotency, and stale versions assemble deterministically", async (t) => {
  const s = await service(t);
  let review = await s.submitPatchSet(patchReview("Alpha\n", {
    patches: [{ id: "claim", operation: "replace", target: { oldText: "Alpha" }, newText: "Beta", comments: [rationale("clarity", "Use the corrected term.")] }]
  }));

  review = await s.decision({ sessionId: review.sessionId, patchId: "claim", status: "accepted", expectedVersion: review.version, idempotencyKey: "accept" });
  assert.equal((await s.document({ sessionId: review.sessionId })).content, "Beta\n");

  const duplicate = await s.decision({ sessionId: review.sessionId, patchId: "claim", status: "rejected", expectedVersion: review.version, idempotencyKey: "accept" });
  assert.equal(duplicate.version, review.version);
  assert.equal((await s.document({ sessionId: review.sessionId })).content, "Beta\n");

  await assert.rejects(
    () => s.decision({ sessionId: review.sessionId, patchId: "claim", status: "rejected", expectedVersion: 1, idempotencyKey: "stale" }),
    ConflictError
  );

  review = await s.decision({ sessionId: review.sessionId, patchId: "claim", status: "rejected", expectedVersion: review.version, idempotencyKey: "reject" });
  assert.equal((await s.document({ sessionId: review.sessionId })).content, "Alpha\n");

  review = await s.edit({ sessionId: review.sessionId, patchId: "claim", editedText: "Gamma\r\n", expectedVersion: review.version, idempotencyKey: "edit" });
  assert.equal((await s.document({ sessionId: review.sessionId })).content, "Gamma\r\n\n");
});

test("categorized human comments can be added, replied to, resolved, and filtered", async (t) => {
  const s = await service(t);
  let review = await s.submitPatchSet(patchReview("A\n", {
    patches: [{ id: "p", operation: "replace", target: { oldText: "A" }, newText: "B", comments: [rationale("architecture", "Initial rationale.")] }]
  }));

  review = await s.comment({
    sessionId: review.sessionId,
    patchId: "p",
    topicId: "logic",
    kind: "review_comment",
    body: "The causal wording is too strong.",
    severity: "major",
    expectedVersion: review.version,
    idempotencyKey: "comment"
  });
  const human = review.page.items[0].comments.find((item) => item.kind === "review_comment");
  assert.equal(human.topicId, "logic");

  review = await s.replyComment({
    sessionId: review.sessionId,
    commentId: human.id,
    implementationReply: "Changed causal language to a conceptual analogy.",
    expectedVersion: review.version,
    idempotencyKey: "reply"
  });
  assert.match(review.page.items[0].comments.find((item) => item.id === human.id).implementationReply, /conceptual analogy/);

  review = await s.resolveComment({
    sessionId: review.sessionId,
    commentId: human.id,
    resolved: true,
    expectedVersion: review.version,
    idempotencyKey: "resolve"
  });
  assert.equal(review.page.items[0].comments.find((item) => item.id === human.id).resolved, true);

  const logic = await s.feedback({ sessionId: review.sessionId, topicId: "logic", statuses: ["pending"] });
  assert.equal(logic.actionablePatches.length, 1);
  assert.deepEqual(logic.actionablePatches[0].comments.map((item) => item.topicId), ["logic"]);

  await assert.rejects(
    () => s.comment({ sessionId: review.sessionId, patchId: "p", topicId: "unknown", body: "Bad topic", expectedVersion: review.version, idempotencyKey: "bad" }),
    (error) => error.code === "UNKNOWN_COMMENT_TOPIC"
  );
});

test("a revised patch set carries exact decisions and reviewer comments only", async (t) => {
  const s = await service(t);
  let review = await s.submitPatchSet(patchReview("A\nB\n", {
    id: "v1",
    patches: [{ id: "p", operation: "replace", target: { oldText: "A" }, newText: "A changed", comments: [rationale("architecture", "Original rationale.")] }]
  }));
  review = await s.comment({ sessionId: review.sessionId, patchId: "p", topicId: "logic", body: "Reviewer note.", expectedVersion: review.version, idempotencyKey: "c" });
  review = await s.decision({ sessionId: review.sessionId, patchId: "p", status: "accepted", expectedVersion: review.version, idempotencyKey: "d" });

  const same = await s.updatePatchSet({
    sessionId: review.sessionId,
    expectedVersion: review.version,
    idempotencyKey: "u1",
    patchSet: {
      id: "v2",
      patches: [{ id: "p", operation: "replace", target: { oldText: "A" }, newText: "A changed", comments: [rationale("architecture", "Updated rationale text.")] }]
    }
  });
  const exact = same.page.items[0];
  assert.equal(exact.decision.status, "accepted");
  assert.deepEqual(exact.comments.map((item) => item.body).sort(), ["Reviewer note.", "Updated rationale text."].sort());

  const changed = await s.updatePatchSet({
    sessionId: same.sessionId,
    expectedVersion: same.version,
    idempotencyKey: "u2",
    patchSet: {
      id: "v3",
      patches: [{ id: "p", operation: "replace", target: { oldText: "A" }, newText: "A changed again", comments: [rationale("architecture", "Changed patch rationale.")] }]
    }
  });
  assert.equal(changed.page.items[0].decision.status, "pending");
  assert.deepEqual(changed.page.items[0].comments.map((item) => item.body), ["Changed patch rationale."]);
});

test("legacy base plus proposal flow remains available", async (t) => {
  const s = await service(t);
  const review = await s.createLegacy({
    title: "Legacy",
    base: { type: "inline", content: "A\n" },
    proposal: { type: "inline", content: "B\n" }
  });
  assert.equal(review.counts.total, 1);
  assert.equal((await s.document({ sessionId: review.sessionId })).content, "B\n");
});

test("safe output rejects traversal and symlink escape", async (t) => {
  const workspace = await root(t);
  const outside = await root(t);
  await symlink(outside, path.join(workspace, "escape"));
  const s = await new ReviewService({ workspaceRoot: workspace }).init();
  const review = await s.submitPatchSet(patchReview("A\n", {
    patches: [{ id: "p", operation: "replace", target: { oldText: "A" }, newText: "B", comments: [rationale("clarity", "Correct A.")] }]
  }));
  await assert.rejects(() => s.finalize({ sessionId: review.sessionId, mode: "write_new_file", destination: "../bad.md" }), /traversal|escapes/i);
  await assert.rejects(() => s.finalize({ sessionId: review.sessionId, mode: "write_new_file", destination: "escape/bad.md" }), /symlink|escapes/i);
  const output = await s.finalize({ sessionId: review.sessionId, mode: "write_new_file", destination: "out/result.md" });
  assert.equal(await readFile(path.join(workspace, output.path), "utf8"), "B\n");
});

