/**
 * Path globs for the agent's forbidden paths (repo-relative POSIX paths, anchored at the repo root).
 *
 * Unlike `path.matchesGlob`: wildcards match dotfiles, and — gitignore-like, the safe direction — every pattern also
 * covers everything below what it matches (`infra` covers `infra/x`, `secrets-*` covers `secrets-prod/key.pem`).
 * A leading `/` is the repo root; `.` / `..` segments are invalid. `{a,b}` is expanded (nested too) before matching.
 * Matching is a bottom-up DP over (token, character) — O(pattern × path), no regex backtracking, no recursion.
 */

export class GlobError extends Error {
  constructor(pattern: string, reason: string) {
    super(`invalid glob "${pattern}": ${reason}`);
    this.name = "GlobError";
  }
}

export const MAX_EXPANSIONS = 64;
export const MAX_WILDCARDS = 8;

type Token =
  | { t: "lit"; c: string }
  | { t: "one" }
  | { t: "class"; negate: boolean; items: Array<[string, string]> }
  | { t: "star" } // [^/]*
  | { t: "gstar" } // anything, '/' included
  | { t: "gseg" } // "**/": empty or anything ending with '/'
  | { t: "tail" }; // end, or '/' then anything (X/** covers X)

/**
 * Case-insensitive comparisons fold both sides with NFKC + full case folding (upper then lower: ß → ss, ı → i;
 * over-folding is the safe direction); otherwise NFC.
 */
export const canonical = (s: string, fold: boolean): string =>
  fold ? foldOnce(foldOnce(s.normalize("NFKC"))) : s.normalize("NFC");

/** Full case fold; applied twice because U+1E9E (ẞ) → ß → ss needs two passes. */
const foldOnce = (s: string): string => s.toUpperCase().toLowerCase();

function expandBraces(pattern: string, original: string): string[] {
  const open = pattern.indexOf("{");
  const close = pattern.indexOf("}");
  if (open === -1) {
    if (close !== -1) throw new GlobError(original, "unbalanced braces");
    return [pattern];
  }
  if (close !== -1 && close < open) throw new GlobError(original, "unbalanced braces");
  let depth = 0;
  let end = -1;
  const commas: number[] = [];
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    } else if (c === "," && depth === 1) commas.push(i);
  }
  if (end === -1) throw new GlobError(original, "unbalanced braces");
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(end + 1);
  const bounds = [open, ...commas, end];
  const out: string[] = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const alt = pattern.slice(bounds[k]! + 1, bounds[k + 1]);
    for (const e of expandBraces(prefix + alt + suffix, original)) {
      out.push(e);
      if (out.length > MAX_EXPANSIONS) throw new GlobError(original, `more than ${MAX_EXPANSIONS} brace expansions`);
    }
  }
  return out;
}

function tokenize(expanded: string, original: string): Token[] {
  let p = expanded.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  p = p.replace(/^\/+/, "");
  p = p.replace(/\/+$/, "");
  // collapse repeated globstars: **/**/ → **/, /**/** → /**
  p = p.replace(/(?:\*\*\/){2,}/g, "**/").replace(/(?:\/\*\*){2,}$/, "/**");
  if (p === "") throw new GlobError(original, "matches the whole repository");
  if (p.split("/").some((seg) => seg === "." || seg === "..")) throw new GlobError(original, "'.' and '..' segments are not allowed");
  // gitignore-like: every pattern also covers the descendants of what it matches (X/** is X plus the tail)
  if (p.endsWith("/**")) p = p.slice(0, -3);
  const tokens: Token[] = [];
  const cp = [...p]; // code points: astral characters are one character, like in the path
  let wildcards = 0;
  for (let i = 0; i < cp.length; ) {
    const c = cp[i]!;
    if (c === "*") {
      let j = i;
      while (cp[j] === "*") j++;
      const segStart = i === 0 || cp[i - 1] === "/";
      if (j - i >= 2 && segStart && cp[j] === "/") {
        tokens.push({ t: "gseg" });
        i = j + 1;
      } else if (j - i >= 2 && segStart && j === cp.length) {
        tokens.push({ t: "gstar" });
        i = j;
      } else {
        tokens.push({ t: "star" });
        i = j;
      }
      wildcards++;
    } else if (c === "?") {
      tokens.push({ t: "one" });
      wildcards++;
      i++;
    } else if (c === "[") {
      let j = i + 1;
      let negate = false;
      if (cp[j] === "!" || cp[j] === "^") {
        negate = true;
        j++;
      }
      const start = j;
      if (cp[j] === "]") j++; // a leading ']' is literal
      while (j < cp.length && cp[j] !== "]") j++;
      if (j >= cp.length) throw new GlobError(original, "unbalanced brackets");
      const body = cp.slice(start, j);
      if (body.length === 0) throw new GlobError(original, "empty character class");
      const items: Array<[string, string]> = [];
      for (let k = 0; k < body.length; k++) {
        if (body[k + 1] === "-" && k + 2 < body.length) {
          const lo = body[k]!;
          const hi = body[k + 2]!;
          if (lo.codePointAt(0)! > hi.codePointAt(0)!) throw new GlobError(original, `invalid range ${lo}-${hi}`);
          items.push([lo, hi]);
          k += 2;
        } else items.push([body[k]!, body[k]!]);
      }
      tokens.push({ t: "class", negate, items });
      wildcards++;
      i = j + 1;
    } else if (c === "]") {
      throw new GlobError(original, "unbalanced brackets");
    } else {
      tokens.push({ t: "lit", c });
      i++;
    }
  }
  if (tokens.at(-1)?.t !== "gstar") tokens.push({ t: "tail" });
  if (wildcards > MAX_WILDCARDS) throw new GlobError(original, `more than ${MAX_WILDCARDS} wildcards`);
  return tokens;
}

function compile(pattern: string, fold: boolean): Token[][] {
  const canon = canonical(pattern, fold);
  if (canon.trim() === "") throw new GlobError(pattern, "empty pattern");
  return expandBraces(canon, pattern).map((e) => tokenize(e, pattern));
}

const cache = new Map<string, Token[][]>();

function compiled(pattern: string, fold: boolean): Token[][] {
  const key = `${fold ? "f" : "s"}\0${pattern}`;
  let c = cache.get(key);
  if (!c) {
    c = compile(pattern, fold);
    if (cache.size > 2000) cache.clear();
    cache.set(key, c);
  }
  return c;
}

/** Throws a GlobError naming the pattern when it is not a usable forbidden-path glob. */
export function validateGlob(pattern: string): void {
  compile(pattern, false);
  compile(pattern, true);
}

/** `s` must already be canonical (see `canonical`). Bottom-up DP over (token, position): O(tokens × path), no recursion. */
function matchTokens(tokens: readonly Token[], s: readonly string[]): boolean {
  const N = s.length;
  // next[si]: tokens[pi+1..] match s[si..]; cur: tokens[pi..]; inner: inside a "**/" token at pi. Index N+1 stays false.
  let next = new Uint8Array(N + 2);
  next[N] = 1;
  let cur = new Uint8Array(N + 2);
  const inner = new Uint8Array(N + 2);
  for (let pi = tokens.length - 1; pi >= 0; pi--) {
    const tok = tokens[pi]!;
    cur.fill(0);
    if (tok.t === "gseg") inner.fill(0);
    for (let si = N; si >= 0; si--) {
      const ch = s[si];
      const has = si < N;
      let r = false;
      switch (tok.t) {
        case "lit":
          r = has && ch === tok.c && next[si + 1] === 1;
          break;
        case "one":
          r = has && ch !== "/" && next[si + 1] === 1;
          break;
        case "class": {
          const hit = has && tok.items.some(([lo, hi]) => cpOf(ch!) >= cpOf(lo) && cpOf(ch!) <= cpOf(hi));
          r = has && ch !== "/" && hit !== tok.negate && next[si + 1] === 1;
          break;
        }
        case "star":
          r = next[si] === 1 || (has && ch !== "/" && cur[si + 1] === 1);
          break;
        case "gstar":
          r = next[si] === 1 || (has && cur[si + 1] === 1);
          break;
        case "gseg": {
          const inn = has && ((ch === "/" && next[si + 1] === 1) || inner[si + 1] === 1);
          inner[si] = inn ? 1 : 0;
          r = next[si] === 1 || inn;
          break;
        }
        case "tail":
          r = !has || ch === "/";
          break;
      }
      cur[si] = r ? 1 : 0;
    }
    [next, cur] = [cur, next];
  }
  return next[0] === 1;
}

/** Whether the repo-relative POSIX `path` matches `pattern` (fold = case/Unicode-insensitive). Throws GlobError on a bad pattern. */
export function matchGlob(path: string, pattern: string, fold: boolean): boolean {
  const s = [...canonical(path, fold)];
  return compiled(pattern, fold).some((tokens) => matchTokens(tokens, s));
}

const cpOf = (c: string): number => c.codePointAt(0)!;
