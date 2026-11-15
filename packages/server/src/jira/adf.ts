// Phase 4b Task 4: Atlassian Document Format (Jira Cloud REST v3 descriptions and comments) <-> plain text.
// Reading keeps the structure a model needs (headings, lists, code) as plain lines; writing never parses Markdown —
// one paragraph per line, compared afterwards with normalizeCommentText.

type Node = { type?: unknown; text?: unknown; attrs?: Record<string, unknown>; content?: unknown };

const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);
const children = (n: Node): Node[] => (Array.isArray(n.content) ? n.content.filter(isNode) : []);
const attr = (n: Node, k: string): string | null => {
  const v = n.attrs?.[k];
  return typeof v === "string" && v !== "" ? v : null;
};

/** The inline text of a node: text, hard breaks, mentions, inline cards, media placeholders and unknown wrappers. */
function inline(n: Node): string {
  switch (n.type) {
    case "text":
      return typeof n.text === "string" ? n.text : "";
    case "hardBreak":
      return "\n";
    case "mention":
      return attr(n, "text") ?? "";
    case "inlineCard":
    case "blockCard":
      return attr(n, "url") ?? "";
    case "emoji":
      return attr(n, "text") ?? attr(n, "shortName") ?? "";
    case "media":
      return `[image: ${attr(n, "alt") ?? attr(n, "id") ?? "?"}]`;
    default:
      return children(n).map(inline).join("");
  }
}

/** The lines of a block node; lists prefix each item ("- " or "<n>. "). */
function blocks(n: Node): string[] {
  switch (n.type) {
    case "doc":
    case "blockquote":
    case "panel":
    case "expand":
    case "nestedExpand":
    case "layoutSection":
    case "layoutColumn":
    case "mediaSingle":
    case "mediaGroup":
    case "listItem":
      return children(n).flatMap(blocks);
    case "paragraph":
    case "heading":
    case "codeBlock":
      return [inline(n)];
    case "bulletList":
      return children(n).flatMap((item) => blocks(item).map((line, i) => (i === 0 ? `- ${line}` : `  ${line}`)));
    case "orderedList": {
      const start = typeof n.attrs?.order === "number" ? n.attrs.order : 1;
      return children(n).flatMap((item, k) => blocks(item).map((line, i) => (i === 0 ? `${start + k}. ${line}` : `   ${line}`)));
    }
    case "rule":
      return ["---"];
    case "table":
    case "tableRow":
      return children(n).flatMap(blocks);
    case "tableCell":
    case "tableHeader":
      return children(n).flatMap(blocks);
    default: {
      // unknown block: its text children (inline nodes), else its own blocks
      const kids = children(n);
      if (kids.length === 0) return n.type === "media" ? [inline(n)] : typeof n.text === "string" ? [n.text] : [];
      return kids.every((k) => k.type === "text" || k.type === "hardBreak" || k.type === "mention" || k.type === "inlineCard") ? [inline(n)] : kids.flatMap(blocks);
    }
  }
}

/** Plain text of an ADF document (a string is returned as it is; anything else gives ""). */
export function adfToText(doc: unknown): string {
  if (typeof doc === "string") return doc;
  if (!isNode(doc)) return "";
  return blocks(doc).join("\n").replace(/\n+$/, "");
}

/** One paragraph per line (an empty line an empty paragraph); the text is never parsed as Markdown. */
export function textToAdf(text: string): object {
  return {
    type: "doc",
    version: 1,
    content: text.split("\n").map((line) => ({ type: "paragraph", content: line === "" ? [] : [{ type: "text", text: line }] })),
  };
}
