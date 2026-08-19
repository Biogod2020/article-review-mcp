import { normalizeComment } from "./patches.mjs";
import { ReviewViewService } from "./service-review.mjs";

export class ReviewMutationService extends ReviewViewService {
  async decision(input) {
    return this.serial(input.sessionId, async () => {
      const session = await this.read(input.sessionId);
      if (!this.check(session, input)) return this.view(session, input);
      if (!["pending", "accepted", "rejected"].includes(input.status)) throw new Error("Invalid decision");
      this.hunk(session, input.patchId ?? input.hunkId).decision = { status: input.status };
      this.finish(session, input.idempotencyKey);
      await this.save(session);
      return this.view(session, input);
    });
  }

  async edit(input) {
    return this.serial(input.sessionId, async () => {
      const session = await this.read(input.sessionId);
      if (!this.check(session, input)) return this.view(session, input);
      if (typeof input.editedText !== "string") throw new Error("editedText must be a string");
      this.hunk(session, input.patchId ?? input.hunkId).decision = { status: "edited", editedText: input.editedText };
      this.finish(session, input.idempotencyKey);
      await this.save(session);
      return this.view(session, input);
    });
  }

  async bulk(input) {
    return this.serial(input.sessionId, async () => {
      const session = await this.read(input.sessionId);
      if (!this.check(session, input)) return this.view(session, input);
      if (!["pending", "accepted", "rejected"].includes(input.status)) throw new Error("Invalid decision");
      const selected = Array.isArray(input.patchIds ?? input.hunkIds) ? new Set(input.patchIds ?? input.hunkIds) : null;
      for (const segment of this.changes(this.active(session))) {
        if (!selected || selected.has(segment.id)) segment.decision = { status: input.status };
      }
      this.finish(session, input.idempotencyKey);
      await this.save(session);
      return this.view(session, input);
    });
  }

  buildReviewComment(session, input, patchId, index = 0) {
    return normalizeComment({
      ...input,
      kind: input.kind ?? "review_comment",
      author: input.author ?? { id: "human-reviewer", name: "Human reviewer", role: "human" }
    }, { patchId, topicIds: this.topicIds(session), index, defaultKind: "review_comment" });
  }

  async comment(input) {
    return this.serial(input.sessionId, async () => {
      const session = await this.read(input.sessionId);
      if (!this.check(session, input)) return this.view(session, input);
      let hunk = input.patchId || input.hunkId ? this.hunk(session, input.patchId ?? input.hunkId) : null;
      if (!hunk && input.anchorQuote) {
        const matches = this.changes(this.active(session)).filter((segment) => `${segment.beforeText}\n${segment.afterText}`.includes(input.anchorQuote));
        if (matches.length !== 1) throw new Error(`Comment anchor resolved to ${matches.length} patches`);
        hunk = matches[0];
      }
      if (!hunk) throw new Error("A patchId or uniquely resolving anchorQuote is required");
      const comment = this.buildReviewComment(session, input, hunk.id, hunk.comments.length);
      if (this.changes(this.active(session)).some((segment) => (segment.comments ?? []).some((item) => item.id === comment.id))) {
        throw new Error(`Duplicate comment ID ${comment.id}`);
      }
      hunk.comments.push(comment);
      this.finish(session, input.idempotencyKey);
      await this.save(session);
      return this.view(session, input);
    });
  }

  async addComments(input) {
    return this.serial(input.sessionId, async () => {
      const session = await this.read(input.sessionId);
      if (!this.check(session, input)) return this.view(session, input);
      if (!Array.isArray(input.comments) || input.comments.length === 0) throw new Error("comments must be a non-empty array");
      const existingIds = new Set(this.changes(this.active(session)).flatMap((segment) => (segment.comments ?? []).map((comment) => comment.id)));
      for (let index = 0; index < input.comments.length; index += 1) {
        const item = input.comments[index];
        const hunk = this.hunk(session, item.patchId ?? item.hunkId);
        const comment = this.buildReviewComment(session, item, hunk.id, hunk.comments.length + index);
        if (existingIds.has(comment.id)) throw new Error(`Duplicate comment ID ${comment.id}`);
        existingIds.add(comment.id);
        hunk.comments.push(comment);
      }
      this.finish(session, input.idempotencyKey);
      await this.save(session);
      return this.view(session, input);
    });
  }

  async replyComment(input) {
    return this.serial(input.sessionId, async () => {
      const session = await this.read(input.sessionId);
      if (!this.check(session, input)) return this.view(session, input);
      const { comment } = this.findComment(session, input.commentId);
      comment.implementationReply = String(input.implementationReply ?? "").trim();
      if (!comment.implementationReply) throw new Error("implementationReply is required");
      this.finish(session, input.idempotencyKey);
      await this.save(session);
      return this.view(session, input);
    });
  }

  async resolveComment(input) {
    return this.serial(input.sessionId, async () => {
      const session = await this.read(input.sessionId);
      if (!this.check(session, input)) return this.view(session, input);
      const { comment } = this.findComment(session, input.commentId);
      comment.resolved = input.resolved !== false;
      this.finish(session, input.idempotencyKey);
      await this.save(session);
      return this.view(session, input);
    });
  }

  async feedback(input) {
    const session = await this.read(input.sessionId);
    const round = this.active(session);
    const statuses = Array.isArray(input.statuses) && input.statuses.length ? new Set(input.statuses) : new Set(["pending", "rejected"]);
    const topicId = input.topicId ?? "all";
    if (topicId !== "all" && !this.topicIds(session).has(topicId)) throw new Error(`Unknown topic ${topicId}`);
    const actionablePatches = this.changes(round).filter((segment) => statuses.has(segment.decision.status)).filter((segment) => topicId === "all" || (segment.comments ?? []).some((comment) => comment.topicId === topicId)).map((segment) => {
      const comments = (segment.comments ?? []).filter((comment) => topicId === "all" || comment.topicId === topicId);
      return {
        patchId: segment.id,
        operation: segment.operation,
        status: segment.decision.status,
        sectionPath: segment.sectionPath,
        before: segment.beforeText.slice(0, 300),
        after: segment.afterText.slice(0, 300),
        comments: input.includeComments === false ? undefined : comments.map((comment) => ({
          id: comment.id,
          topicId: comment.topicId,
          kind: comment.kind,
          title: comment.title,
          body: comment.body.slice(0, 400),
          severity: comment.severity,
          implementationReply: comment.implementationReply,
          resolved: comment.resolved
        }))
      };
    });
    return {
      schemaVersion: "1.1",
      sessionId: session.id,
      roundId: round.id,
      version: session.version,
      topicId,
      counts: this.counts(round),
      topicStats: this.topicStats(session, round),
      actionablePatches
    };
  }

  async summary(sessionId) {
    return this.feedback({ sessionId, statuses: ["pending", "rejected"], topicId: "all", includeComments: true });
  }
}
