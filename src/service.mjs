import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, lstat, realpath, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { assemble, buildSegments } from "./diff.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const timestamp = () => new Date().toISOString();

export class ConflictError extends Error {
  constructor(version) { super(`Version conflict; current version is ${version}`); this.code = "VERSION_CONFLICT"; this.currentVersion = version; }
}

export class ReviewService {
  constructor({ workspaceRoot = process.cwd(), dataDir = ".article-review" } = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.dataRoot = path.resolve(this.workspaceRoot, dataDir);
    if (!this.dataRoot.startsWith(`${this.workspaceRoot}${path.sep}`)) throw new Error("dataDir escapes workspace");
    this.queues = new Map();
  }

  async init() {
    await mkdir(path.join(this.dataRoot, "sessions"), { recursive: true });
    const [workspace, data] = await Promise.all([realpath(this.workspaceRoot), realpath(this.dataRoot)]);
    if (!data.startsWith(`${workspace}${path.sep}`)) throw new Error("Data directory escapes workspace through a symlink");
    return this;
  }

  file(sessionId) {
    if (!/^[\w-]{8,90}$/.test(sessionId)) throw new Error("Invalid session ID");
    return path.join(this.dataRoot, "sessions", `${sessionId}.json`);
  }

  async atomic(file, text) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  }

  async read(sessionId) {
    const file = this.file(sessionId);
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error("Session file may not be a symlink");
    return JSON.parse(await readFile(file, "utf8"));
  }

  async save(session) {
    session.updatedAt = timestamp();
    await this.atomic(this.file(session.id), `${JSON.stringify(session, null, 2)}\n`);
  }

  async serial(sessionId, operation) {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.queues.set(sessionId, current);
    try { return await current; } finally { if (this.queues.get(sessionId) === current) this.queues.delete(sessionId); }
  }

  async source(value, label) {
    if (!value || typeof value !== "object") throw new Error(`${label} is required`);
    if (value.type === "inline") {
      if (typeof value.content !== "string") throw new Error(`${label}.content must be a string`);
      if (value.content.length > 2_000_000) throw new Error(`${label} is too large`);
      return value.content;
    }
    if (value.type !== "workspace_file" || typeof value.path !== "string") throw new Error(`${label} must be inline or workspace_file`);
    return readFile(await this.safePath(value.path, { exists: true }), "utf8");
  }

  async safePath(relative, { exists = false, html = false } = {}) {
    if (path.isAbsolute(relative)) throw new Error("Absolute paths are forbidden");
    const normalized = path.normalize(relative);
    if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new Error("Path traversal is forbidden");
    const target = path.resolve(this.workspaceRoot, normalized);
    if (!target.startsWith(`${this.workspaceRoot}${path.sep}`)) throw new Error("Path escapes workspace");
    const extensions = html ? [".html"] : [".md", ".markdown", ".txt", ".tex"];
    if (!extensions.includes(path.extname(target).toLowerCase())) throw new Error("Unsupported output extension");
    const root = await realpath(this.workspaceRoot);
    let ancestor = exists ? target : path.dirname(target);
    while (true) {
      try {
        const resolved = await realpath(ancestor);
        if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) throw new Error("Path escapes workspace through a symlink");
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        ancestor = path.dirname(ancestor);
      }
    }
    if (exists) {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Source must be a regular file");
    }
    return target;
  }

  active(session) {
    const round = session.rounds.find((item) => item.id === session.activeRoundId);
    if (!round) throw new Error("Active round missing");
    return round;
  }

  counts(round) {
    const out = { total: 0, pending: 0, accepted: 0, rejected: 0, edited: 0 };
    for (const segment of round.segments) if (segment.type === "change") { out.total += 1; out[segment.decision.status] += 1; }
    return out;
  }

  view(session, { offset = 0, limit = 30, query = "", status = "all" } = {}) {
    const round = this.active(session);
    const needle = String(query).toLowerCase();
    const changes = round.segments.filter((segment) => segment.type === "change").filter((segment) => status === "all" || segment.decision.status === status).filter((segment) => !needle || [segment.beforeText, segment.afterText, segment.sectionPath.join(" "), ...segment.comments.map((comment) => comment.body)].join(" ").toLowerCase().includes(needle));
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.max(1, Math.min(Number(limit) || 30, 100));
    return {
      schemaVersion: "1.0",
      sessionId: session.id,
      roundId: round.id,
      title: session.title,
      format: session.format,
      version: session.version,
      counts: this.counts(round),
      unresolvedComments: changes.flatMap((segment) => segment.comments).filter((comment) => !comment.resolved).length,
      page: { items: changes.slice(start, start + size), offset: start, limit: size, total: changes.length, hasMore: start + size < changes.length }
    };
  }

  async create(input) {
    const [baseText, proposalText] = await Promise.all([this.source(input.base, "base"), this.source(input.proposal, "proposal")]);
    const id = `review_${randomUUID().replaceAll("-", "")}`;
    const roundId = `round_${randomUUID().replaceAll("-", "")}`;
    const now = timestamp();
    const session = {
      schemaVersion: "1.0", id, title: String(input.title || "Article review"), format: input.format || "markdown", status: "open", version: 1, activeRoundId: roundId,
      rounds: [{ id: roundId, baseText, proposalText, baseHash: sha256(baseText), proposalHash: sha256(proposalText), segments: buildSegments(baseText, proposalText, { roundId, locale: input.locale }), createdAt: now }],
      idempotencyKeys: [], createdAt: now, updatedAt: now
    };
    await this.save(session);
    return this.view(session, { limit: input.initialPageSize });
  }

  async open(sessionId, options = {}) { return this.view(await this.read(sessionId), options); }
  async getPage(input) { return this.open(input.sessionId, input); }

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

  hunk(session, hunkId) {
    const hunk = this.active(session).segments.find((segment) => segment.type === "change" && segment.id === hunkId);
    if (!hunk) throw new Error(`Unknown hunk ${hunkId}`);
    return hunk;
  }

  async decision(input) {
    return this.serial(input.sessionId, async () => {
      const session = await this.read(input.sessionId);
      if (!this.check(session, input)) return this.view(session);
      if (!["pending", "accepted", "rejected"].includes(input.status)) throw new Error("Invalid decision");
      this.hunk(session, input.hunkId).decision = { status: input.status };
      this.finish(session, input.idempotencyKey);
      await this.save(session);
      return this.view(session);
    });
  }

  async edit(input) {
    return this.serial(input.sessionId, async () => {
      const session = await this.read(input.sessionId);
      if (!this.check(session, input)) return this.view(session);
      if (typeof input.editedText !== "string") throw new Error("editedText must be a string");
      this.hunk(session, input.hunkId).decision = { status: "edited", editedText: input.editedText };
      this.finish(session, input.idempotencyKey);
      await this.save(session);
      return this.view(session);
    });
  }

  async bulk(input) {
    return this.serial(input.sessionId, async () => {
      const session = await this.read(input.sessionId);
      if (!this.check(session, input)) return this.view(session);
      const selected = Array.isArray(input.hunkIds) ? new Set(input.hunkIds) : null;
      for (const segment of this.active(session).segments) if (segment.type === "change" && (!selected || selected.has(segment.id))) segment.decision = { status: input.status };
      this.finish(session, input.idempotencyKey);
      await this.save(session);
      return this.view(session);
    });
  }

  async comment(input) {
    return this.serial(input.sessionId, async () => {
      const session = await this.read(input.sessionId);
      if (!this.check(session, input)) return this.view(session);
      const hunk = input.hunkId ? this.hunk(session, input.hunkId) : this.active(session).segments.find((segment) => segment.type === "change" && input.anchorQuote && `${segment.beforeText}\n${segment.afterText}`.includes(input.anchorQuote));
      if (!hunk) throw new Error("Comment anchor did not resolve to one hunk");
      hunk.comments.push({ id: `comment_${randomUUID().replaceAll("-", "")}`, author: input.author || { id: "reviewer", name: "Reviewer", role: "reviewer" }, category: input.category || "other", body: String(input.body || ""), anchorQuote: input.anchorQuote || null, implementationReply: input.implementationReply || null, resolved: false, createdAt: timestamp() });
      this.finish(session, input.idempotencyKey);
      await this.save(session);
      return this.view(session);
    });
  }

  async summary(sessionId) {
    const session = await this.read(sessionId);
    const round = this.active(session);
    return { sessionId, roundId: round.id, version: session.version, counts: this.counts(round), actionableHunks: round.segments.filter((segment) => segment.type === "change" && ["pending", "rejected"].includes(segment.decision.status)).map((segment) => ({ id: segment.id, status: segment.decision.status, sectionPath: segment.sectionPath, before: segment.beforeText.slice(0, 180), after: segment.afterText.slice(0, 180), comments: segment.comments.filter((comment) => !comment.resolved).map((comment) => comment.body.slice(0, 180)) })) };
  }

  async updateProposal(input) {
    return this.serial(input.sessionId, async () => {
      const session = await this.read(input.sessionId);
      if (Number(input.expectedVersion) !== session.version) throw new ConflictError(session.version);
      const old = this.active(session);
      const proposalText = await this.source(input.proposal, "proposal");
      const roundId = `round_${randomUUID().replaceAll("-", "")}`;
      const segments = buildSegments(old.baseText, proposalText, { roundId, locale: input.locale });
      const prior = new Map(old.segments.filter((segment) => segment.type === "change").map((segment) => [`${segment.beforeText}\0${segment.afterText}`, segment.decision]));
      if (input.carryDecisions !== "none") for (const segment of segments) if (segment.type === "change" && prior.has(`${segment.beforeText}\0${segment.afterText}`)) segment.decision = structuredClone(prior.get(`${segment.beforeText}\0${segment.afterText}`));
      session.rounds.push({ id: roundId, baseText: old.baseText, proposalText, baseHash: old.baseHash, proposalHash: sha256(proposalText), segments, createdAt: timestamp() });
      session.activeRoundId = roundId;
      session.version += 1;
      await this.save(session);
      return this.view(session);
    });
  }

  async finalize(input) {
    const session = await this.read(input.sessionId);
    const content = assemble(this.active(session).segments, input.pendingPolicy === "base" ? "base" : "proposal");
    const result = { sessionId: session.id, version: session.version, sha256: sha256(content), characters: content.length };
    if (!input.mode || input.mode === "preview") return { ...result, content };
    const target = await this.safePath(input.destination, { html: input.mode === "export_static_html" });
    if (input.mode === "write_new_file" || input.mode === "export_static_html") {
      try { await access(target, fsConstants.F_OK); throw new Error("Destination already exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    } else if (input.mode === "overwrite_source") {
      if (input.confirmOverwrite !== true || input.backup !== true) throw new Error("Overwrite requires confirmation and backup");
      const existing = await readFile(target, "utf8");
      if (sha256(existing) !== input.expectedBaseHash) throw new Error("Source hash changed");
      await this.atomic(`${target}.bak`, existing);
    } else throw new Error("Unknown finalize mode");
    await mkdir(path.dirname(target), { recursive: true });
    const output = input.mode === "export_static_html" ? `<!doctype html><meta charset="utf-8"><title>Reviewed article</title><pre id="article"></pre><script>article.textContent=${JSON.stringify(content).replaceAll("<", "\\u003c")}</script>` : content;
    await this.atomic(target, output);
    return { ...result, path: path.relative(this.workspaceRoot, target) };
  }
}
