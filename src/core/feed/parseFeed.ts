import { consoleLogger } from "../config";
import type { Logger, Post } from "../types";

// A small Atom reader instead of a general XML parser. The RFD feed is a simple, predictable
// document, and on the Workers free plan every run gets only 10 ms of CPU. A cold general
// parser took ~6 ms on its own; targeted scanning takes a fraction of that.

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
  if (!text.includes("&")) {
    return text;
  }
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

const CDATA_START = "<![CDATA[";
const CDATA_END = "]]>";

// Comments go, CDATA sections stay untouched (a comment marker inside CDATA is just text)
function stripComments(xml: string): string {
  if (!xml.includes("<!--")) {
    return xml;
  }
  return xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, (section) => (section.startsWith("<!--") ? "" : section));
}

interface XmlElement {
  attributes: Record<string, string>;
  // Raw inner XML, null for a self closing element
  inner: string | null;
}

function parseAttributes(attributeText: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (!attributeText.includes("=")) {
    return attributes;
  }
  for (const match of attributeText.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = match[1]!;
    attributes[name] = decodeHtmlEntities(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

const openingTagPatterns = new Map<string, RegExp>();

function openingTagPattern(tagName: string): RegExp {
  // The name must end right there, so <content does not match <contents and <media:content is never matched
  let pattern = openingTagPatterns.get(tagName);
  if (pattern === undefined) {
    pattern = new RegExp(`<${tagName}(?=[\\s/>])([^>]*?)(/?)>`, "g");
    openingTagPatterns.set(tagName, pattern);
  }
  pattern.lastIndex = 0;
  return pattern;
}

// Finds where </tagName> closes, skipping over CDATA sections that could contain anything
function findClosingTag(xml: string, tagName: string, fromIndex: number): number {
  const closingTag = `</${tagName}>`;
  let searchFrom = fromIndex;
  while (true) {
    const closingIndex = xml.indexOf(closingTag, searchFrom);
    const cdataIndex = xml.indexOf(CDATA_START, searchFrom);
    if (closingIndex === -1) {
      return -1;
    }
    if (cdataIndex === -1 || cdataIndex > closingIndex) {
      return closingIndex;
    }
    const cdataEnd = xml.indexOf(CDATA_END, cdataIndex + CDATA_START.length);
    if (cdataEnd === -1) {
      return -1;
    }
    searchFrom = cdataEnd + CDATA_END.length;
  }
}

function findElements(xml: string, tagName: string, limit = Infinity): XmlElement[] {
  const elements: XmlElement[] = [];
  const pattern = openingTagPattern(tagName);
  let match: RegExpExecArray | null;
  while (elements.length < limit && (match = pattern.exec(xml)) !== null) {
    const attributes = parseAttributes(match[1] ?? "");
    if (match[2] === "/") {
      elements.push({ attributes, inner: null });
      continue;
    }
    const innerStart = match.index + match[0].length;
    const closingIndex = findClosingTag(xml, tagName, innerStart);
    if (closingIndex === -1) {
      break;
    }
    elements.push({ attributes, inner: xml.slice(innerStart, closingIndex) });
    pattern.lastIndex = closingIndex + tagName.length + 3;
  }
  return elements;
}

function findElement(xml: string, tagName: string): XmlElement | null {
  return findElements(xml, tagName, 1)[0] ?? null;
}

// Text content: CDATA kept as is, everything else XML decoded
function elementText(element: XmlElement | null): string | null {
  if (element === null || element.inner === null) {
    return null;
  }
  let text = "";
  let position = 0;
  const inner = element.inner;
  while (position < inner.length) {
    const cdataIndex = inner.indexOf(CDATA_START, position);
    if (cdataIndex === -1) {
      text += decodeHtmlEntities(inner.slice(position));
      break;
    }
    text += decodeHtmlEntities(inner.slice(position, cdataIndex));
    const cdataEnd = inner.indexOf(CDATA_END, cdataIndex + CDATA_START.length);
    if (cdataEnd === -1) {
      text += inner.slice(cdataIndex + CDATA_START.length);
      break;
    }
    text += inner.slice(cdataIndex + CDATA_START.length, cdataEnd);
    position = cdataEnd + CDATA_END.length;
  }
  return text.trim();
}

function readAlternateLink(entryXml: string): string | null {
  for (const link of findElements(entryXml, "link")) {
    const rel = link.attributes["rel"];
    const href = link.attributes["href"];
    const isAlternate = rel === undefined || rel === "alternate";
    if (isAlternate && href !== undefined && href.length > 0) {
      return href;
    }
  }
  return null;
}

function readAuthor(entryXml: string): string | null {
  const author = findElement(entryXml, "author");
  if (author === null || author.inner === null) {
    return null;
  }
  const name = elementText(findElement(author.inner, "name"));
  return name && name.length > 0 ? name : null;
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

function parseEntry(entryXml: string): Post | string {
  const id = elementText(findElement(entryXml, "id"));
  if (!id) {
    return "missing <id>";
  }
  const rawTitle = elementText(findElement(entryXml, "title"));
  if (!rawTitle) {
    return `missing <title> (id ${id})`;
  }
  const link = readAlternateLink(entryXml);
  if (!link) {
    return `missing <link> (id ${id})`;
  }
  let bodyHtml = elementText(findElement(entryXml, "content"));
  if (bodyHtml === null) {
    bodyHtml = elementText(findElement(entryXml, "summary")) ?? "";
  }
  return {
    id,
    title: htmlToText(rawTitle),
    link,
    author: readAuthor(entryXml),
    publishedAt: toIsoDate(elementText(findElement(entryXml, "published"))),
    updatedAt: toIsoDate(elementText(findElement(entryXml, "updated"))),
    bodyText: htmlToText(bodyHtml),
  };
}

export function parseFeed(xml: string, logger: Logger = consoleLogger): Post[] {
  const document = stripComments(xml);
  const feed = findElement(document, "feed");
  if (feed === null || feed.inner === null) {
    throw new Error("Not an Atom feed: no <feed> root element");
  }
  const posts: Post[] = [];
  for (const [entryIndex, entry] of findElements(feed.inner, "entry").entries()) {
    const parsed = parseEntry(entry.inner ?? "");
    if (typeof parsed === "string") {
      logger.warn(`Skipping malformed feed entry #${entryIndex + 1}: ${parsed}`);
      continue;
    }
    posts.push(parsed);
  }
  return posts;
}
