import { readFileSync } from "node:fs";

export const UI_URI = "ui://article-review/review.html";
export const UI_MIME = "text/html;profile=mcp-app";

const read = (name) => readFileSync(new URL(`./ui/${name}`, import.meta.url), "utf8");
const TEMPLATE = [read("head.html"), read("app-1.js"), read("app-2.js"), read("app-3.js"), read("tail.html")].join("");
const INITIAL_TOKEN = "__ARTICLE_REVIEW_INITIAL_87f6__";
const STANDALONE_TOKEN = "__ARTICLE_REVIEW_STANDALONE_87f6__";

export function uiHtml({ bootstrap = null, standalone = false } = {}) {
  const initial = JSON.stringify(bootstrap).replaceAll("<", "\\u003c");
  return TEMPLATE
    .replace(STANDALONE_TOKEN, standalone ? "true" : "false")
    .replace(INITIAL_TOKEN, initial);
}
