/** A suggested answer to a decision: a short label on the button, the full text it fills in, maybe recommended. */
export interface AnswerOption {
  label: string;
  text: string;
  recommended: boolean;
}

/** The recommended option(s) first, then the rest in the order the agent gave them; at most 4. */
export function orderOptions(options: readonly AnswerOption[]): AnswerOption[] {
  return [...options.filter((o) => o.recommended), ...options.filter((o) => !o.recommended)].slice(0, 4);
}
