// Phase 4f fixture: a tiny library for the acceptance case runner.
export function slugify(text) {
  if (typeof text !== "string") throw new TypeError("slugify: text must be a string");
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
