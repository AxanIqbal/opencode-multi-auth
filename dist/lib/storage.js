import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
/** Path to the accounts JSON store */
export const ACCOUNTS_FILE = join(homedir(), ".config", "opencode", "openai-accounts.json");
/** Path to OpenCode's own auth file (for importing existing accounts) */
export const OPENCODE_AUTH_FILE = join(homedir(), ".local", "share", "opencode", "auth.json");
/** OpenCode's session file for detecting active sessions */
export const OPENCODE_SESSION_FILE = join(homedir(), ".local", "share", "opencode", "instance.json");
/** Ensure a directory exists with restricted permissions */
export function ensureDir(dir, mode = 0o700) {
    mkdirSync(dir, { recursive: true, mode });
}
/** Ensure a file has secure permissions (owner-only) */
export function ensureSecureFile(file) {
    try {
        chmodSync(file, 0o600);
    }
    catch {
        // best-effort on platforms that don't support chmod
    }
}
/** Write JSON securely (atomic-ish: write + chmod) */
export function writeJSON(file, data) {
    const dir = dirname(file);
    if (!existsSync(dir))
        ensureDir(dir);
    writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600, encoding: "utf-8" });
    ensureSecureFile(file);
}
/** Read JSON file, returning undefined on missing / invalid */
export function readJSON(file) {
    if (!existsSync(file))
        return undefined;
    try {
        return JSON.parse(readFileSync(file, "utf-8"));
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=storage.js.map