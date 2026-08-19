import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { timestamp } from "./service-utils.mjs";

export class ReviewStorageService {
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
    if (!/^[\w-]{8,100}$/.test(sessionId)) throw new Error("Invalid session ID");
    return path.join(this.dataRoot, "sessions", `${sessionId}.json`);
  }

  async atomic(file, text) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  }

  async read(sessionId) {
    const file = this.file(sessionId);
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error("Session file may not be a symlink");
    const session = JSON.parse(await readFile(file, "utf8"));
    if (!["1.0", "1.1"].includes(session.schemaVersion)) throw new Error(`Unsupported session schema ${session.schemaVersion}`);
    return session;
  }

  async save(session) {
    session.updatedAt = timestamp();
    await this.atomic(this.file(session.id), `${JSON.stringify(session, null, 2)}\n`);
  }

  async serial(sessionId, operation) {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.queues.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(sessionId) === current) this.queues.delete(sessionId);
    }
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
    if (typeof relative !== "string" || !relative) throw new Error("A workspace-relative path is required");
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
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
    if (exists) {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Source must be a regular file");
    }
    return target;
  }
}
