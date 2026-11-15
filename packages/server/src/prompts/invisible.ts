/**
 * Ruling 4D-2 (N1): characters that render as nothing (or not at all) can hide text from the developer and split a tag
 * so the defang misses it (`<` + soft hyphen + `/preferences>`). Removed from every text that reaches a system prompt
 * from outside the platform — repository prompts, rules.md and the developer's preference text — before the defang:
 * format characters (\p{Cf}: soft hyphen, zero-width, bidi controls, the U+E0000 tag block, U+180E…), every other
 * default-ignorable code point (U+034F, Hangul fillers, variation selectors…), private-use code points, noncharacters
 * and lone surrogates. Newlines and tabs are not among them.
 */
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}\u{E0000}-\u{E007F}]/gu;

/** C0 and C1 control characters except tab and newline. */
const CONTROLS = /[\u{0}-\u{8}\u{B}-\u{1F}\u{7F}-\u{9F}]/gu;

/** Line breaks of every kind as "\n". */
const LINE_BREAKS = /\r\n?|[\u{85}\u{2028}\u{2029}\u{B}\u{C}]/gu;

/** Line breaks unified, then every invisible and control character (tab and newline kept) removed. */
export function stripInvisible(text: string): string {
  return text.replace(LINE_BREAKS, "\n").replace(INVISIBLE, "").replace(CONTROLS, "");
}
