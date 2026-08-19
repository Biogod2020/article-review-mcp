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
let demoSessionId = null;

if (process.argv.includes("--demo")) {
  const review = await service.submitPatchSet({
    title: "Synthetic Categorized Patch Review",
    format: "markdown",
    locale: "en-US",
    base: {
      type: "inline",
      content: "# Candidate selection\n\nA model produces one answer and reports it directly.\n\nThe experiment measures final accuracy.\n"
    },
    topics: [
      { id: "architecture", label: "Architecture & narrative" },
      { id: "methods", label: "Methods & statistics" },
      { id: "clarity", label: "Clarity" }
    ],
    patchSet: {
      id: "demo-revision-1",
      summary: "Clarify the selection pipeline and evaluation design.",
      patches: [
        {
          id: "selection-pipeline",
          operation: "replace",
          target: { oldText: "A model produces one answer and reports it directly." },
          newText: "A model produces several candidate answers, and a verifier ranks them before terminal selection.",
          comments: [
            {
              topicId: "architecture",
              kind: "proposal_rationale",
              title: "Expose the missing selection stage",
              body: "The original sentence collapses generation and terminal selection into one operation.",
              severity: "major"
            },
            {
              topicId: "clarity",
              kind: "proposal_rationale",
              title: "Name each system component",
              body: "The revision makes candidate generation, verification, and terminal selection explicit."
            }
          ]
        },
        {
          id: "evaluation-detail",
          operation: "insert_after",
          target: { oldText: "The experiment measures final accuracy." },
          newText: " Candidate availability and judge ranking reliability are also reported.",
          comments: [
            {
              topicId: "methods",
              kind: "proposal_rationale",
              title: "Separate intermediate bottlenecks",
              body: "Final accuracy alone cannot identify whether generation, recognition, or selection failed.",
              severity: "major"
            }
          ]
        }
      ]
    }
  });
  demoSessionId = review.sessionId;
  process.stderr.write(`Demo session: ${review.sessionId}\n`);
}

if (process.argv.includes("--viewer") || process.argv.includes("--demo")) {
  const port = Number(valueAfter("--viewer", "4173"));
  const token = process.argv.includes("--no-viewer-token") ? null : randomBytes(24).toString("base64url");
  await startViewer(service, { port, token });
  const query = new URLSearchParams();
  if (demoSessionId) query.set("session", demoSessionId);
  if (token) query.set("token", token);
  process.stderr.write(`Article Review viewer: http://127.0.0.1:${port}/${query.size ? `?${query.toString()}` : ""}\n`);
  if (!process.argv.includes("--stdio")) await new Promise(() => {});
}

if (process.argv.includes("--stdio") || (!process.argv.includes("--viewer") && !process.argv.includes("--demo"))) {
  new StdioMcpServer(service).start();
}
