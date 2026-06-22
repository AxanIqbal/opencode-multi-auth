import type { ManagedAccount, PluginConfig } from "./types.js";
/**
 * Manages a pool of OpenAI OAuth accounts with automatic rotation,
 * health tracking, and token refresh.
 */
export declare class AccountManager {
    private accounts;
    private activeIndex;
    private roundRobinCursor;
    private strategyInitialized;
    private config;
    constructor(config?: Partial<PluginConfig>);
    /** Load accounts from disk. */
    load(): void;
    /** Save accounts to disk atomically-ish. */
    save(): void;
    /** Import an existing credential from OpenCode's own auth store. */
    importFromOpenCodeAuth(): void;
    /** Add a new account or update an existing one by refresh token or userId+accountId. */
    addAccount(refreshToken: string, accessToken?: string, expires?: number, label?: string): ManagedAccount;
    /** Remove an account by index. */
    removeAccount(index: number): boolean;
    /** Get all accounts. */
    list(): ManagedAccount[];
    /** Number of accounts. */
    count(): number;
    /** Get the currently active account. */
    getActive(): ManagedAccount | null;
    /** Pick the next available account (for a new request). */
    select(model?: string): Promise<ManagedAccount | null>;
    /** Pick the next available account, excluding specific indices (for retry). */
    selectExcluding(exclude: Set<number>, model?: string): Promise<ManagedAccount | null>;
    /** Mark an account as rate-limited. */
    markRateLimited(account: ManagedAccount, cooldownMs: number, model?: string): void;
    /** Mark token refresh failure and increment backoff. */
    markRefreshFailed(account: ManagedAccount, error: string): void;
    /** Ensure the account has a valid (non-expired) access token. */
    ensureValidToken(account: ManagedAccount): Promise<boolean>;
    private _doRefresh;
    /** Get the account bound to a session key (if any, and still healthy). */
    getBound(index: number, model?: string): ManagedAccount | null;
    private initStrategy;
    private normalizeIndices;
    private isAvailable;
    private pickBestFallback;
}
//# sourceMappingURL=manager.d.ts.map