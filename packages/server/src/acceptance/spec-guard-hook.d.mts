export declare function scaffoldDigest(acceptanceDir: string): Record<string, string>;
export declare function specViolations(acceptanceDir: string, scaffold?: Readonly<Record<string, string>> | null): string[];
export declare function checkSpecCall(input: unknown, commands: readonly string[], workDir: string, scaffold?: Readonly<Record<string, string>> | null, cases?: ReadonlyArray<{ repo: string; library: string | null }> | null): void;
export declare function casesScaffoldDigest(acceptanceDir: string, cases: ReadonlyArray<{ repo: string; library: string | null }>): Record<string, string>;
export declare function caseViolations(acceptanceDir: string, cases: ReadonlyArray<{ repo: string; library: string | null }>, scaffold?: Readonly<Record<string, string>> | null): string[];
export declare function checkExample(text: string, o: { libraryName: string }): string[];
