# article-review-mcp

A visual MCP App for reviewing **explicit article patches with categorized comments**.

The editing agent does not hand the server a silently rewritten manuscript. It submits:

```text
unchanged base document
+ explicit patches against that base
+ one or more categorized rationale comments per patch
```

The server validates and applies those patches deterministically, opens an interactive review UI, records human decisions, and safely assembles the final article.

## Why patch-first

A full-document diff can show *what* changed, but it loses the agent's original intent. In this project, a patch is the atomic review object:

```text
Patch
├── exact target in the original document
├── replace / delete / insert_before / insert_after
├── proposed text
├── categorized comments explaining why
└── human decision: pending / accepted / rejected / edited
```

Every comment has exactly one primary `topicId`. A patch may contain multiple comments across different topics.

## Current capabilities

- Explicit `PatchSet` submission against an immutable base document
- `replace`, `delete`, `insert_before`, and `insert_after`
- Base SHA-256 verification
- Exact-anchor resolution with optional `contextBefore` and `contextAfter`
- Rejection of ambiguous anchors and overlapping patches
- Required categorized rationale comments for every patch
- Custom topic taxonomies per review session
- Topic tabs with per-topic patch/comment counts
- Two topic review modes:
  - keep all patches visible and dim unrelated patches
  - show only patches containing the selected topic
- Split, unified, and complete Final views
- Word-level insertion/deletion highlighting for English and Chinese
- Accept, reject, reset, manually edit, and bulk-decide visible patches
- Add, reply to, resolve, and filter reviewer comments
- Compact topic-filtered feedback for the editing agent
- Immutable revision rounds with exact-patch decision carry-over
- JSON persistence, optimistic concurrency, and idempotency
- MCP App plus token-protected localhost browser viewer
- Safe preview, write-new-file, guarded overwrite, and static HTML export
- Legacy `base + full proposal` tools retained as deprecated compatibility aliases

## Requirements

- Node.js 20 or newer
- No runtime dependency installation is required

## Validate

```bash
npm run check
```

The suite runs syntax checks and 13 tests, including a real stdio MCP exchange and localhost viewer calls.

## Run as an MCP server

```bash
node src/cli.mjs \
  --stdio \
  --workspace /absolute/path/to/your/writing-workspace
```

Example client configuration:

```json
{
  "mcpServers": {
    "article-review": {
      "command": "node",
      "args": [
        "/absolute/path/to/article-review-mcp/src/cli.mjs",
        "--stdio",
        "--workspace",
        "/absolute/path/to/your/writing-workspace"
      ]
    }
  }
}
```

## Primary agent call

Call `article_review_submit_patchset`:

```json
{
  "title": "Introduction revision",
  "format": "markdown",
  "base": {
    "type": "workspace_file",
    "path": "manuscript.md"
  },
  "baseHash": "optional-sha256-of-the-base",
  "topics": [
    {
      "id": "architecture",
      "label": "架构与叙事",
      "description": "章节组织、研究主线和段落衔接"
    },
    {
      "id": "logic",
      "label": "逻辑与论证"
    },
    {
      "id": "clarity",
      "label": "表达与清晰度"
    }
  ],
  "patchSet": {
    "id": "revision-001",
    "summary": "补齐 Section 1 到 Section 2 的理论过渡",
    "patches": [
      {
        "id": "selection-pressure-bridge",
        "operation": "replace",
        "target": {
          "oldText": "The later experiments therefore held the candidate text fixed...",
          "contextBefore": "These results support Prediction 1...",
          "contextAfter": "LLM judge reliability varies..."
        },
        "newText": "Collectively, Section 1 establishes that...",
        "comments": [
          {
            "topicId": "architecture",
            "kind": "proposal_rationale",
            "title": "补齐 Section 1 → Section 2 的逻辑桥梁",
            "body": "原文从多智能体失败直接跳到 Judge reliability，缺少为什么需要 Judge 的理论过渡。",
            "severity": "major"
          },
          {
            "topicId": "logic",
            "kind": "proposal_rationale",
            "title": "明确研究问题递进关系",
            "body": "先证明系统存在选择失败，再验证 Judge 是否能够提供可靠信号。"
          }
        ]
      }
    ]
  }
}
```

### Patch rules

- All patches target the same unchanged base document.
- Every patch must include at least one categorized comment.
- Every comment has one and only one primary `topicId`.
- `target.oldText` must resolve to exactly one location.
- Use `contextBefore` and `contextAfter` when the same text appears repeatedly.
- Overlapping patches and multiple insertions at an unsafe shared boundary are rejected.
- The server derives the proposal; the agent does not submit a second complete manuscript in the primary workflow.

Typical validation errors:

```text
BASE_HASH_MISMATCH
ANCHOR_NOT_FOUND
ANCHOR_AMBIGUOUS
PATCH_OVERLAP
MISSING_PATCH_COMMENT
UNKNOWN_COMMENT_TOPIC
```

## Topic-focused review

The UI shows topic tabs such as:

```text
全部主题 12
架构与叙事 4
逻辑与论证 3
证据与引用 2
方法与统计 1
表达与清晰度 2
```

Selecting one topic filters the right-side comments to that topic. The manuscript pane can either:

- retain all patches and dim unrelated ones, or
- hide unrelated patches completely.

`J` and `K` navigate only the patches relevant to the active topic.

## Local viewer fallback

For clients that do not render MCP Apps:

```bash
node src/cli.mjs \
  --viewer 4173 \
  --workspace /absolute/path/to/your/writing-workspace
```

The viewer binds to `127.0.0.1` and prints a random token-protected URL.

Synthetic demo:

```bash
npm run demo
```

## Main tools

Model-facing workflow:

```text
article_review_submit_patchset
article_review_open
article_review_get_feedback
article_review_add_comments
article_review_update_patchset
article_review_finalize
```

App-only review operations:

```text
article_review_get_page
article_review_get_document
article_review_set_patch_decision
article_review_bulk_decide
article_review_edit_patch
article_review_add_comment
article_review_reply_comment
article_review_resolve_comment
```

Deprecated compatibility aliases:

```text
article_review_create
article_review_get_summary
article_review_update_proposal
article_review_set_decision
article_review_edit_hunk
```

## Safety invariants

- The base document is reconstructed byte-for-byte from raw segments.
- Applying every patch reconstructs the derived proposal byte-for-byte.
- CRLF, whitespace, Markdown, Chinese, English, and basic LaTeX are not normalized.
- Manuscript text is rendered as inert text nodes, never through `innerHTML`.
- Absolute paths, `..` traversal, and directory symlink escape are rejected.
- Mutations require `expectedVersion` and `idempotencyKey`.
- Source overwrite requires explicit confirmation, source SHA-256 validation, and a backup.

## Documentation

- [Usage and workflow](docs/USAGE.md)
- [PatchSet protocol](docs/PATCHSET_SCHEMA.md)
- [Editing-agent prompt](docs/AGENT_PROMPT.md)
- [Implemented architecture](IMPLEMENTATION.md)

## Deferred scope

- DOCX Track Changes
- PDF editing
- Word-level partial acceptance
- Real-time multi-user collaboration
- Google Docs synchronization
