# Implemented system

`article-review-mcp` is an article-edit review control plane rather than an LLM provider. The external agent proposes text; the MCP server owns deterministic diffing, versioned review state, visualization, human decisions, comments, and safe final assembly.

## Architecture

```text
Writing agent
    │ article_review_create / update_proposal
    ▼
MCP stdio server ───── ui://article-review/review.html
    │                               │
    │                       split/unified/final UI
    │                               │
    ├── lossless diff               ├── accept/reject/edit
    ├── JSON persistence            ├── comments
    ├── version + idempotency        └── keyboard navigation
    └── safe final assembly
```

A localhost HTTP viewer uses the same service and UI for clients that do not render MCP Apps.

## Important properties

- Base and proposal are reconstructed from raw segments byte-for-byte.
- CRLF, whitespace, Chinese, English, Markdown, and basic LaTeX are not normalized.
- The UI renders article content only as text nodes.
- MCP App linkage uses `_meta.ui.resourceUri` and `text/html;profile=mcp-app`.
- Review writes are serialized per session and guarded with `expectedVersion` and `idempotencyKey`.
- Workspace paths reject absolute paths, `..` traversal, and directory symlink escape.
- Source overwrite is disabled by default and requires confirmation, SHA-256 validation, and backup.

## Verification

Run:

```bash
npm run check
```

The test suite includes a real stdio JSON-RPC exchange that initializes the MCP server, lists tools, creates a review, accepts a hunk through an app-only tool, and reads the MCP App resource. It also exercises the localhost viewer and mutating HTTP API.
