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

test("explicit patches derive the proposal losslessly and expose topic-filtered views", async (t) => {
  const s = await service(t);
  const base = "# Introduction\r\n\r\nAlpha sentence.\r\n\r\n# Methods\r\n\r\nMeasure only accuracy.\r\n";
  const expected = "# Introduction\r\n\r\nBeta sentence with context.\r\n\r\n# Methods\r\n\r\nMeasure only accuracy. Also report candidate availability.\r\n";
  const review = await s.submitPatchSet(patchReview(base, {
    id: "round-one",
    summary: "Clarify architecture and evaluation.",
    patches: [
      {
        id: "intro-claim",
        operation: "replace",
        target: { oldText: "Alpha sentence." },
        newText: "Beta sentence with context.",
        comments: [
          rationale("architecture", "Expose the missing system stage.", { title: "Architecture bridge", severity: "major" }),
          rationale("clarity", "Make the sentence self-contained.")
        ]
      },
      {
        id: "methods-metric",
        operation: "insert_after",
        target: { oldText: "Measure only accuracy." },
        newText: " Also report candidate availability.",
        comments: [rationale("methods", "Report an intermediate bottleneck rather than only final accuracy.")]
      }
    ]
  }, { locale: "en-US" }));

  assert.equal(review.schemaVersion, "1.1");
  assert.equal(review.counts.total, 2);
  assert.equal(review.patchSet.id, "round-one");
  assert.equal((await s.document({ sessionId: review.sessionId })).content, expected);
  assert.equal(review.topicStats.find((item) => item.topicId === "architecture").commentCount, 1);
  assert.equal(review.topicStats.find((item) => item.topicId === "clarity").patchCount, 1);

  const dimmed = await s.getPage({ sessionId: review.sessionId, topicId: "architecture", contextMode: "dim_unrelated" });
  assert.equal(dimmed.page.items.length, 2);
  assert.equal(dimmed.page.items.filter((item) => item.matchesTopic).length, 1);

  const focused = await s.getPage({ sessionId: review.sessionId, topicId: "architecture", contextMode: "hide_unrelated" });
  assert.deepEqual(focused.page.items.map((item) => item.id), ["intro-claim"]);

  const feedback = await s.feedback({ sessionId: review.sessionId, topicId: "architecture", statuses: ["pending"] });
  assert.equal(feedback.actionablePatches.length, 1);
  assert.deepEqual(feedback.actionablePatches[0].comments.map((item) => item.topicId), ["architecture"]);
});

test("canonical patch operations preserve base and proposal exactly", () => {
  const base = "A\r\nB\r\nC\r\nD\r\n";
  const normalizedTopics = normalizeTopics(topics);
  const patchSet = canonicalizePatchSet(base, {
    id: "ops",
    patches: [
      { id: "before", operation: "insert_before", target: { oldText: "A" }, newText: "START\r\n", comments: [rationale("architecture", "Add opening context.")] },
      { id: "replace", operation: "replace", target: { oldText: "B" }, newText: "B2", comments: [rationale("clarity", "Clarify B.")] },
      { id: "delete", operation: "delete", target: { oldText: "C\r\n" }, comments: [rationale("logic", "Remove unsupported C.")] },
      { id: "after", operation: "insert_after", target: { oldText: "D" }, newText: "!", comments: [rationale("methods", "Mark terminal state.")] }
    ]
  }, normalizedTopics);
  const built = buildPatchSegments(base, patchSet.patches, { locale: "en-US", roundId: "r" });
  assert.equal(built.proposalText, "START\r\nA\r\nB2\r\nD!\r\n");
  for (const segment of built.segments) if (segment.type === "change") segment.decision = { status: "accepted" };
  assert.equal(assemble(built.segments), built.proposalText);
  for (const segment of built.segments) if (segment.type === "change") segment.decision = { status: "rejected" };
  assert.equal(assemble(built.segments), base);
});

test("ambiguous anchors require context and mismatched base hashes fail", async (t) => {
  const s = await service(t);
  const base = "same\nsame\n";
  await assert.rejects(
    () => s.submitPatchSet(patchReview(base, {
      patches: [{ id: "ambiguous", operation: "replace", target: { oldText: "same" }, newText: "different", comments: [rationale("logic", "Disambiguate repeated text.")] }]
    })),
    (error) => error instanceof PatchValidationError && error.code === "ANCHOR_AMBIGUOUS" && error.candidateCount === 2
  );

  const resolved = await s.submitPatchSet(patchReview(base, {
    patches: [{ id: "second", operation: "replace", target: { oldText: "same", contextBefore: "same\n" }, newText: "different", comments: [rationale("logic", "Modify only the second occurrence.")] }]
  }));
  assert.equal((await s.document({ sessionId: resolved.sessionId })).content, "same\ndifferent\n");

  await assert.rejects(
    () => s.submitPatchSet(patchReview("A", {
      patches: [{ id: "p", operation: "replace", target: { oldText: "A" }, newText: "B", comments: [rationale("logic", "Change A.")] }]
    }, { baseHash: "not-the-hash" })),
    (error) => error.code === "BASE_HASH_MISMATCH" && error.actualBaseHash === sha256("A")
  );
});

test("overlapping patches and uncategorized comments are rejected", async (t) => {
  const s = await service(t);
  await assert.rejects(
    () => s.submitPatchSet(patchReview("Alpha beta gamma", {
      patches: [
        { id: "wide", operation: "replace", target: { oldText: "Alpha beta" }, newText: "X", comments: [rationale("logic", "Wide edit.")] },
        { id: "nested", operation: "replace", target: { oldText: "beta" }, newText: "Y", comments: [rationale("clarity", "Nested edit.")] }
      ]
    })),
    (error) => error.code === "PATCH_OVERLAP"
  );

  await assert.rejects(
    () => s.submitPatchSet(patchReview("A", {
      patches: [{ id: "missing-comment", operation: "replace", target: { oldText: "A" }, newText: "B", comments: [] }]
    })),
    (error) => error.code === "MISSING_PATCH_COMMENT"
  );

  await assert.rejects(
    () => s.submitPatchSet(patchReview("A", {
      patches: [{ id: "unknown-topic", operation: "replace", target: { oldText: "A" }, newText: "B", comments: [rationale("statistics", "Unknown topic.")] }]
    })),
    (error) => error.code === "UNKNOWN_COMMENT_TOPIC"
  );
});

