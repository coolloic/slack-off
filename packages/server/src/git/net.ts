// Talking to a repository's origin: no prompt can hang a run (GIT_TERMINAL_PROMPT=0 in runGit; BatchMode for ssh) and
// a credential written into a remote URL never reaches a message.

/** `-c core.sshCommand=…` for an ssh remote: ssh never asks for a password or a host key. */
export const SSH_CONFIG: readonly string[] = ["-c", "core.sshCommand=ssh -o BatchMode=yes"];

export const isSshUrl = (url: string): boolean => /^ssh:\/\//.test(url) || /^[^/@\s]+@[^/\s:]+:/.test(url);

/** Every `scheme://user:secret@` in `text` loses its credentials (git quotes remote URLs in its errors). */
export const redactUrls = (text: string): string => text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s'"]*@/gi, "$1");
