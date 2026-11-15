import type { OpenPr } from "./gh.ts";

/**
 * What delivery needs from a forge, by repository id (`<host>/<owner>/<name>`; Azure DevOps: `dev.azure.com/<org>/<project>/<repo>`):
 * GitHub through gh (GhClient), Azure DevOps through az repos (AzClient). Never merge, never reviewers or labels.
 */
export interface PrClient {
  authStatus(idOrHost: string): Promise<{ ok: boolean; detail: string }>;
  findOpenPr(id: string, head: string, base: string): Promise<OpenPr>;
  /** true = private, false = public, null = unknown */
  repoVisibility(id: string): Promise<boolean | null>;
  createPr(o: { repo: string; base: string; head: string; title: string; bodyFile: string }): Promise<{ number: number; url: string }>;
  getPrBody(id: string, number: number): Promise<string>;
  editPrBody(id: string, number: number, bodyFile: string): Promise<void>;
}

export const isAzureId = (id: string): boolean => id.toLowerCase().startsWith("dev.azure.com/");

const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** The repository id and number of a recorded pull request URL (GitHub or Azure DevOps), or null. */
export function prIdFromUrl(url: string): { id: string; number: number } | null {
  const gh = url.match(/^https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)$/);
  if (gh && gh[1]!.toLowerCase() !== "dev.azure.com") return { id: `${gh[1]!.toLowerCase()}/${gh[2]}/${gh[3]}`, number: Number(gh[4]) };
  const az = url.match(/^https:\/\/dev\.azure\.com\/([^/\s]+)\/([^/\s]+)\/_git\/([^/\s]+)\/pullrequest\/(\d+)$/);
  if (az) return { id: `dev.azure.com/${dec(az[1]!)}/${dec(az[2]!)}/${dec(az[3]!)}`, number: Number(az[4]) };
  return null;
}
