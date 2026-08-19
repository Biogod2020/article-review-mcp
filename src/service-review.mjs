import { randomUUID } from "node:crypto";
import { buildPatchSegments, buildSegments } from "./diff.mjs";
import { DEFAULT_TOPICS, PatchValidationError, canonicalizePatchSet, normalizeTopics } from "./patches.mjs";
import { clone, sha256, timestamp, ConflictError } from "./service-utils.mjs";
import { ReviewStorageService } from "./service-storage.mjs";

export class ReviewViewService extends ReviewStorageService {
  active(session) {
    const round = session.rounds.find((item) => item.id === session.activeRoundId);
    if (!round) throw new Error("Active round missing");
    return round;
  }

  changes(round) {
    return round.segments.filter((segment) => segment.type === "change");
  }

  counts(round) {
    const result = { total: 0, pending: 0, accepted: 0, rejected: 0, edited: 0 };
    for (const segment of this.changes(round)) {
      result.total += 1;
      result[segment.decision.status] += 1;
    }
    return result;
  }

  topicsFor(session) {
    return Array.isArray(session.topics) && session.topics.length ? session.topics : clone(DEFAULT_TOPICS);
  }

  topicStats(session, round) {
    const stats = Object.fromEntries(this.topicsFor(session).map((topic) => [topic.id, {
      topicId: topic.id,
      label: topic.label,
      commentCount: 0,
      patchCount: 0,
      unresolvedCount: 0
    }]));
    for (const segment of this.changes(round)) {
      const seen = new Set();
      for (const comment of segment.comments ?? []) {
        if (!stats[comment.topicId]) continue;
        stats[comment.topicId].commentCount += 1;
        if (!comment.resolved) stats[comment.topicId].unresolvedCount += 1;
        seen.add(comment.topicId);
      }
      for (const topicId of seen) stats[topicId].patchCount += 1;
    }
    return Object.values(stats);
  }

  view(session, {
    offset = 0,
    limit = 30,
    query = "",
    status = "all",
    topicId = "all",
    contextMode = "dim_unrelated"
  } = {}) {
    const round = this.active(session);
    const topics = this.topicsFor(session);
    if (topicId !== "all" && !topics.some((topic) => topic.id === topicId)) throw new Error(`Unknown topic ${topicId}`);
    if (!['dim_unrelated', 'hide_unrelated'].includes(contextMode)) throw new Error("Invalid contextMode");

    const needle = String(query).toLowerCase();
    let changes = this.changes(round).map((segment) => {
      const matchesTopic = topicId === "all" || (segment.comments ?? []).some((comment) => comment.topicId === topicId);
      return { ...segment, matchesTopic };
    });
    changes = changes.filter((segment) => status === "all" || segment.decision.status === status);
    changes = changes.filter((segment) => !needle || [
      segment.beforeText,
      segment.afterText,
      segment.sectionPath.join(" "),
      ...(segment.comments ?? []).flatMap((comment) => [comment.title, comment.body, comment.implementationReply, ...(comment.tags ?? [])])
    ].join(" ").toLowerCase().includes(needle));
    if (topicId !== "all" && contextMode === "hide_unrelated") changes = changes.filter((segment) => segment.matchesTopic);

    const start = Math.max(0, Number(offset) || 0);
    const size = Math.max(1, Math.min(Number(limit) || 30, 100));
    const allComments = this.changes(round).flatMap((segment) => segment.comments ?? []);
    return {
      schemaVersion: "1.1",
      sessionId: session.id,
      roundId: round.id,
      title: session.title,
      format: session.format,
      version: session.version,
      baseHash: round.baseHash,
      proposalHash: round.proposalHash,
      patchSet: { id: round.patchSetId, summary: round.summary ?? "" },
      counts: this.counts(round),
      topics,
      topicStats: this.topicStats(session, round),
      activeFilters: { topicId, contextMode, status, query: String(query) },
      unresolvedComments: allComments.filter((comment) => !comment.resolved).length,
      page: {
        items: changes.slice(start, start + size),
        offset: start,
        limit: size,
        total: changes.length,
        hasMore: start + size < changes.length
      }
    };
  }

  createRoundFromPatchSet(baseText, topics, patchSetInput, { locale, roundId }) {
    const patchSet = canonicalizePatchSet(baseText, patchSetInput, topics);
    const built = buildPatchSegments(baseText, patchSet.patches, { locale, roundId });
    return {
      id: roundId,
      patchSetId: patchSet.id,
      summary: patchSet.summary,
      baseText,
      proposalText: built.proposalText,
      baseHash: sha256(baseText),
      proposalHash: sha256(built.proposalText),
      patches: patchSet.patches,
      segments: built.segments,
      createdAt: timestamp()
    };
  }

  async submitPatchSet(input) {
    const baseText = await this.source(input.base, "base");
    const baseHash = sha256(baseText);
    if (input.baseHash && input.baseHash !== baseHash) {
      throw new PatchValidationError("BASE_HASH_MISMATCH", "The supplied baseHash does not match the base document", {
        expectedBaseHash: input.baseHash,
        actualBaseHash: baseHash
      });
    }
    const topics = normalizeTopics(input.topics);
    const id = `review_${randomUUID().replaceAll("-", "")}`;
    const roundId = `round_${randomUUID().replaceAll("-", "")}`;
    const now = timestamp();
    const round = this.createRoundFromPatchSet(baseText, topics, input.patchSet, { locale: input.locale, roundId });
    const session = {
      schemaVersion: "1.1",
      id,
      title: String(input.title || "Article review"),
      format: input.format || "markdown",
      status: "open",
      version: 1,
      topics,
      activeRoundId: roundId,
      rounds: [round],
      idempotencyKeys: [],
      createdAt: now,
      updatedAt: now
    };
    await this.save(session);
    return this.view(session, { limit: input.initialPageSize });
  }

  async createLegacy(input) {
    const [baseText, proposalText] = await Promise.all([
      this.source(input.base, "base"),
      this.source(input.proposal, "proposal")
    ]);
    const id = `review_${randomUUID().replaceAll("-", "")}`;
    const roundId = `round_${randomUUID().replaceAll("-", "")}`;
    const now = timestamp();
    const round = {
      id: roundId,
      patchSetId: `legacy_${randomUUID().replaceAll("-", "")}`,
      summary: "Legacy full-document proposal",
      baseText,
      proposalText,
      baseHash: sha256(baseText),
      proposalHash: sha256(proposalText),
      patches: [],
      segments: buildSegments(baseText, proposalText, { roundId, locale: input.locale }),
      createdAt: now
    };
    const session = {
      schemaVersion: "1.1",
      id,
      title: String(input.title || "Article review"),
      format: input.format || "markdown",
      status: "open",
      version: 1,
      topics: normalizeTopics(input.topics),
      activeRoundId: roundId,
      rounds: [round],
      idempotencyKeys: [],
      createdAt: now,
      updatedAt: now
    };
    await this.save(session);
    return this.view(session, { limit: input.initialPageSize });
  }

  async open(sessionId, options = {}) {
    return this.view(await this.read(sessionId), options);
  }

  async getPage(input) {
    return this.open(input.sessionId, input);
  }

  check(session, input) {
    if (Number(input.expectedVersion) !== session.version) throw new ConflictError(session.version);
    if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey) throw new Error("idempotencyKey is required");
    return !session.idempotencyKeys.includes(input.idempotencyKey);
  }

  finish(session, key) {
    session.idempotencyKeys.push(key);
    if (session.idempotencyKeys.length > 500) session.idempotencyKeys.splice(0, session.idempotencyKeys.length - 500);
    session.version += 1;
  }

  hunk(session, patchId) {
    const hunk = this.changes(this.active(session)).find((segment) => segment.id === patchId || segment.patchId === patchId);
    if (!hunk) throw new Error(`Unknown patch ${patchId}`);
    return hunk;
  }

  topicIds(session) {
    return new Set(this.topicsFor(session).map((topic) => topic.id));
  }

  findComment(session, commentId) {
    for (const segment of this.changes(this.active(session))) {
      const comment = (segment.comments ?? []).find((item) => item.id === commentId);
      if (comment) return { segment, comment };
    }
    throw new Error(`Unknown comment ${commentId}`);
  }
}
