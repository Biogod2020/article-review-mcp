import { UI_URI } from "./ui.mjs";


export const source = {
  oneOf: [
    {
      type: "object",
      required: ["type", "content"],
      properties: {
        type: { const: "inline" },
        content: { type: "string" },
        label: { type: "string" }
      }
    },
    {
      type: "object",
      required: ["type", "path"],
      properties: {
        type: { const: "workspace_file" },
        path: { type: "string" },
        label: { type: "string" }
      }
    }
  ]
};

export const topic = {
  type: "object",
  required: ["id", "label"],
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    description: { type: "string" }
  }
};

export const author = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    role: { type: "string" }
  }
};

export const comment = {
  type: "object",
  required: ["topicId", "body"],
  properties: {
    id: { type: "string" },
    topicId: { type: "string" },
    kind: { enum: ["proposal_rationale", "review_comment", "implementation_reply"] },
    title: { type: "string" },
    body: { type: "string" },
    severity: { enum: ["suggestion", "minor", "major", "critical"] },
    tags: { type: "array", items: { type: "string" } },
    author,
    replyTo: { type: "string" },
    implementationReply: { type: "string" },
    resolved: { type: "boolean" }
  }
};

export const patch = {
  type: "object",
  required: ["operation", "target", "comments"],
  properties: {
    id: { type: "string" },
    operation: { enum: ["replace", "delete", "insert_before", "insert_after"] },
    target: {
      type: "object",
      required: ["oldText"],
      properties: {
        oldText: { type: "string" },
        contextBefore: { type: "string" },
        contextAfter: { type: "string" },
        expectedStart: { type: "integer" }
      }
    },
    newText: { type: "string" },
    comments: { type: "array", minItems: 1, items: comment }
  }
};

export const patchSet = {
  type: "object",
  required: ["patches"],
  properties: {
    id: { type: "string" },
    summary: { type: "string" },
    patches: { type: "array", minItems: 1, items: patch }
  }
};

export const mutation = {
  sessionId: { type: "string" },
  expectedVersion: { type: "integer" },
  idempotencyKey: { type: "string" }
};

export const filters = {
  offset: { type: "integer", minimum: 0 },
  limit: { type: "integer", minimum: 1, maximum: 100 },
  query: { type: "string" },
  status: { enum: ["all", "pending", "accepted", "rejected", "edited"] },
  topicId: { type: "string" },
  contextMode: { enum: ["dim_unrelated", "hide_unrelated"] }
};

export const linked = { ui: { resourceUri: UI_URI, visibility: ["model", "app"] } };
export const appOnly = { ui: { resourceUri: UI_URI, visibility: ["app"] } };
