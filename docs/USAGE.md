# Article Review MCP usage

## Recommended workflow

```text
1. Agent reads the unchanged source article.
2. Agent plans edits without modifying the source file.
3. Agent emits explicit patches against that source.
4. Each patch includes categorized rationale comments.
5. Agent calls article_review_submit_patchset.
6. Human reviews one topic at a time.
7. Agent retrieves rejected/pending feedback by topic.
8. Agent submits a new immutable patch round.
9. Human finalizes the accepted result.
```

The complete proposal is a server-derived value. It is not the primary input.

## Start the server

```bash
node src/cli.mjs --stdio --workspace /path/to/writing-workspace
```

The workspace is the only directory from which the server may read or write manuscript files.

## Submit a patch set

Use `article_review_submit_patchset` with:

- `base`: inline text or a workspace-relative file
- optional `baseHash`
- optional custom `topics`
- `patchSet.id`
- `patchSet.summary`
- one or more patches

Each patch requires:

- stable `id`
- `operation`
- `target.oldText`
- `newText` except for deletion
- at least one comment

Each comment requires:

- exactly one `topicId`
- `body`

Recommended comment metadata:

- `kind: proposal_rationale`
- `title`
- `severity`
- `tags`
- `author`

## Anchor resolution

The server first finds every exact occurrence of `target.oldText` in the immutable base document.

Optional disambiguators are adjacent exact context:

```json
{
  "oldText": "Repeated sentence.",
  "contextBefore": "The preceding unique paragraph.\n\n",
  "contextAfter": "\n\nThe following unique paragraph."
}
```

`expectedStart` may also be supplied, but textual context is preferred because it is easier to audit.

The server never guesses between multiple matches.

## Topic review modes

The UI defaults to `dim_unrelated`:

- all patches remain visible
- patches without the selected topic are faded
- only comments from the selected topic appear in the right panel
- keyboard navigation moves through relevant patches

Switch to `hide_unrelated` to display only patches carrying comments from the selected topic.

## Human decisions

A patch can be:

```text
pending
accepted
rejected
edited
```

The Final view displays the complete assembled document, including unchanged text.

Pending patches use the proposed text by default. Finalization may instead set:

```json
{ "pendingPolicy": "base" }
```

## Agent feedback loop

Retrieve compact feedback using:

```json
{
  "sessionId": "review_...",
  "topicId": "architecture",
  "statuses": ["pending", "rejected"],
  "includeComments": true
}
```

with `article_review_get_feedback`.

The response contains patch excerpts and comments for the selected topic, but not the complete manuscript.

## Submit a revised round

Use `article_review_update_patchset` with:

- `sessionId`
- current `expectedVersion`
- a unique `idempotencyKey`
- new `patchSet`
- optional `baseHash`

All rounds continue to target the original base document.

With `carryDecisions: exact_match_only`:

- an exactly unchanged patch carries its decision
- human/reviewer comments carry forward
- the new round's proposal-rationale comments replace the old round's rationales
- a changed patch resets to pending

Topic IDs cannot be removed in later rounds, because prior review comments may depend on them. Labels may be changed and new topics may be added.

## Finalization

Preview:

```json
{
  "sessionId": "review_...",
  "mode": "preview"
}
```

Write a new file:

```json
{
  "sessionId": "review_...",
  "mode": "write_new_file",
  "destination": "outputs/manuscript.reviewed.md"
}
```

Overwrite an existing source only with all safeguards:

```json
{
  "sessionId": "review_...",
  "mode": "overwrite_source",
  "destination": "manuscript.md",
  "confirmOverwrite": true,
  "backup": true,
  "expectedBaseHash": "sha256-of-current-file"
}
```

## Viewer fallback

```bash
node src/cli.mjs --viewer 4173 --workspace /path/to/writing-workspace
```

The server binds to `127.0.0.1`. A random access token is enabled unless `--no-viewer-token` is supplied.

## Validation

```bash
npm run check
```
