// The live activity a developer reads on a ticket: what the agent is doing, in words, not the CLI's raw stream (tool
// names, internal status such as thinking_tokens). The raw log keeps everything.

const MAX = 100;
const CHROME = "mcp__claude-in-chrome__";

const cut = (s: string): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX ? `${one.slice(0, MAX - 1)}…` : one;
};

/** The last three path segments (enough to recognise a file, short on a phone). */
const shortPath = (p: string): string => p.split("/").filter(Boolean).slice(-3).join("/");

const str = (input: Record<string, unknown>, k: string): string | null => (typeof input[k] === "string" && input[k] !== "" ? (input[k] as string) : null);

/** A tool call as the developer reads it, or null when it says nothing to them (tool loading, tab bookkeeping). */
export function describeToolUse(name: string, input: Record<string, unknown>): string | null {
  const file = str(input, "file_path") ?? str(input, "notebook_path");
  switch (name) {
    case "Read":
      return file ? cut(`Reading ${shortPath(file)}`) : "Reading a file";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return file ? cut(`Editing ${shortPath(file)}`) : "Editing a file";
    case "Write":
      return file ? cut(`Writing ${shortPath(file)}`) : "Writing a file";
    case "Grep": {
      const p = str(input, "pattern");
      return p ? cut(`Searching the code for “${p}”`) : "Searching the code";
    }
    case "Glob": {
      const p = str(input, "pattern");
      return p ? cut(`Looking for files matching ${p}`) : "Looking for files";
    }
    case "Bash": {
      const c = str(input, "command");
      return c ? cut(`Running ${c}`) : "Running a command";
    }
    case "ToolSearch":
      return null;
  }
  if (name.startsWith(CHROME)) {
    const t = name.slice(CHROME.length);
    if (t === "navigate") {
      const url = str(input, "url");
      return url ? cut(`Opening ${url.replace(/^https?:\/\//, "")}`) : "Opening a page";
    }
    if (t === "get_page_text") return "Reading the page";
    if (t === "read_page") return "Reading the page structure";
    if (t === "find") {
      const q = str(input, "query");
      return q ? cut(`Looking on the page for “${q}”`) : "Looking on the page";
    }
    if (t === "tabs_create_mcp") return "Opening a tab";
    if (t === "tabs_close_mcp") return "Closing its tab";
    if (t === "select_browser") return "Selecting the browser";
    if (t === "computer") return "Using the page";
    if (t === "form_input") return "Filling in the page";
    return null; // tabs_context_mcp, list_connected_browsers: bookkeeping
  }
  return name.startsWith("mcp__") ? cut(name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, "")) : name;
}

/** A CLI status event, or null: only the start means anything to the developer. */
export function describeStatus(subtype: string): string | null {
  return subtype === "init" ? "Started" : null;
}
