import { defaultUrlTransform, type UrlTransform } from "react-markdown";

import { knowledgeImagePolicy, knowledgeLinkPolicy } from "../../shared/knowledge/markdown.ts";

/** Drops every URL that is not an ordinary web link or a remote https image. */
export const knowledgeUrlTransform: UrlTransform = (value, key) => {
  if (key === "href") return knowledgeLinkPolicy(value) === "external" ? value : "";
  if (key === "src") return knowledgeImagePolicy(value) === "remote" ? value : "";
  return defaultUrlTransform(value);
};
