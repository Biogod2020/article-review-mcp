import { createServer as createHttpServer } from "node:http";
import { URL } from "node:url";
import { uiHtml, UI_MIME, UI_URI } from "./ui.mjs";
import { ConflictError } from "./service.mjs";

const source = { oneOf: [
  { type: "object", required: ["type", "content"], properties: { type: { const: "inline" }, content: { type: "string" } } },
  { type: "object", required: ["type", "path"], properties: { type: { const: "workspace_file" }, path: { type: "string" } } }
] };
const mutation = { sessionId: { type: "string" }, expectedVersion: { type: "integer" }, idempotencyKey: { type: "string" } };
const linked = { ui: { resourceUri: UI_URI, visibility: ["model", "app"] } };
const appOnly = { ui: { resourceUri: UI_URI, visibility: ["app"] } };

export const tools = [
  { name: "article_review_create", title: "Create article review", description: "Create a visual human-reviewable diff. Use this instead of printing a giant textual diff in chat.", inputSchema: { type: "object", required: ["title", "base", "proposal"], properties: { title: { type: "string" }, format: { enum: ["markdown", "plaintext", "latex"] }, base: source, proposal: source, locale: { type: "string" }, initialPageSize: { type: "integer", minimum: 1, maximum: 100 } } }, _meta: linked },
  { name: "article_review_open", title: "Open article review", description: "Open an existing visual article review.", inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" }, query: { type: "string" }, status: { enum: ["all", "pending", "accepted", "rejected", "edited"] } } }, _meta: linked },
  { name: "article_review_get_summary", title: "Get review summary", description: "Return compact rejected/pending hunks for an editing agent without returning the complete manuscript.", inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" } } }, _meta: { ui: { visibility: ["model", "app"] } } },
  { name: "article_review_update_proposal", title: "Update article proposal", description: "Create an immutable next review round and carry decisions only for exact unchanged hunks.", inputSchema: { type: "object", required: ["sessionId", "expectedVersion", "proposal"], properties: { sessionId: { type: "string" }, expectedVersion: { type: "integer" }, proposal: source, locale: { type: "string" }, carryDecisions: { enum: ["exact_match_only", "none"] } } }, _meta: linked },
  { name: "article_review_finalize", title: "Finalize reviewed article", description: "Preview or safely write the reviewed article. Overwrite requires confirmation, hash checking, and backup.", inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" }, mode: { enum: ["preview", "write_new_file", "overwrite_source", "export_static_html"] }, destination: { type: "string" }, pendingPolicy: { enum: ["proposal", "base"] }, confirmOverwrite: { type: "boolean" }, expectedBaseHash: { type: "string" }, backup: { type: "boolean" } } }, _meta: { ui: { visibility: ["model", "app"] } } },
  { name: "article_review_get_page", title: "Get review page", description: "Load filtered review hunks.", inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" }, query: { type: "string" }, status: { enum: ["all", "pending", "accepted", "rejected", "edited"] } } }, _meta: appOnly },
  { name: "article_review_set_decision", title: "Set hunk decision", description: "Accept, reject, or reset one change.", inputSchema: { type: "object", required: ["sessionId", "hunkId", "status", "expectedVersion", "idempotencyKey"], properties: { ...mutation, hunkId: { type: "string" }, status: { enum: ["pending", "accepted", "rejected"] } } }, _meta: appOnly },
  { name: "article_review_bulk_decide", title: "Bulk decide hunks", description: "Accept, reject, or reset all or selected changes.", inputSchema: { type: "object", required: ["sessionId", "status", "expectedVersion", "idempotencyKey"], properties: { ...mutation, status: { enum: ["pending", "accepted", "rejected"] }, hunkIds: { type: "array", items: { type: "string" } } } }, _meta: appOnly },
  { name: "article_review_edit_hunk", title: "Edit review hunk", description: "Save a human-authored replacement for one change.", inputSchema: { type: "object", required: ["sessionId", "hunkId", "editedText", "expectedVersion", "idempotencyKey"], properties: { ...mutation, hunkId: { type: "string" }, editedText: { type: "string" } } }, _meta: appOnly },
  { name: "article_review_add_comment", title: "Add review comment", description: "Attach a reviewer comment to a change.", inputSchema: { type: "object", required: ["sessionId", "body", "expectedVersion", "idempotencyKey"], properties: { ...mutation, hunkId: { type: "string" }, anchorQuote: { type: "string" }, author: { type: "object" }, category: { type: "string" }, body: { type: "string" }, implementationReply: { type: "string" } } }, _meta: appOnly }
];

function result(text, structuredContent) { return { content: [{ type: "text", text }], structuredContent }; }
function failure(error) { return { isError: true, content: [{ type: "text", text: `${error.code || "REVIEW_ERROR"}: ${error.message}` }], structuredContent: { error: { code: error.code || "REVIEW_ERROR", message: error.message, currentVersion: error instanceof ConflictError ? error.currentVersion : undefined } } }; }

export function handler(service, { viewerBase = null, viewerToken = null } = {}) {
  const link = (id) => { if (!viewerBase) return null; const url = new URL("/", viewerBase); url.searchParams.set("session", id); url.searchParams.set("standalone", "1"); if (viewerToken) url.searchParams.set("token", viewerToken); return url.toString(); };
  return async (name, args = {}) => {
    try {
      if (name === "article_review_create") { const data = await service.create(args); const url = link(data.sessionId); return result(`Created ${data.sessionId} with ${data.counts.total} changes.${url ? ` Open ${url}` : ""}`, { ...data, viewerUrl: url }); }
      if (name === "article_review_open") { const data = await service.open(args.sessionId, args); const url = link(data.sessionId); return result(`Opened ${data.sessionId}.`, { ...data, viewerUrl: url }); }
      if (name === "article_review_get_page") { const data = await service.getPage(args); return result(`Loaded ${data.page.items.length} hunks.`, data); }
      if (name === "article_review_set_decision") { const data = await service.decision(args); return result(`Set ${args.hunkId} to ${args.status}.`, data); }
      if (name === "article_review_bulk_decide") { const data = await service.bulk(args); return result(`Applied ${args.status} in bulk.`, data); }
      if (name === "article_review_edit_hunk") { const data = await service.edit(args); return result(`Edited ${args.hunkId}.`, data); }
      if (name === "article_review_add_comment") { const data = await service.comment(args); return result("Added reviewer comment.", data); }
      if (name === "article_review_get_summary") { const data = await service.summary(args.sessionId); return result(`Review has ${data.counts.pending} pending and ${data.counts.rejected} rejected changes.`, data); }
      if (name === "article_review_update_proposal") { const data = await service.updateProposal(args); return result(`Created revision round ${data.roundId}.`, data); }
      if (name === "article_review_finalize") { const data = await service.finalize(args); return result(data.path ? `Wrote ${data.path}.` : `Preview ready: ${data.characters} characters.`, data); }
      throw new Error(`Unknown tool ${name}`);
    } catch (error) { return failure(error); }
  };
}

export class StdioMcpServer {
  constructor(service, options = {}) { this.call = handler(service, options); this.buffer = ""; }
  send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
  async dispatch(message) {
    if (message.method?.startsWith("notifications/")) return;
    const id = message.id;
    try {
      let output;
      if (message.method === "initialize") output = { protocolVersion: message.params?.protocolVersion || "2025-11-25", capabilities: { tools: {}, resources: {}, experimental: { "io.modelcontextprotocol/ui": { protocolVersion: "2026-01-26" } } }, serverInfo: { name: "article-review-mcp", version: "1.0.0" }, instructions: "Use article_review_create after proposing article edits." };
      else if (message.method === "ping") output = {};
      else if (message.method === "tools/list") output = { tools };
      else if (message.method === "tools/call") output = await this.call(message.params?.name, message.params?.arguments || {});
      else if (message.method === "resources/list") output = { resources: [{ uri: UI_URI, name: "Article Review App", description: "Interactive article change review", mimeType: UI_MIME }] };
      else if (message.method === "resources/read" && message.params?.uri === UI_URI) output = { contents: [{ uri: UI_URI, mimeType: UI_MIME, text: uiHtml(), _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] }, prefersBorder: true } } }] };
      else throw Object.assign(new Error(`Method not found: ${message.method}`), { rpc: -32601 });
      this.send({ jsonrpc: "2.0", id, result: output });
    } catch (error) { this.send({ jsonrpc: "2.0", id, error: { code: error.rpc || -32603, message: error.message } }); }
  }
  start() {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { this.buffer += chunk; while (this.buffer.includes("\n")) { const index = this.buffer.indexOf("\n"); const line = this.buffer.slice(0, index).replace(/\r$/, ""); this.buffer = this.buffer.slice(index + 1); if (!line.trim()) continue; try { this.dispatch(JSON.parse(line)); } catch (error) { this.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } }); } } });
  }
}

async function readJson(request) { let body = ""; for await (const chunk of request) { body += chunk; if (body.length > 2_500_000) throw new Error("Body too large"); } return body ? JSON.parse(body) : {}; }
function json(response, status, value) { const body = JSON.stringify(value); response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(body); }

export function startViewer(service, { port = 4173, token = null } = {}) {
  const call = handler(service, { viewerBase: `http://127.0.0.1:${port}`, viewerToken: token });
  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
      if (token && url.searchParams.get("token") !== token && request.headers.authorization !== `Bearer ${token}`) { json(response, 401, { error: "Unauthorized" }); return; }
      if (request.method === "GET" && url.pathname === "/") { const sessionId = url.searchParams.get("session"); const bootstrap = sessionId ? await service.open(sessionId) : null; const body = uiHtml({ bootstrap, standalone: true }); response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; frame-ancestors 'none'" }); response.end(body); return; }
      if (request.method === "POST" && url.pathname === "/api/tool") { const input = await readJson(request); const output = await call(input.name, input.arguments); json(response, output.isError ? 400 : 200, output); return; }
      if (request.method === "GET" && url.pathname === "/health") { json(response, 200, { ok: true }); return; }
      json(response, 404, { error: "Not found" });
    } catch (error) { json(response, 500, { error: error.message }); }
  });
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
}
