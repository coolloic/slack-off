import qrcode from "qrcode-generator";

/** QR modules for `text` (byte mode, error correction M, smallest fitting version); true = dark. */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** One SVG path (a unit square per dark module) plus the viewBox size including a `quiet`-module margin. */
export function qrPath(modules: boolean[][], quiet = 4): { d: string; size: number } {
  let d = "";
  modules.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (dark) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }),
  );
  return { d, size: modules.length + quiet * 2 };
}

/** Pairing codes are 8 digits; tolerate spaces/dashes typed by hand. */
export const normalizeCode = (raw: string | null): string => (raw ?? "").replace(/\D/g, "").slice(0, 8);

/** Default device name suggested on the pairing page. */
export function deviceNameFromUa(ua: string): string {
  if (/iPad/.test(ua)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Android phone";
  return "My phone";
}

export const secondsLeft = (expiresAt: string, now: number = Date.now()): number => Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));

/** A phone without a valid session gets 401 from the API: send it to the pairing page (unless it is already there). */
export const pairingRedirect = (status: number, pathname: string): string | null => (status === 401 && pathname !== "/pair" ? "/pair" : null);

export type PairingPanelState = "paired" | "locked" | "expired" | "open";

/** What the Settings pairing panel shows: a new device paired, the code burned by too many wrong attempts, expired, or open. */
export function pairingPanelState(s: { paired: boolean; locked: boolean; secondsLeft: number }): PairingPanelState {
  if (s.paired) return "paired";
  if (s.locked) return "locked";
  return s.secondsLeft === 0 ? "expired" : "open";
}
