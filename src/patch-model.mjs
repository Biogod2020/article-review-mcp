import { createHash, randomUUID } from "node:crypto";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const cleanId = (value, fallback) => {
  const id = String(value ?? fallback);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(id)) throw new PatchValidationError("INVALID_ID", `Invalid identifier: ${id}`);
  return id;
};

export const DEFAULT_TOPICS = Object.freeze([
  { id: "architecture", label: "架构与叙事", description: "章节组织、研究主线和段落衔接" },
  { id: "logic", label: "逻辑与论证", description: "推理链、因果关系和结论支持" },
  { id: "evidence", label: "证据与引用", description: "数据、文献、引用和论断依据" },
  { id: "methods", label: "方法与统计", description: "实验设计、分析方法和统计表达" },
  { id: "clarity", label: "表达与清晰度", description: "语言、术语、歧义和可读性" },
  { id: "other", label: "其他", description: "不属于上述主题的修改" }
]);

export class PatchValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PatchValidationError";
    this.code = code;
    Object.assign(this, details);
  }
}

export function normalizeTopics(input) {
  const source = input == null ? DEFAULT_TOPICS : input;
  if (!Array.isArray(source) || source.length === 0) throw new PatchValidationError("INVALID_TOPICS", "At least one comment topic is required");
  const seen = new Set();
  return source.map((topic, index) => {
    if (!topic || typeof topic !== "object") throw new PatchValidationError("INVALID_TOPICS", `Topic ${index} must be an object`);
    const id = cleanId(topic.id, `topic-${index + 1}`);
    if (seen.has(id)) throw new PatchValidationError("DUPLICATE_TOPIC_ID", `Duplicate topic ID: ${id}`);
    seen.add(id);
    const label = String(topic.label ?? "").trim();
    if (!label) throw new PatchValidationError("INVALID_TOPICS", `Topic ${id} requires a label`);
    return { id, label, description: String(topic.description ?? "") };
  });
}

function normalizeAuthor(author, fallback = "Editing agent") {
  if (!author || typeof author !== "object") return { id: "editing-agent", name: fallback, role: "agent" };
  return {
    id: String(author.id || author.name || "agent").slice(0, 96),
    name: String(author.name || fallback).slice(0, 160),
    role: String(author.role || "agent").slice(0, 80)
  };
}

export function normalizeComment(comment, { patchId, topicIds, index = 0, defaultKind = "proposal_rationale" } = {}) {
  if (!comment || typeof comment !== "object") throw new PatchValidationError("INVALID_COMMENT", `Patch ${patchId} comment ${index} must be an object`, { patchId });
  const topicId = String(comment.topicId ?? "");
  if (!topicIds.has(topicId)) {
    throw new PatchValidationError("UNKNOWN_COMMENT_TOPIC", `Patch ${patchId} comment references unknown topic ${topicId || "<empty>"}`, { patchId, topicId });
  }
  const kind = comment.kind ?? defaultKind;
  if (!["proposal_rationale", "review_comment", "implementation_reply"].includes(kind)) {
    throw new PatchValidationError("INVALID_COMMENT_KIND", `Unsupported comment kind: ${kind}`, { patchId });
  }
  const body = String(comment.body ?? "").trim();
  if (!body) throw new PatchValidationError("EMPTY_COMMENT", `Patch ${patchId} comment ${index} has an empty body`, { patchId });
  const severity = comment.severity ?? "suggestion";
  if (!["suggestion", "minor", "major", "critical"].includes(severity)) {
    throw new PatchValidationError("INVALID_COMMENT_SEVERITY", `Unsupported comment severity: ${severity}`, { patchId });
  }
  return {
    id: cleanId(comment.id, `comment_${hash(`${patchId}\0${index}\0${topicId}\0${body}`).slice(0, 20)}`),
    topicId,
    kind,
    title: String(comment.title ?? "").slice(0, 300),
    body,
    severity,
    tags: Array.isArray(comment.tags) ? comment.tags.map((tag) => String(tag).slice(0, 80)).slice(0, 20) : [],
    author: normalizeAuthor(comment.author),
    replyTo: comment.replyTo ? String(comment.replyTo) : null,
    implementationReply: comment.implementationReply ? String(comment.implementationReply) : null,
    resolved: Boolean(comment.resolved),
    createdAt: comment.createdAt || new Date().toISOString()
  };
}

