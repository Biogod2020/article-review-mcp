import { createServer as createHttpServer } from "node:http";
import { URL } from "node:url";
import { uiHtml, UI_MIME, UI_URI } from "./ui.mjs";
import { ConflictError } from "./service.mjs";
import { tools } from "./tool-definitions.mjs";

export { tools } from "./tool-definitions.mjs";

function result(text, structuredContent) {
  return { content: [{ type: "text", text }], structuredContent };
}

function failure(error) {
  const details = {};
  for (const key of ["patchId", "patchIds", "topicId", "candidateCount", "candidates", "expectedBaseHash", "actualBaseHash"]) {
    if (error[key] !== undefined) details[key] = error[key];
  }
  return {
    isError: true,
    content: [{ type: "text", text: `${error.code || "REVIEW_ERROR"}: ${error.message}` }],
    structuredContent: {
      error: {
        code: error.code || "REVIEW_ERROR",
        message: error.message,
        currentVersion: error instanceof ConflictError ? error.currentVersion : undefined,
        ...details
      }
    }
  };
}

export function handler(service, { viewerBase = null, viewerToken = null } = {}) {
  const link = (sessionId) => {
    if (!viewerBase) return null;
    const url = new URL("/", viewerBase);
    url.searchParams.set("session", sessionId);
    url.searchParams.set("standalone", "1");
    if (viewerToken) url.searchParams.set("token", viewerToken);
    return url.toString();
  };

  return async (name, args = {}) => {
    try {
      if (name === "article_review_submit_patchset") {
        const data = await service.submitPatchSet(args);
        const url = link(data.sessionId);
        return result(`Created ${data.sessionId} from ${data.counts.total} explicit patches across ${data.topics.length} topics.${url ? ` Open ${url}` : ""}`, { ...data, viewerUrl: url });
      }
      if (name === "article_review_create") {
        const data = await service.createLegacy(args);
        const url = link(data.sessionId);
        return result(`Created legacy full-document review ${data.sessionId} with ${data.counts.total} inferred changes.${url ? ` Open ${url}` : ""}`, { ...data, viewerUrl: url });
      }
      if (name === "article_review_open") {
        const data = await service.open(args.sessionId, args);
        const url = link(data.sessionId);
        return result(`Opened ${data.sessionId}.`, { ...data, viewerUrl: url });
      }
      if (name === "article_review_get_page") return result("Loaded filtered patch page.", await service.getPage(args));
      if (name === "article_review_get_document") return result("Loaded assembled document.", await service.document(args));
      if (name === "article_review_set_patch_decision" || name === "article_review_set_decision") {
        const data = await service.decision(args);
        return result(`Set ${args.patchId ?? args.hunkId} to ${args.status}.`, data);
      }
      if (name === "article_review_bulk_decide") return result(`Applied ${args.status} in bulk.`, await service.bulk(args));
      if (name === "article_review_edit_patch" || name === "article_review_edit_hunk") {
        const data = await service.edit(args);
        return result(`Edited ${args.patchId ?? args.hunkId}.`, data);
      }
      if (name === "article_review_add_comment") return result("Added categorized reviewer comment.", await service.comment(args));
      if (name === "article_review_add_comments") return result(`Added ${args.comments?.length ?? 0} categorized reviewer comments.`, await service.addComments(args));
      if (name === "article_review_reply_comment") return result("Recorded implementation reply.", await service.replyComment(args));
      if (name === "article_review_resolve_comment") return result("Updated comment resolution.", await service.resolveComment(args));
      if (name === "article_review_get_feedback") {
        const data = await service.feedback(args);
        return result(`Review feedback contains ${data.actionablePatches.length} actionable patches for topic ${data.topicId}.`, data);
      }
      if (name === "article_review_get_summary") {
        const data = await service.summary(args.sessionId);
        return result(`Review has ${data.counts.pending} pending and ${data.counts.rejected} rejected patches.`, data);
      }
      if (name === "article_review_update_patchset") {
        const data = await service.updatePatchSet(args);
        return result(`Created categorized patch revision round ${data.roundId}.`, data);
      }
      if (name === "article_review_update_proposal") {
        const data = await service.updateProposalLegacy(args);
        return result(`Created legacy full-document revision round ${data.roundId}.`, data);
      }
      if (name === "article_review_finalize") {
        const data = await service.finalize(args);
        return result(data.path ? `Wrote ${data.path}.` : `Preview ready: ${data.characters} characters.`, data);
      }
      throw new Error(`Unknown tool ${name}`);
    } catch (error) {
      return failure(error);
    }
  };
}

export class StdioMcpServer {
  constructor(service, options = {}) {
    this.call = handler(service, options);
    this.buffer = "";
  }

  send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  async dispatch(message) {
    if (message.method?.startsWith("notifications/")) return;
    const id = message.id;
    try {
      let output;
      if (message.method === "initialize") {
        output = {
          protocolVersion: message.params?.protocolVersion || "2025-11-25",
          capabilities: {
            tools: {},
            resources: {},
            experimental: { "io.modelcontextprotocol/ui": { protocolVersion: "2026-01-26" } }
          },
          serverInfo: { name: "article-review-mcp", version: "1.1.0" },
          instructions: "When proposing article edits, call article_review_submit_patchset with the unchanged base, explicit patches, and categorized comments."
        };
      } else if (message.method === "ping") {
        output = {};
      } else if (message.method === "tools/list") {
        output = { tools };
      } else if (message.method === "tools/call") {
        output = await this.call(message.params?.name, message.params?.arguments || {});
      } else if (message.method === "resources/list") {
        output = { resources: [{ uri: UI_URI, name: "Article Review App", description: "Interactive topic-filtered article patch review", mimeType: UI_MIME }] };
      } else if (message.method === "resources/read" && message.params?.uri === UI_URI) {
        output = {
          contents: [{
            uri: UI_URI,
            mimeType: UI_MIME,
            text: uiHtml(),
            _meta: {
              ui: {
                csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
                prefersBorder: true
              }
            }
          }]
        };
      } else {
        throw Object.assign(new Error(`Method not found: ${message.method}`), { rpc: -32601 });
      }
      this.send({ jsonrpc: "2.0", id, result: output });
    } catch (error) {
      this.send({ jsonrpc: "2.0", id, error: { code: error.rpc || -32603, message: error.message } });
    }
  }

  start() {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      this.buffer += chunk;
      while (this.buffer.includes("\n")) {
        const index = this.buffer.indexOf("\n");
        const line = this.buffer.slice(0, index).replace(/\r$/, "");
        this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          this.dispatch(JSON.parse(line));
        } catch (error) {
          this.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } });
        }
      }
    });
  }
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4_000_000) throw new Error("Body too large");
  }
  return body ? JSON.parse(body) : {};
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

export function startViewer(service, { port = 4173, token = null } = {}) {
  const call = handler(service, { viewerBase: `http://127.0.0.1:${port}`, viewerToken: token });
  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
      if (token && url.searchParams.get("token") !== token && request.headers.authorization !== `Bearer ${token}`) {
        json(response, 401, { error: "Unauthorized" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        const sessionId = url.searchParams.get("session");
        const bootstrap = sessionId ? await service.open(sessionId) : null;
        const body = uiHtml({ bootstrap, standalone: true });
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; frame-ancestors 'none'"
        });
        response.end(body);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/tool") {
        const input = await readJson(request);
        const output = await call(input.name, input.arguments);
        json(response, output.isError ? 400 : 200, output);
        return;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { ok: true, version: "1.1.0" });
        return;
      }
      json(response, 404, { error: "Not found" });
    } catch (error) {
      json(response, 500, { error: error.message });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
