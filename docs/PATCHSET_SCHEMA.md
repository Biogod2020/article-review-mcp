# PatchSet protocol

## Design principle

The immutable base document is the coordinate system for every patch in every revision round.

```text
base + accepted/edited/pending patches = assembled document
base + rejected patches               = unchanged regions
```

Patches never target the output of another patch.

## Top-level submission

```ts
type SubmitPatchSet = {
  title: string;
  format?: "markdown" | "plaintext" | "latex";
  base: SourceRef;
  baseHash?: string;
  topics?: Topic[];
  patchSet: PatchSet;
  locale?: string;
  initialPageSize?: number;
};
```

## Topics

```ts
type Topic = {
  id: string;
  label: string;
  description?: string;
};
```

Topic IDs must be unique. A comment references exactly one topic.

The default taxonomy is:

```text
architecture  架构与叙事
logic         逻辑与论证
evidence      证据与引用
methods       方法与统计
clarity       表达与清晰度
other         其他
```

## PatchSet

```ts
type PatchSet = {
  id?: string;
  summary?: string;
  patches: Patch[];
};
```

## Patch

```ts
type Patch = {
  id?: string;
  operation: "replace" | "delete" | "insert_before" | "insert_after";
  target: {
    oldText: string;
    contextBefore?: string;
    contextAfter?: string;
    expectedStart?: number;
  };
  newText?: string;
  comments: PatchComment[];
};
```

`newText` is required for all operations except `delete`.

## Comment

```ts
type PatchComment = {
  id?: string;
  topicId: string;
  kind?: "proposal_rationale" | "review_comment" | "implementation_reply";
  title?: string;
  body: string;
  severity?: "suggestion" | "minor" | "major" | "critical";
  tags?: string[];
  author?: {
    id?: string;
    name?: string;
    role?: string;
  };
  replyTo?: string;
  implementationReply?: string;
  resolved?: boolean;
};
```

Initial agent comments should normally use `proposal_rationale`.

## Canonicalization

The server converts each patch to:

```ts
type CanonicalPatch = Patch & {
  id: string;
  start: number;
  end: number;
  beforeText: string;
  afterText: string;
};
```

The canonical offsets are server-derived and audited against the base document.

## Conflict policy

The entire PatchSet is rejected when:

- a target has no exact match
- a target has multiple matches after context filtering
- two replacement/deletion ranges overlap
- an insertion sits inside or directly on an edited range boundary
- multiple insertions share an unsafe position
- a patch lacks categorized comments
- a comment references an unknown topic

The server does not silently merge or reorder conflicting intent.

## Error response

```json
{
  "error": {
    "code": "ANCHOR_AMBIGUOUS",
    "message": "Patch section-bridge target matched 3 locations; provide contextBefore/contextAfter",
    "patchId": "section-bridge",
    "candidateCount": 3,
    "candidates": [1024, 3840, 9122]
  }
}
```
