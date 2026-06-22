/** Path to the accounts JSON store */
export declare const ACCOUNTS_FILE: string;
/** Path to OpenCode's own auth file (for importing existing accounts) */
export declare const OPENCODE_AUTH_FILE: string;
/** OpenCode's session file for detecting active sessions */
export declare const OPENCODE_SESSION_FILE: string;
/** Ensure a directory exists with restricted permissions */
export declare function ensureDir(dir: string, mode?: number): void;
/** Ensure a file has secure permissions (owner-only) */
export declare function ensureSecureFile(file: string): void;
/** Write JSON securely (atomic-ish: write + chmod) */
export declare function writeJSON(file: string, data: unknown): void;
/** Read JSON file, returning undefined on missing / invalid */
export declare function readJSON<T = unknown>(file: string): T | undefined;
//# sourceMappingURL=storage.d.ts.map