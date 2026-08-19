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

test("MCP App is topic-aware, self-contained, and renders manuscript HTML as inert text", () => {
  const malicious = "</script><script>alert(1)</script><img src=x onerror=alert(1)>";
  const html = uiHtml({ bootstrap: { sessionId: "review_12345678", title: malicious, counts: { total: 0, accepted: 0, rejected: 0, edited: 0, pending: 0 }, unresolvedComments: 0, version: 1, topics: [], topicStats: [], page: { items: [], offset: 0, limit: 30, total: 0, hasMore: false } } });
  assert.equal(UI_URI, "ui://article-review/review.html");
  assert.equal(UI_MIME, "text/html;profile=mcp-app");
  assert.match(html, /topicbar/);
  assert.match(html, /hide_unrelated/);
  assert.match(html, /article_review_get_document/);
  assert.match(html, /article_review_set_patch_decision/);
  assert.match(html, /ui\/initialize/);
  assert.doesNotMatch(html, /innerHTML\s*=/);
  assert.doesNotMatch(html, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(html, /<\/script><script>alert\(1\)/);
});

test("tool metadata makes patch-set submission primary and preserves compatibility aliases", () => {
  const primary = tools.find((item) => item.name === "article_review_submit_patchset");
  assert.equal(primary._meta.ui.resourceUri, UI_URI);
  assert.deepEqual(primary._meta.ui.visibility, ["model", "app"]);
  assert.ok(tools.some((item) => item.name === "article_review_get_feedback"));
  assert.ok(tools.some((item) => item.name === "article_review_create" && /deprecated/i.test(item.title)));
  assert.deepEqual(tools.find((item) => item.name === "article_review_set_patch_decision")._meta.ui.visibility, ["app"]);
});

test("localhost viewer serves topic UI and accepts filtered tool calls", async (t) => {
  const s = await service(t);
  const review = await s.submitPatchSet(patchReview("A\n", {
    patches: [{ id: "p", operation: "replace", target: { oldText: "A" }, newText: "B", comments: [rationale("architecture", "Architecture change.")] }]
  }));
  const server = await startViewer(s, { port: 0, token: null });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${baseUrl}/?session=${review.sessionId}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Topics load with a review|topicbar/);

  const response = await fetch(`${baseUrl}/api/tool`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "article_review_get_page",
      arguments: { sessionId: review.sessionId, topicId: "architecture", contextMode: "hide_unrelated" }
    })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.structuredContent.page.items.length, 1);
  assert.equal(result.structuredContent.page.items[0].matchesTopic, true);
});

test("real stdio MCP flow submits categorized patches, retrieves feedback, and reads the app", async (t) => {
  const workspace = await root(t);
  const projectRoot = path.resolve(".");
  const child = spawn(process.execPath, [path.resolve("src/cli.mjs"), "--stdio", "--workspace", workspace], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(() => child.kill("SIGTERM"));

  let buffer = "";
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) waiters.shift()?.(JSON.parse(line));
    }
  });
  const receive = () => new Promise((resolve, reject) => {
    waiters.push(resolve);
    setTimeout(() => reject(new Error("MCP timeout")), 5_000);
  });
  const send = (id, method, params = {}) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return receive();
  };

  const initialized = await send(1, "initialize", { protocolVersion: "2025-11-25" });
  assert.equal(initialized.result.serverInfo.name, "article-review-mcp");
  assert.equal(initialized.result.serverInfo.version, "1.1.0");

  const listed = await send(2, "tools/list");
  assert.ok(listed.result.tools.some((item) => item.name === "article_review_submit_patchset" && item._meta.ui.resourceUri === UI_URI));

  const created = (await send(3, "tools/call", {
    name: "article_review_submit_patchset",
    arguments: patchReview("A\n", {
      id: "stdio",
      patches: [{ id: "p", operation: "replace", target: { oldText: "A" }, newText: "B", comments: [rationale("architecture", "Make the architecture explicit.")] }]
    })
  })).result.structuredContent;
  assert.equal(created.counts.total, 1);
  assert.equal(created.topicStats.find((item) => item.topicId === "architecture").commentCount, 1);

  const feedback = (await send(4, "tools/call", {
    name: "article_review_get_feedback",
    arguments: { sessionId: created.sessionId, topicId: "architecture", statuses: ["pending"] }
  })).result.structuredContent;
  assert.equal(feedback.actionablePatches[0].patchId, "p");

  const resource = await send(5, "resources/read", { uri: UI_URI });
  assert.equal(resource.result.contents[0].mimeType, UI_MIME);
});
