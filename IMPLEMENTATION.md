# Implemented architecture

`article-review-mcp` is a patch-review control plane rather than an LLM provider.

## Primary data flow

```text
Editing agent
    │ unchanged base + PatchSet + categorized comments
    ▼
Patch validation
    ├── base SHA-256
    ├── exact anchor resolution
    ├── context disambiguation
    ├── topic validation
    └── overlap rejection
    ▼
Canonical patch round
    ├── server-derived offsets
    ├── derived proposal document
    ├── lossless raw segments
    └── proposal-rationale comments
    ▼
MCP App / localhost viewer
    ├── topic tabs
    ├── dim or hide unrelated patches
    ├── split / unified / final views
    ├── accept / reject / edit
    └── review comments / replies / resolution
    ▼
Deterministic final assembly
```

## Core invariants

- The immutable base is the coordinate system for every patch.
- Every patch carries at least one categorized comment.
- Every comment has one primary topic.
- The server derives the proposal by applying validated patches.
- The base and proposal are reconstructed byte-for-byte from raw segments.
- CRLF, whitespace, Chinese, English, Markdown, and basic LaTeX are not normalized.
- Patch conflicts are rejected instead of heuristically merged.
- Exact unchanged patches may carry decisions and human comments across revision rounds.
- Changed patches reset to pending.

## Storage

Sessions are stored under:

```text
.article-review/sessions/<session-id>.json
```

Review mutations are serialized per session and protected by:

```text
expectedVersion
idempotencyKey
```

## UI security

- Manuscript and comment content use text nodes and `textContent`.
- Bootstrap JSON escapes `<` to prevent closing the script element.
- The MCP App declares no external network or resource domains.
- The localhost viewer uses a restrictive CSP and token authentication.

## File security

- Reads and writes are confined to the configured workspace.
- Absolute paths and `..` traversal are rejected.
- Directory symlink escape is rejected after `realpath` resolution.
- New output files are not overwritten.
- Source overwrite requires confirmation, SHA-256 verification, and backup.

## Compatibility

Version 1.1 makes `article_review_submit_patchset` the primary workflow. The version 1.0 full-document tools remain as deprecated aliases so existing integrations continue to function while migrating.

## Verification

```bash
npm run check
```

The suite covers:

- all four patch operations
- exact base/proposal reconstruction
- ambiguous anchors and context disambiguation
- base-hash mismatch
- overlap rejection
- required comments and topic validation
- topic-filtered pages and feedback
- decisions, manual edits, concurrency, and idempotency
- comment replies and resolution
- revision-round carry-over
- legacy compatibility
- traversal and symlink escape
- XSS-safe self-contained MCP App
- localhost viewer
- real stdio MCP JSON-RPC flow
