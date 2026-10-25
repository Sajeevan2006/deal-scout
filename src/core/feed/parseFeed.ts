import { XMLParser } from "fast-xml-parser";
import { consoleLogger } from "../config";
import type { Logger, Post } from "../types";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

// RFD appends this footer to every post body
const STATISTICS_FOOTER = /<p>\s*Statistics:\s*Posted by[\s\S]*?<\/p>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  trade: "™",
  reg: "®",
  copy: "©",
  deg: "°",
  times: "×",
  cent: "¢",
  pound: "£",
  euro: "€",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  agrave: "à",
  acirc: "â",
  ccedil: "ç",
  ocirc: "ô",
  ucirc: "û",
  icirc: "î",
  Eacute: "É",
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (fullMatch: string, entityBody: string) => {
    if (entityBody.startsWith("#x") || entityBody.startsWith("#X")) {
      const codePoint = Number.parseInt(entityBody.slice(2), 16);
      return safeFromCodePoint(codePoint, fullMatch);
    }
    if (entityBody.startsWith("#")) {
      const codePoint = Number.parseInt(entityBody.slice(1), 10);
      return safeFromCodePoint(codePoint, fullMatch);
    }
    const namedValue = NAMED_ENTITIES[entityBody];
    if (namedValue === undefined) {
      return fullMatch;
    }
    return namedValue;
  });
}

function safeFromCodePoint(codePoint: number, fallback: string): string {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return fallback;
  }
  return String.fromCodePoint(codePoint);
}

export function htmlToText(html: string): string {
  const withoutFooter = html.replace(STATISTICS_FOOTER, " ");
  const withoutScripts = withoutFooter.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
  const withoutTags = withoutScripts.replace(/<[^>]*>/g, " ");
  const decoded = decodeHtmlEntities(withoutTags);
  return decoded.replace(/\s+/g, " ").trim();
}

// Single elements come back as objects, repeated ones as arrays
function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(node: unknown): string | null {
  if (typeof node === "string") {
    return node.trim();
  }
  if (typeof node === "number") {
    return String(node);
  }
  if (isRecord(node)) {
    return readText(node["#text"]);
  }
  return null;
}

function readAlternateLink(linkNode: unknown): string | null {
  const links = toArray(linkNode);
  for (const link of links) {
    if (!isRecord(link)) {
      continue;
    }
    const rel = link["@_rel"];
    const href = link["@_href"];
    const isAlternate = rel === undefined || rel === "alternate";
    if (isAlternate && typeof href === "string" && href.length > 0) {
      return href;
    }
  }
  return null;
}

function readAuthor(authorNode: unknown): string | null {
  const firstAuthor = toArray(authorNode)[0];
  if (!isRecord(firstAuthor)) {
    return null;
  }
  return readText(firstAuthor["name"]);
}

function toIsoDate(text: string | null): string | null {
  if (!text) {
    return null;
  }
  const parsedMs = Date.parse(text);
  if (Number.isNaN(parsedMs)) {
    return null;
  }
  return new Date(parsedMs).toISOString();
}

function parseEntry(entry: unknown): Post | string {
  if (!isRecord(entry)) {
    return "entry is not an element";
  }
  const id = readText(entry["id"]);
  if (!id) {
    return "missing <id>";
  }
  const rawTitle = readText(entry["title"]);
  if (!rawTitle) {
    return `missing <title> (id ${id})`;
  }
  const link = readAlternateLink(entry["link"]);
  if (!link) {
    return `missing <link> (id ${id})`;
  }
  let bodyHtml = readText(entry["content"]);
  if (bodyHtml === null) {
    bodyHtml = readText(entry["summary"]) ?? "";
  }
  return {
    id,
    title: htmlToText(rawTitle),
    link,
    author: readAuthor(entry["author"]),
    publishedAt: toIsoDate(readText(entry["published"])),
    updatedAt: toIsoDate(readText(entry["updated"])),
    bodyText: htmlToText(bodyHtml),
  };
}

export function parseFeed(xml: string, logger: Logger = consoleLogger): Post[] {
  const document: unknown = xmlParser.parse(xml);
  if (!isRecord(document) || !isRecord(document["feed"])) {
    throw new Error("Not an Atom feed: no <feed> root element");
  }
  const entries = toArray(document["feed"]["entry"]);
  const posts: Post[] = [];
  for (const [entryIndex, entry] of entries.entries()) {
    const parsed = parseEntry(entry);
    if (typeof parsed === "string") {
      logger.warn(`Skipping malformed feed entry #${entryIndex + 1}: ${parsed}`);
      continue;
    }
    posts.push(parsed);
  }
  return posts;
}
