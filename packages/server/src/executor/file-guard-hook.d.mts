export declare const FILE_TOOLS: readonly string[];
export declare function resolveReal(p: string, depth?: number): string;
export declare const WALK_MAX_ENTRIES: number;
export declare function checkFileCall(input: unknown, roots: readonly string[], opts?: { maxEntries?: number }): void;
export declare function realRoots(roots: unknown): string[];
export declare function installCrashGuard(): void;
