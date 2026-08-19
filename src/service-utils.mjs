import { createHash } from "node:crypto";

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export const timestamp = () => new Date().toISOString();
export const clone = (value) => structuredClone(value);

export class ConflictError extends Error {
  constructor(version) {
    super(`Version conflict; current version is ${version}`);
    this.code = "VERSION_CONFLICT";
    this.currentVersion = version;
  }
}
