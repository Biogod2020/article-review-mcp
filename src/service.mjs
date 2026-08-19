import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { assemble, buildSegments, semanticPatchKey } from "./diff.mjs";
import { PatchValidationError, normalizeTopics } from "./patches.mjs";
import { clone, sha256, timestamp, ConflictError } from "./service-utils.mjs";
import { ReviewMutationService } from "./service-mutations.mjs";

export { ConflictError } from "./service-utils.mjs";

export class ReviewService extends ReviewMutationService {
  mergeExactCarryOver(oldRound, newRound, carryDecisions) {
    if (carryDecisions === "none") return;
    const oldByKey = new Map(this.changes(oldRound).map((segment) => [semanticPatchKey(segment), segment]));
    for (const segment of this.changes(newRound)) {
      const prior = oldByKey.get(semanticPatchKey(segment));
      if (!prior) continue;
      segment.decision = clone(prior.decision);
      const carriedReviewComments = (prior.comments ?? []).filter((comment) => comment.kind !== "proposal_rationale");
      const existing = new Set((segment.comments ?? []).map((comment) => comment.id));
      for (const comment of carriedReviewComments) if (!existing.has(comment.id)) segment.comments.push(clone(comment));
    }
  }

  async updatePatchSet(input) {
    return this.serial(input.sessionId, async () => {
      const session = await this.read(input.sessionId);
      if (!this.check(session, input)) return this.view(session, input);
      const oldRound = this.active(session);
      if (input.baseHash && input.baseHash !== oldRound.baseHash) {
        throw new PatchValidationError("BASE_HASH_MISMATCH", "The supplied baseHash does not match the session base document", {
          expectedBaseHash: input.baseHash,
          actualBaseHash: oldRound.baseHash
        });
      }
      const existingTopics = this.topicsFor(session);
      const topics = input.topics ? normalizeTopics(input.topics) : existingTopics;
      if (input.topics) {
        const nextIds = new Set(topics.map((topic) => topic.id));
        const removed = existingTopics.filter((topic) => !nextIds.has(topic.id));
        if (removed.length) {
          throw new PatchValidationError("TOPIC_REMOVAL_FORBIDDEN", `A revision round may add or relabel topics but cannot remove existing topic IDs: ${removed.map((topic) => topic.id).join(", ")}`);
        }
      }
      const roundId = `round_${randomUUID().replaceAll("-", "")}`;
      const newRound = this.createRoundFromPatchSet(oldRound.baseText, topics, input.patchSet, { locale: input.locale, roundId });
      this.mergeExactCarryOver(oldRound, newRound, input.carryDecisions ?? "exact_match_only");
      session.topics = topics;
      session.rounds.push(newRound);
      session.activeRoundId = roundId;
      this.finish(session, input.idempotencyKey);
      await this.save(session);
      return this.view(session, input);
    });
  }

  async updateProposalLegacy(input) {
    return this.serial(input.sessionId, async () => {
      const session = await this.read(input.sessionId);
      if (Number(input.expectedVersion) !== session.version) throw new ConflictError(session.version);
      const oldRound = this.active(session);
      const proposalText = await this.source(input.proposal, "proposal");
      const roundId = `round_${randomUUID().replaceAll("-", "")}`;
      const segments = buildSegments(oldRound.baseText, proposalText, { roundId, locale: input.locale });
      const newRound = {
        id: roundId,
        patchSetId: `legacy_${randomUUID().replaceAll("-", "")}`,
        summary: "Legacy full-document proposal",
        baseText: oldRound.baseText,
        proposalText,
        baseHash: oldRound.baseHash,
        proposalHash: sha256(proposalText),
        patches: [],
        segments,
        createdAt: timestamp()
      };
      this.mergeExactCarryOver(oldRound, newRound, input.carryDecisions ?? "exact_match_only");
      session.rounds.push(newRound);
      session.activeRoundId = roundId;
      session.version += 1;
      await this.save(session);
      return this.view(session, input);
    });
  }

  async document(input) {
    const session = await this.read(input.sessionId);
    const content = assemble(this.active(session).segments, input.pendingPolicy === "base" ? "base" : "proposal");
    return { sessionId: session.id, version: session.version, content, sha256: sha256(content), characters: content.length };
  }

  async finalize(input) {
    const session = await this.read(input.sessionId);
    const round = this.active(session);
    const content = assemble(round.segments, input.pendingPolicy === "base" ? "base" : "proposal");
    const result = { sessionId: session.id, version: session.version, sha256: sha256(content), characters: content.length };
    if (!input.mode || input.mode === "preview") return { ...result, content };
    if (!input.destination) throw new Error("destination is required for this finalize mode");
    const target = await this.safePath(input.destination, { html: input.mode === "export_static_html" });

    if (input.mode === "write_new_file" || input.mode === "export_static_html") {
      try {
        await access(target, fsConstants.F_OK);
        throw new Error("Destination already exists");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    } else if (input.mode === "overwrite_source") {
      if (input.confirmOverwrite !== true || input.backup !== true) throw new Error("Overwrite requires confirmation and backup");
      const existing = await readFile(target, "utf8");
      if (sha256(existing) !== input.expectedBaseHash) throw new Error("Source hash changed");
      const backupPath = `${target}.bak`;
      try {
        await access(backupPath, fsConstants.F_OK);
        throw new Error("Backup destination already exists");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await this.atomic(backupPath, existing);
    } else {
      throw new Error("Unknown finalize mode");
    }

    const output = input.mode === "export_static_html"
      ? `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(session.title)}</title><style>body{max-width:900px;margin:40px auto;padding:0 20px;font:16px/1.65 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>${escapeHtml(session.title)}</h1><pre id="article"></pre><script>document.getElementById("article").textContent=${JSON.stringify(content).replaceAll("<", "\\u003c")}</script></body></html>`
      : content;
    await this.atomic(target, output);
    return { ...result, path: path.relative(this.workspaceRoot, target) };
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}
