import { source, topic, comment, patchSet, mutation, filters, linked, appOnly } from "./tool-schemas.mjs";

export const tools = [
  {
    name: "article_review_submit_patchset",
    title: "Submit categorized article patches",
    description: "Primary article-edit workflow. Submit the unchanged base document plus explicit non-overlapping patches. Every patch must include at least one comment assigned to exactly one primary topic. Use this instead of returning a giant rewritten document or textual diff in chat.",
    inputSchema: {
      type: "object",
      required: ["title", "base", "patchSet"],
      properties: {
        title: { type: "string" },
        format: { enum: ["markdown", "plaintext", "latex"] },
        base: source,
        baseHash: { type: "string" },
        topics: { type: "array", items: topic },
        patchSet,
        locale: { type: "string" },
        initialPageSize: { type: "integer", minimum: 1, maximum: 100 }
      }
    },
    _meta: linked
  },
  {
    name: "article_review_open",
    title: "Open article review",
    description: "Open an existing visual patch review and optionally filter it by comment topic.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: { sessionId: { type: "string" }, ...filters }
    },
    _meta: linked
  },
  {
    name: "article_review_get_feedback",
    title: "Get categorized review feedback",
    description: "Return compact pending or rejected patch feedback for an editing agent. Filter by one comment topic without returning the complete manuscript.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        topicId: { type: "string" },
        statuses: { type: "array", items: { enum: ["pending", "accepted", "rejected", "edited"] } },
        includeComments: { type: "boolean" }
      }
    },
    _meta: { ui: { visibility: ["model", "app"] } }
  },
  {
    name: "article_review_add_comments",
    title: "Add categorized reviewer comments",
    description: "Attach a batch of reviewer comments to existing patches. Each comment must use exactly one primary topicId.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "expectedVersion", "idempotencyKey", "comments"],
      properties: {
        ...mutation,
        comments: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["patchId", "topicId", "body"],
            properties: { patchId: { type: "string" }, ...comment.properties }
          }
        },
        ...filters
      }
    },
    _meta: { ui: { visibility: ["model", "app"] } }
  },
  {
    name: "article_review_update_patchset",
    title: "Submit a revised patch set",
    description: "Create an immutable next review round from the same base document. Exact unchanged patches may carry decisions and reviewer comments; changed patches reset to pending.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "expectedVersion", "idempotencyKey", "patchSet"],
      properties: {
        ...mutation,
        baseHash: { type: "string" },
        topics: { type: "array", items: topic },
        patchSet,
        locale: { type: "string" },
        carryDecisions: { enum: ["exact_match_only", "none"] },
        ...filters
      }
    },
    _meta: linked
  },
  {
    name: "article_review_finalize",
    title: "Finalize reviewed article",
    description: "Preview or safely write the article assembled from accepted, rejected, edited, and pending patches. Overwrite requires confirmation, hash checking, and backup.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        mode: { enum: ["preview", "write_new_file", "overwrite_source", "export_static_html"] },
        destination: { type: "string" },
        pendingPolicy: { enum: ["proposal", "base"] },
        confirmOverwrite: { type: "boolean" },
        expectedBaseHash: { type: "string" },
        backup: { type: "boolean" }
      }
    },
    _meta: { ui: { visibility: ["model", "app"] } }
  },

  {
    name: "article_review_get_page",
    title: "Get filtered patch page",
    description: "Load paginated patches, optionally showing only one comment topic.",
    inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" }, ...filters } },
    _meta: appOnly
  },
  {
    name: "article_review_get_document",
    title: "Get assembled document",
    description: "Load the complete assembled document for the Final view.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: { sessionId: { type: "string" }, pendingPolicy: { enum: ["proposal", "base"] } }
    },
    _meta: appOnly
  },
  {
    name: "article_review_set_patch_decision",
    title: "Set patch decision",
    description: "Accept, reject, or reset one patch.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "patchId", "status", "expectedVersion", "idempotencyKey"],
      properties: { ...mutation, patchId: { type: "string" }, status: { enum: ["pending", "accepted", "rejected"] }, ...filters }
    },
    _meta: appOnly
  },
  {
    name: "article_review_bulk_decide",
    title: "Bulk decide patches",
    description: "Accept, reject, or reset all or selected patches.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "status", "expectedVersion", "idempotencyKey"],
      properties: {
        ...mutation,
        status: { enum: ["pending", "accepted", "rejected"] },
        patchIds: { type: "array", items: { type: "string" } },
        ...filters
      }
    },
    _meta: appOnly
  },
  {
    name: "article_review_edit_patch",
    title: "Edit patch output",
    description: "Save a human-authored replacement for one patch.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "patchId", "editedText", "expectedVersion", "idempotencyKey"],
      properties: { ...mutation, patchId: { type: "string" }, editedText: { type: "string" }, ...filters }
    },
    _meta: appOnly
  },
  {
    name: "article_review_add_comment",
    title: "Add categorized review comment",
    description: "Attach one reviewer comment to a patch under exactly one primary topic.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "patchId", "topicId", "body", "expectedVersion", "idempotencyKey"],
      properties: { ...mutation, patchId: { type: "string" }, ...comment.properties, ...filters }
    },
    _meta: appOnly
  },
  {
    name: "article_review_reply_comment",
    title: "Reply to review comment",
    description: "Record how an editing agent implemented a reviewer comment.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "commentId", "implementationReply", "expectedVersion", "idempotencyKey"],
      properties: { ...mutation, commentId: { type: "string" }, implementationReply: { type: "string" }, ...filters }
    },
    _meta: appOnly
  },
  {
    name: "article_review_resolve_comment",
    title: "Resolve review comment",
    description: "Mark a review comment resolved or unresolved.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "commentId", "expectedVersion", "idempotencyKey"],
      properties: { ...mutation, commentId: { type: "string" }, resolved: { type: "boolean" }, ...filters }
    },
    _meta: appOnly
  },

  {
    name: "article_review_create",
    title: "Create article review from full proposal (deprecated)",
    description: "Compatibility tool for base + complete proposal. Prefer article_review_submit_patchset so every change retains agent intent and categorized comments.",
    inputSchema: {
      type: "object",
      required: ["title", "base", "proposal"],
      properties: {
        title: { type: "string" },
        format: { enum: ["markdown", "plaintext", "latex"] },
        base: source,
        proposal: source,
        topics: { type: "array", items: topic },
        locale: { type: "string" },
        initialPageSize: { type: "integer", minimum: 1, maximum: 100 }
      }
    },
    _meta: linked
  },
  {
    name: "article_review_get_summary",
    title: "Get review summary (deprecated)",
    description: "Compatibility alias for article_review_get_feedback.",
    inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" } } },
    _meta: { ui: { visibility: ["model", "app"] } }
  },
  {
    name: "article_review_update_proposal",
    title: "Update full proposal (deprecated)",
    description: "Compatibility tool for complete revised documents. Prefer article_review_update_patchset.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "expectedVersion", "proposal"],
      properties: {
        sessionId: { type: "string" },
        expectedVersion: { type: "integer" },
        proposal: source,
        locale: { type: "string" },
        carryDecisions: { enum: ["exact_match_only", "none"] },
        ...filters
      }
    },
    _meta: linked
  },
  {
    name: "article_review_set_decision",
    title: "Set hunk decision (deprecated alias)",
    description: "Compatibility alias for article_review_set_patch_decision.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "hunkId", "status", "expectedVersion", "idempotencyKey"],
      properties: { ...mutation, hunkId: { type: "string" }, status: { enum: ["pending", "accepted", "rejected"] }, ...filters }
    },
    _meta: appOnly
  },
  {
    name: "article_review_edit_hunk",
    title: "Edit hunk (deprecated alias)",
    description: "Compatibility alias for article_review_edit_patch.",
    inputSchema: {
      type: "object",
      required: ["sessionId", "hunkId", "editedText", "expectedVersion", "idempotencyKey"],
      properties: { ...mutation, hunkId: { type: "string" }, editedText: { type: "string" }, ...filters }
    },
    _meta: appOnly
  }
];

