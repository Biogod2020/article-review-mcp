# Article Review MCP usage

This repository provides a visual review control plane for article edits. An external LLM proposes the revision; the MCP server computes a deterministic diff, persists review state, renders an MCP App, records human decisions, and safely assembles the final document.

## Validate

```bash
npm run check
```

No runtime dependency installation is required. Node.js 20 or newer is sufficient.

## MCP stdio configuration

Use absolute paths:

```json
{
  "mcpServers": {
    "article-review": {
      "command": "node",
      "args": [
        "/absolute/path/to/article-review-mcp/src/cli.mjs",
        "--stdio",
        "--workspace",
        "/absolute/path/to/writing-workspace"
      ]
    }
  }
}
```

The model should call `article_review_create` with the original article and proposed revision. Compatible hosts render `ui://article-review/review.html`. Other clients receive compact text and structured JSON.

## Local viewer fallback

```bash
node src/cli.mjs --viewer 4173 --workspace /path/to/writing-workspace
```

The process binds only to `127.0.0.1` and prints a random token-protected URL.

## Demo

```bash
npm run demo
```

## Core workflow

1. Keep the source file unchanged.
2. Create a proposal file or inline proposal.
3. Call `article_review_create`.
4. Accept, reject, edit, and comment in the UI.
5. Retrieve compact feedback through `article_review_get_summary`.
6. Submit a new immutable round through `article_review_update_proposal`.
7. Call `article_review_finalize` to preview or write a new file.

## Safety invariants

- Accept-all reconstructs the proposal exactly.
- Reject-all reconstructs the base exactly.
- Raw CRLF, whitespace, Markdown, Chinese, English, and basic LaTeX text are not normalized.
- Article content is rendered with text nodes, never `innerHTML`.
- Absolute paths, `..` traversal, and directory symlink escape are rejected.
- Review mutations require an expected version and idempotency key.
- Overwrite requires explicit confirmation, source SHA-256 validation, and a backup.

## Current scope

Version 1 uses block-level acceptance with word-level visual highlighting. DOCX Track Changes, PDF editing, real-time collaboration, and word-level partial acceptance are intentionally deferred.
