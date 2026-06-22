import { refreshAccessToken, extractTokenInfo } from "../auth/tokens.js";
import { ACCOUNTS_FILE, OPENCODE_AUTH_FILE, readJSON, writeJSON } from "../lib/storage.js";
import type { ManagedAccount, AccountsStore, PluginConfig, QuotaSnapshot } from "./types.js";
import { resolveConfig } from "./types.js";

/**
 * Manages a pool of OpenAI OAuth accounts with automatic rotation,
 * health tracking, and token refresh.
 */
export class AccountManager {
  private accounts: ManagedAccount[] = [];
  private activeIndex = 0;
  private roundRobinCursor = 0;
  private strategyInitialized = false;
  private config: PluginConfig;

  constructor(config?: Partial<PluginConfig>) {
    this.config = resolveConfig(config);
  }

  // ── Persistence ──────────────────────────────────────────

  /** Load accounts from disk. */
  load(): void {
    const store = readJSON<AccountsStore>(ACCOUNTS_FILE);
    if (store?.version === 1 && Array.isArray(store.accounts)) {
      this.accounts = store.accounts;
      this.activeIndex = store.activeAccountIndex ?? 0;
      this.roundRobinCursor = store.roundRobinCursor ?? this.activeIndex;
      this.normalizeIndices();
      this.strategyInitialized = false;
    }
  }

  /** Save accounts to disk atomically-ish. */
  save(): void {
    const store: AccountsStore = {
      version: 1,
      accounts: this.accounts,
      activeAccountIndex: this.activeIndex,
      roundRobinCursor: this.roundRobinCursor,
    };
    writeJSON(ACCOUNTS_FILE, store);
  }

  /** Import an existing credential from OpenCode's own auth store. */
  importFromOpenCodeAuth(): void {
    const auth = readJSON<Record<string, unknown>>(OPENCODE_AUTH_FILE);
    if (!auth) return;

    const oa = auth.openai as
      | { type?: string; refresh?: string; access?: string; expires?: number }
      | undefined;
    if (oa?.type === "oauth" && oa.refresh) {
      // Deduplicate by refresh token
      if (this.accounts.some((a) => a.refresh === oa.refresh)) return;
      this.addAccount(oa.refresh, oa.access, oa.expires);
    }
  }

  // ── Account management ───────────────────────────────────

  /** Add a new account or update an existing one by refresh token or userId+accountId. */
  addAccount(
    refreshToken: string,
    accessToken?: string,
    expires?: number,
    label?: string,
  ): ManagedAccount {
    // Extract info from token
    const info = accessToken ? extractTokenInfo(accessToken) : {};
    const email = info.email;

    // Dedup: match by userId+accountId first, then by refresh token
    let existing = this.accounts.find((a) => {
      if (info.userId && a.userId && info.accountId && a.accountId) {
        return a.userId === info.userId && a.accountId === info.accountId;
      }
      return a.refresh === refreshToken;
    });

    if (existing) {
      existing.refresh = refreshToken;
      if (accessToken) existing.access = accessToken;
      if (expires) existing.expires = expires;
      if (info.userId) existing.userId = info.userId;
      if (info.accountId) existing.accountId = info.accountId;
      if (info.planType) existing.planType = info.planType;
      if (email) existing.email = email;
      if (label) existing.label = label;
      existing.consecutiveFailures = 0;
      this.strategyInitialized = false;
      if (!this.config.quietMode) {
        console.log(`[multi-auth] Updated account: ${label || email || existing.index}`);
      }
      this.save();
      return existing;
    }

    const account: ManagedAccount = {
      index: this.accounts.length,
      label,
      email,
      userId: info.userId,
      accountId: info.accountId,
      planType: info.planType,
      addedAt: Date.now(),
      refresh: refreshToken,
      access: accessToken,
      expires,
      rateLimitResets: {},
      consecutiveFailures: 0,
    };

    this.accounts.push(account);
    this.strategyInitialized = false;
    if (!this.config.quietMode) {
      console.log(`[multi-auth] Added account: ${label || email || account.index}`);
    }
    this.save();
    return account;
  }

  /** Remove an account by index. */
  removeAccount(index: number): boolean {
    const idx = this.accounts.findIndex((a) => a.index === index);
    if (idx < 0) return false;
    const removed = this.accounts.splice(idx, 1)[0];
    this.normalizeIndices();
    if (this.activeIndex >= this.accounts.length) {
      this.activeIndex = Math.max(0, this.accounts.length - 1);
    }
    this.roundRobinCursor = this.activeIndex;
    this.strategyInitialized = false;
    if (!this.config.quietMode) {
      console.log(`[multi-auth] Removed account: ${removed.label || removed.email || index}`);
    }
    this.save();
    return true;
  }

  /** Get all accounts. */
  list(): ManagedAccount[] {
    return [...this.accounts];
  }

  /** Number of accounts. */
  count(): number {
    return this.accounts.length;
  }

  /** Get the currently active account. */
  getActive(): ManagedAccount | null {
    if (this.accounts.length === 0) return null;
    return this.accounts[this.activeIndex] ?? this.accounts[0];
  }

  // ── Selection ────────────────────────────────────────────

  /** Pick the next available account (for a new request). */
  async select(model?: string): Promise<ManagedAccount | null> {
    if (this.accounts.length === 0) return null;
    this.initStrategy();

    if (this.config.accountSelectionStrategy === "quota-aware") {
      const selected = this.pickQuotaAware(model, Date.now(), new Set());
      if (selected) {
        this.activeIndex = selected.index;
        selected.lastUsed = Date.now();
        return selected;
      }
    }

    const useRR = this.config.accountSelectionStrategy === "round-robin";
    const startIdx = useRR ? this.roundRobinCursor : this.activeIndex;
    const now = Date.now();

    // First pass: find a healthy account
    for (let i = 0; i < this.accounts.length; i++) {
      const idx = (startIdx + i) % this.accounts.length;
      const acct = this.accounts[idx];
      if (this.isAvailable(acct, model, now)) {
        this.activeIndex = idx;
        if (useRR) {
          this.roundRobinCursor = (idx + 1) % this.accounts.length;
        }
        acct.lastUsed = now;
        return acct;
      }
    }

    // Fallback: least rate-limited account
    const fallback = this.pickBestFallback(model, now, new Set());
    if (fallback) {
      this.activeIndex = fallback.index;
      if (useRR) {
        this.roundRobinCursor = (fallback.index + 1) % this.accounts.length;
      }
      fallback.lastUsed = now;
    }
    return fallback;
  }

  /** Pick the next available account, excluding specific indices (for retry). */
  async selectExcluding(
    exclude: Set<number>,
    model?: string,
  ): Promise<ManagedAccount | null> {
    if (this.accounts.length === 0) return null;
    const now = Date.now();

    if (this.config.accountSelectionStrategy === "quota-aware") {
      const selected = this.pickQuotaAware(model, now, exclude);
      if (selected) {
        this.activeIndex = selected.index;
        selected.lastUsed = now;
        return selected;
      }
    }

    for (const acct of this.accounts) {
      if (exclude.has(acct.index)) continue;
      if (this.isAvailable(acct, model, now)) {
        this.activeIndex = acct.index;
        acct.lastUsed = now;
        return acct;
      }
    }

    return this.pickBestFallback(model, now, exclude);
  }

  // ── Health ───────────────────────────────────────────────

  /** Mark an account as rate-limited. */
  markRateLimited(account: ManagedAccount, cooldownMs: number, model?: string): void {
    const resetTime = Date.now() + cooldownMs;
    if (model && this.config.perModelRateLimits) {
      account.rateLimitResets[model] = resetTime;
    } else {
      account.globalRateLimitReset = resetTime;
    }
    if (this.config.debug) {
      const id = account.label || account.email || `acc-${account.index}`;
      console.log(`[multi-auth] ${id} rate-limited until ${new Date(resetTime).toISOString()}`);
    }
  }

  updateQuota(account: ManagedAccount, snapshot: QuotaSnapshot, model?: string): void {
    account.quota = snapshot;
    if (model && this.config.perModelRateLimits) {
      account.quotaByModel = account.quotaByModel ?? {};
      account.quotaByModel[model] = snapshot;
    }
    if (snapshot.planType) account.planType = snapshot.planType;
    this.save();
  }

  /** Mark token refresh failure and increment backoff. */
  markRefreshFailed(account: ManagedAccount, error: string): void {
    account.consecutiveFailures++;
    account.lastRefreshError = error;
    account.isRefreshing = false;

    if (this.config.removeOnInvalidGrant && error.includes("invalid_grant")) {
      this.removeAccount(account.index);
    }
  }

  /** Ensure the account has a valid (non-expired) access token. */
  async ensureValidToken(account: ManagedAccount): Promise<boolean> {
    if (
      account.expires &&
      account.expires > Date.now() + this.config.proactiveRefreshThresholdMs
    ) {
      return true;  // still fresh
    }

    // Dedup concurrent refreshes
    if (account.isRefreshing && account.refreshPromise) {
      return account.refreshPromise;
    }

    account.isRefreshing = true;
    account.refreshPromise = this._doRefresh(account);
    return account.refreshPromise;
  }

  private async _doRefresh(account: ManagedAccount): Promise<boolean> {
    try {
      const result = await refreshAccessToken(account.refresh);
      if (result.type === "success") {
        account.access = result.access;
        account.refresh = result.refresh;
        account.expires = result.expires;
        account.consecutiveFailures = 0;
        account.isRefreshing = false;
        account.refreshPromise = undefined;

        // Refresh extracted metadata
        const info = extractTokenInfo(result.access);
        if (info.accountId) account.accountId = info.accountId;
        if (info.planType) account.planType = info.planType;
        if (info.email) account.email = info.email;

        this.save();
        return true;
      }

      // fatal error
      const code = result.code;
      if (code === "refresh_token_reused" || code === "invalid_grant") {
        this.markRefreshFailed(account, `Token invalid: ${code}. Re-auth needed.`);
        account.consecutiveFailures = 10;  // disable
        if (!this.config.quietMode) {
          console.error(
            `[multi-auth] Account ${account.label || account.email || account.index} needs re-auth (${code})`,
          );
        }
      } else {
        this.markRefreshFailed(account, result.message);
      }
      return false;
    } catch (err) {
      this.markRefreshFailed(account, String(err));
      return false;
    }
  }

  // ── Session binding ──────────────────────────────────────

  /** Get the account bound to a session key (if any, and still healthy). */
  getBound(index: number, model?: string): ManagedAccount | null {
    const acct = this.accounts.find((a) => a.index === index);
    if (!acct) return null;
    if (this.isAvailable(acct, model, Date.now())) return acct;
    return null;
  }

  // ── Private helpers ──────────────────────────────────────

  private initStrategy(): void {
    if (this.strategyInitialized) return;
    this.normalizeIndices();

    if (this.config.pidOffsetEnabled && this.accounts.length > 1) {
      const offset = Math.abs(process.pid) % this.accounts.length;
      this.activeIndex = (this.activeIndex + offset) % this.accounts.length;
      this.roundRobinCursor = this.activeIndex;
    }

    this.strategyInitialized = true;
  }

  private normalizeIndices(): void {
    this.accounts.forEach((a, i) => (a.index = i));
  }

  private isAvailable(account: ManagedAccount, model: string | undefined, now: number): boolean {
    if (account.consecutiveFailures >= 3) return false;
    if (account.globalRateLimitReset && account.globalRateLimitReset > now) return false;
    if (model && this.config.perModelRateLimits) {
      const modelReset = account.rateLimitResets[model];
      if (modelReset && modelReset > now) return false;
    }
    const quota = this.quotaFor(account, model);
    if (this.isQuotaCritical(quota?.primary, now)) return false;
    if (this.isQuotaCritical(quota?.secondary, now)) return false;
    return true;
  }

  private pickQuotaAware(
    model: string | undefined,
    now: number,
    exclude: Set<number>,
  ): ManagedAccount | null {
    let best: ManagedAccount | null = null;
    let bestScore = -Infinity;

    for (const acct of this.accounts) {
      if (exclude.has(acct.index)) continue;
      if (!this.isAvailable(acct, model, now)) continue;

      const score = this.quotaScore(acct, model, now);
      if (score > bestScore) {
        bestScore = score;
        best = acct;
      }
    }

    return best;
  }

  private quotaFor(account: ManagedAccount, model: string | undefined): QuotaSnapshot | undefined {
    if (model && this.config.perModelRateLimits) {
      return account.quotaByModel?.[model] ?? account.quota;
    }
    return account.quota;
  }

  private isQuotaCritical(
    window: QuotaSnapshot["primary"],
    now: number,
  ): boolean {
    if (!window?.usedPercent || window.usedPercent < this.config.quotaCriticalThresholdPercent) {
      return false;
    }
    return !window.resetsAt || window.resetsAt > now;
  }

  private quotaScore(account: ManagedAccount, model: string | undefined, now: number): number {
    const quota = this.quotaFor(account, model);
    const remaining = [quota?.primary, quota?.secondary]
      .map((window) => typeof window?.usedPercent === "number" ? 100 - window.usedPercent : undefined)
      .filter((value): value is number => typeof value === "number");

    const quotaScore = remaining.length > 0 ? Math.min(...remaining) : 50;
    const lastUsedAgeSeconds = account.lastUsed ? Math.min((now - account.lastUsed) / 1000, 3600) : 3600;
    return quotaScore * 10_000 + lastUsedAgeSeconds;
  }

  private pickBestFallback(
    model: string | undefined,
    now: number,
    exclude: Set<number>,
  ): ManagedAccount | null {
    let best: ManagedAccount | null = null;
    let earliest = Infinity;

    for (const acct of this.accounts) {
      if (exclude.has(acct.index)) continue;
      if (acct.consecutiveFailures >= 3) continue;

      let reset = acct.globalRateLimitReset || 0;
      if (model && this.config.perModelRateLimits) {
        const mr = acct.rateLimitResets[model] || 0;
        reset = Math.max(reset, mr);
      }

      if (reset < earliest) {
        earliest = reset;
        best = acct;
      }
    }

    return best;
  }
}
