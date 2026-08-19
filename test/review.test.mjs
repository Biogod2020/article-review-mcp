import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildSegments, assemble } from "../src/diff.mjs";
import { ConflictError, ReviewService } from "../src/service.mjs";
import { startViewer } from "../src/server.mjs";
import { uiHtml, UI_MIME, UI_URI } from "../src/ui.mjs";

async function root(t) { const value = await mkdtemp(path.join(tmpdir(), "article-review-")); t.after(() => rm(value, { recursive: true, force: true })); return value; }
async function service(t) { return new ReviewService({ workspaceRoot: await root(t) }).init(); }
async function create(s, base, proposal) { return s.create({ title: "Test", base: { type: "inline", content: base }, proposal: { type: "inline", content: proposal } }); }

test("lossless diff preserves Chinese, English, whitespace, and CRLF", () => {
  const base = "# 标题\r\n\r\nOne answer.  \r\n旧结论。\r\n";
  const proposal = "# 标题\r\n\r\nSeveral answers.  \r\n新结论。\r\n";
  const segments = buildSegments(base, proposal, { locale: "zh-CN", roundId: "r" });
  assert.equal(segments.map((x) => x.type === "equal" ? x.baseText : x.beforeText).join(""), base);
  assert.equal(segments.map((x) => x.type === "equal" ? x.proposalText : x.afterText).join(""), proposal);
  for (const x of segments) if (x.type === "change") x.decision = { status: "accepted" };
  assert.equal(assemble(segments), proposal);
  for (const x of segments) if (x.type === "change") x.decision = { status: "rejected" };
  assert.equal(assemble(segments), base);
});

test("persisted accept, reject, and edit assemble exact output", async (t) => {
  const s = await service(t);
  let review = await create(s, "Alpha\n", "Beta\n");
  const hunkId = review.page.items[0].id;
  review = await s.decision({ sessionId: review.sessionId, hunkId, status: "accepted", expectedVersion: review.version, idempotencyKey: "a" });
  assert.equal((await s.finalize({ sessionId: review.sessionId, mode: "preview" })).content, "Beta\n");
  review = await s.decision({ sessionId: review.sessionId, hunkId, status: "rejected", expectedVersion: review.version, idempotencyKey: "r" });
  assert.equal((await s.finalize({ sessionId: review.sessionId, mode: "preview" })).content, "Alpha\n");
  review = await s.edit({ sessionId: review.sessionId, hunkId, editedText: "Gamma\r\n", expectedVersion: review.version, idempotencyKey: "e" });
  assert.equal((await s.finalize({ sessionId: review.sessionId, mode: "preview" })).content, "Gamma\r\n");
});

test("stale versions fail and idempotency keys do not duplicate writes", async (t) => {
  const s = await service(t);
  const review = await create(s, "A\n", "B\n");
  const input = { sessionId: review.sessionId, hunkId: review.page.items[0].id, status: "accepted", expectedVersion: review.version, idempotencyKey: "same" };
  const first = await s.decision(input);
  const second = await s.decision({ ...input, expectedVersion: first.version });
  assert.equal(first.version, second.version);
  await assert.rejects(() => s.decision({ ...input, idempotencyKey: "new" }), ConflictError);
});

test("comments and exact-match decision carry-over work", async (t) => {
  const s = await service(t);
  let review = await create(s, "A\nB\n", "A changed\nB\n");
  review = await s.comment({ sessionId: review.sessionId, hunkId: review.page.items[0].id, body: "Clarify the claim.", author: { id: "reviewer", name: "Reviewer" }, expectedVersion: review.version, idempotencyKey: "c" });
  assert.equal(review.page.items[0].comments.length, 1);
  review = await s.decision({ sessionId: review.sessionId, hunkId: review.page.items[0].id, status: "accepted", expectedVersion: review.version, idempotencyKey: "d" });
  const same = await s.updateProposal({ sessionId: review.sessionId, expectedVersion: review.version, proposal: { type: "inline", content: "A changed\nB\n" } });
  assert.equal(same.page.items[0].decision.status, "accepted");
  const changed = await s.updateProposal({ sessionId: same.sessionId, expectedVersion: same.version, proposal: { type: "inline", content: "A changed again\nB\n" } });
  assert.equal(changed.page.items[0].decision.status, "pending");
});

test("safe output rejects traversal and symlink escape", async (t) => {
  const workspace = await root(t);
  const outside = await root(t);
  await symlink(outside, path.join(workspace, "escape"));
  const s = await new ReviewService({ workspaceRoot: workspace }).init();
  const review = await create(s, "A\n", "B\n");
  await assert.rejects(() => s.finalize({ sessionId: review.sessionId, mode: "write_new_file", destination: "../bad.md" }), /traversal|escapes/i);
  await assert.rejects(() => s.finalize({ sessionId: review.sessionId, mode: "write_new_file", destination: "escape/bad.md" }), /symlink|escapes/i);
  const output = await s.finalize({ sessionId: review.sessionId, mode: "write_new_file", destination: "out/result.md" });
  assert.equal(await readFile(path.join(workspace, output.path), "utf8"), "B\n");
});

test("MCP App is self-contained and never injects article HTML", () => {
  const html = uiHtml();
  assert.equal(UI_URI, "ui://article-review/review.html");
  assert.equal(UI_MIME, "text/html;profile=mcp-app");
  assert.match(html, /ui\/initialize/);
  assert.match(html, /tools\/call/);
  assert.doesNotMatch(html, /innerHTML\s*=/);
  assert.doesNotMatch(html, /dangerouslySetInnerHTML/);
});

test("localhost viewer serves UI and accepts a decision", async (t) => {
  const s = await service(t);
  const review = await create(s, "A\n", "B\n");
  const server = await startViewer(s, { port: 0, token: null });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${base}/?session=${review.sessionId}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Article Review MCP/);
  const response = await fetch(`${base}/api/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "article_review_set_decision", arguments: { sessionId: review.sessionId, hunkId: review.page.items[0].id, status: "accepted", expectedVersion: review.version, idempotencyKey: "viewer" } }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).structuredContent.counts.accepted, 1);
});

test("real stdio MCP flow creates and mutates a review", async (t) => {
  const workspace = await root(t);
  const child = spawn(process.execPath, [path.resolve("src/cli.mjs"), "--stdio", "--workspace", workspace], { cwd: path.resolve("."), stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill("SIGTERM"));
  let buffer = "";
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { buffer += chunk; while (buffer.includes("\n")) { const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.trim()) waiters.shift()?.(JSON.parse(line)); } });
  const receive = () => new Promise((resolve, reject) => { waiters.push(resolve); setTimeout(() => reject(new Error("MCP timeout")), 5000); });
  const send = (id, method, params = {}) => { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); return receive(); };
  assert.equal((await send(1, "initialize", { protocolVersion: "2025-11-25" })).result.serverInfo.name, "article-review-mcp");
  const listed = await send(2, "tools/list");
  assert.ok(listed.result.tools.some((tool) => tool.name === "article_review_create" && tool._meta.ui.resourceUri === UI_URI));
  const created = (await send(3, "tools/call", { name: "article_review_create", arguments: { title: "MCP test", base: { type: "inline", content: "A\n" }, proposal: { type: "inline", content: "B\n" } } })).result.structuredContent;
  assert.equal(created.counts.total, 1);
  const changed = (await send(4, "tools/call", { name: "article_review_set_decision", arguments: { sessionId: created.sessionId, hunkId: created.page.items[0].id, status: "accepted", expectedVersion: created.version, idempotencyKey: "mcp" } })).result.structuredContent;
  assert.equal(changed.counts.accepted, 1);
  const resource = await send(5, "resources/read", { uri: UI_URI });
  assert.equal(resource.result.contents[0].mimeType, UI_MIME);
});
