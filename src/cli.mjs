#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import path from "node:path";
import { ReviewService } from "./service.mjs";
import { StdioMcpServer, startViewer } from "./server.mjs";

const valueAfter = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const workspaceRoot = path.resolve(valueAfter("--workspace", process.cwd()));
const service = await new ReviewService({ workspaceRoot }).init();

if (process.argv.includes("--demo")) {
  const review = await service.create({
    title: "Synthetic Article Review Demo",
    format: "markdown",
    base: { type: "inline", content: "# Candidate selection\n\nA model produces one answer and reports it directly.\n" },
    proposal: { type: "inline", content: "# Candidate selection\n\nA model produces several candidate answers, and a verifier ranks them before terminal selection.\n" }
  });
  process.stderr.write(`Demo session: ${review.sessionId}\n`);
}

if (process.argv.includes("--viewer") || process.argv.includes("--demo")) {
  const port = Number(valueAfter("--viewer", "4173"));
  const token = process.argv.includes("--no-viewer-token") ? null : randomBytes(24).toString("base64url");
  await startViewer(service, { port, token });
  process.stderr.write(`Article Review viewer: http://127.0.0.1:${port}/${token ? `?token=${encodeURIComponent(token)}` : ""}\n`);
  if (!process.argv.includes("--stdio")) await new Promise(() => {});
}

if (process.argv.includes("--stdio") || (!process.argv.includes("--viewer") && !process.argv.includes("--demo"))) {
  new StdioMcpServer(service).start();
}
