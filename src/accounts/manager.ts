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
  private accountsFile: string;
  /** Serializes select/selectExcluding to prevent concurrent same-account selection */
  private selectMutex: Promise<void> = Promise.resolve();
  /** Accounts currently being used by an in-flight request, keyed by stable identity */
  private pendingAccounts = new Set<string>();

  private async withSelectMutex<T>(fn: () => T): Promise<T> {
    let unlock: () => void;
    const next = new Promise<void>((r) => (unlock = r));
    await this.selectMutex;
    this.selectMutex = next;
    try {
      return await fn();
    } finally {
      unlock!();
    }
  }

  constructor(config?: Partial<PluginConfig>, accountsFile = ACCOUNTS_FILE) {
    this.config = resolveConfig(config);
    this.accountsFile = accountsFile;
  }

  // ── Persistence ──────────────────────────────────────────

  /** Load accounts from disk. */
  load(): void {
    const store = readJSON<AccountsStore>(this.accountsFile);
    if (store?.version === 1 && Array.isArray(store.accounts)) {
      this.accounts = store.accounts;
      this.activeIndex = store.activeAccountIndex ?? 0;
      this.roundRobinCursor = store.roundRobinCursor ?? this.activeIndex;
      this.normalizeIndices();
      this.strategyInitialized = false;
    }
  }

  /** Save accounts to disk, merging concurrent changes from other processes. */
  save(): void {
    const diskStore = readJSON<AccountsStore>(this.accountsFile);
    const diskAccounts: ManagedAccount[] =
      diskStore?.version === 1 && Array.isArray(diskStore.accounts)
        ? diskStore.accounts.map((a) => ({ ...a }))
        : [];

    const matches = (a: ManagedAccount, b: ManagedAccount): boolean => {
      if (a.userId && a.accountId && b.userId && b.accountId) {
        return a.userId === b.userId && a.accountId === b.accountId;
      }
      if (a.refresh && b.refresh) return a.refresh === b.refresh;
      if (a.apiKey && b.apiKey) return a.apiKey === b.apiKey;
      return a.index === b.index;
    };

    const matchedDiskAccounts = new Set<ManagedAccount>();
    for (const mem of this.accounts) {
      const existing = diskAccounts.find((disk) => !matchedDiskAccounts.has(disk) && matches(mem, disk));
      if (existing) {
        matchedDiskAccounts.add(existing);
        const mergedResets = { ...existing.rateLimitResets, ...mem.rateLimitResets };
        Object.assign(existing, mem, { rateLimitResets: mergedResets });
      } else {
        diskAccounts.push({ ...mem });
      }
    }

    this.accounts = diskAccounts;
    this.normalizeIndices();
    if (this.activeIndex >= this.accounts.length) this.activeIndex = 0;
    this.roundRobinCursor = this.activeIndex;
    this.strategyInitialized = false;

    const store: AccountsStore = {
      version: 1,
      accounts: this.accounts,
      activeAccountIndex: this.activeIndex,
      roundRobinCursor: this.roundRobinCursor,
    };
    writeJSON(this.accountsFile, store);

    if (this.config.debug) {
      for (const acct of this.accounts) {
        const id = acct.label || acct.email || `acc-${acct.index}`;
        const resets = Object.entries(acct.rateLimitResets ?? {})
          .map(([m, t]) => `${m}=${new Date(t).toISOString()}`)
          .join(", ");
        if (resets) console.log(`[multi-auth] save ${id}: ${resets}`);
      }
    }
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

  importApiKeyFromOpenCodeAuth(provider: string, label?: string): void {
    const auth = readJSON<Record<string, unknown>>(OPENCODE_AUTH_FILE);
    if (!auth) return;

    const entry = auth[provider] as { type?: string; key?: string } | undefined;
    if (entry?.type === "api" && entry.key) {
      this.addApiKey(entry.key, label, { updateExistingLabel: false });
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
      return !!a.refresh && a.refresh === refreshToken;
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
      id: crypto.randomUUID(),
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

  addApiKey(
    apiKey: string,
    label?: string,
    options: { updateExistingLabel?: boolean } = {},
  ): ManagedAccount {
    const trimmed = apiKey.trim();
    const existing = this.accounts.find((a) => a.apiKey === trimmed);
    const updateExistingLabel = options.updateExistingLabel ?? true;

    if (existing) {
      let changed = false;
      if (label && updateExistingLabel && existing.label !== label) {
        existing.label = label;
        changed = true;
      }
      existing.consecutiveFailures = 0;
      this.strategyInitialized = false;
      if (!changed) return existing;
      if (!this.config.quietMode) {
        console.log(`[multi-auth] Updated account: ${label || existing.index}`);
      }
      this.save();
      return existing;
    }

    const account: ManagedAccount = {
      id: crypto.randomUUID(),
      index: this.accounts.length,
      label,
      addedAt: Date.now(),
      apiKey: trimmed,
      rateLimitResets: {},
      consecutiveFailures: 0,
    };

    this.accounts.push(account);
    this.strategyInitialized = false;
    if (!this.config.quietMode) {
      console.log(`[multi-auth] Added account: ${label || account.index}`);
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

  setPriority(index: number, priority: number): ManagedAccount | null {
    const account = this.accounts.find((a) => a.index === index);
    if (!account) return null;
    account.priority = priority;
    this.strategyInitialized = false;
    this.save();
    return account;
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
    return this.withSelectMutex(async () => {
      if (this.accounts.length === 0) return null;
      this.initStrategy();

      if (this.config.accountSelectionStrategy === "quota-aware") {
        const selected = this.pickQuotaAware(model, Date.now(), new Set());
        if (selected) {
          this.activeIndex = selected.index;
          selected.lastUsed = Date.now();
          this.pendingAccounts.add(this.pendingKey(selected));
          return selected;
        }
      }

      const useRR = this.config.accountSelectionStrategy === "round-robin";
      const startIdx = useRR ? this.roundRobinCursor : this.activeIndex;
      const now = Date.now();
      const priority = this.bestAvailablePriority(model, now, new Set());
      if (priority === undefined) return null;

      for (let i = 0; i < this.accounts.length; i++) {
        const idx = (startIdx + i) % this.accounts.length;
        const acct = this.accounts[idx];
        if (this.priorityOf(acct) !== priority) continue;
        if (this.isAvailable(acct, model, now)) {
          this.activeIndex = idx;
          if (useRR) {
            this.roundRobinCursor = (idx + 1) % this.accounts.length;
          }
          acct.lastUsed = now;
          this.pendingAccounts.add(this.pendingKey(acct));
          return acct;
        }
      }

      return null;
    });
  }

  /** Pick the next available account, excluding specific indices (for retry). */
  async selectExcluding(
    exclude: Set<number>,
    model?: string,
    allowFallback = true,
  ): Promise<ManagedAccount | null> {
    return this.withSelectMutex(async () => {
      if (this.accounts.length === 0) return null;
      const now = Date.now();

      if (this.config.accountSelectionStrategy === "quota-aware") {
        const selected = this.pickQuotaAware(model, now, exclude);
        if (selected) {
          this.activeIndex = selected.index;
          selected.lastUsed = now;
          this.pendingAccounts.add(this.pendingKey(selected));
          return selected;
        }
      }

      const priority = this.bestAvailablePriority(model, now, exclude);
      if (priority === undefined) {
        if (!allowFallback) return null;
        return this.pickBestFallback(model, now, exclude);
      }

      for (const acct of this.accounts) {
        if (exclude.has(acct.index)) continue;
        if (this.priorityOf(acct) !== priority) continue;
        if (this.isAvailable(acct, model, now)) {
          this.activeIndex = acct.index;
          acct.lastUsed = now;
          this.pendingAccounts.add(this.pendingKey(acct));
          return acct;
        }
      }

      if (!allowFallback) return null;
      return this.pickBestFallback(model, now, exclude);
    });
  }

  releasePending(account: ManagedAccount): void {
    this.pendingAccounts.delete(this.pendingKey(account));
  }

  // ── Health ───────────────────────────────────────────────

  /** Mark an account as rate-limited. */
  markRateLimited(account: ManagedAccount, cooldownMs: number, model?: string): void {
    const target = this.resolveAccount(account);
    const resetTime = Date.now() + cooldownMs;
    if (model && this.config.perModelRateLimits) {
      target.rateLimitResets[model] = resetTime;
    } else {
      target.globalRateLimitReset = resetTime;
    }
    this.save();
    if (this.config.debug) {
      const id = account.label || account.email || `acc-${account.index}`;
      console.log(`[multi-auth] ${id} rate-limited until ${new Date(resetTime).toISOString()}`);
    }
  }

  updateQuota(account: ManagedAccount, snapshot: QuotaSnapshot, model?: string): void {
    const target = this.resolveAccount(account);
    target.quota = snapshot;
    if (model && this.config.perModelRateLimits) {
      target.quotaByModel = target.quotaByModel ?? {};
      target.quotaByModel[model] = snapshot;
    }
    if (snapshot.planType) target.planType = snapshot.planType;
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
    if (account.apiKey) return true;
    if (!account.refresh) return false;
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

  async refreshExpiringTokens(): Promise<void> {
    for (const account of this.accounts) {
      if (account.consecutiveFailures >= 3) continue;
      await this.ensureValidToken(account);
    }
  }

  private async _doRefresh(account: ManagedAccount): Promise<boolean> {
    try {
      if (!account.refresh) return false;
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

  getEarliestReset(model?: string): number | undefined {
    const now = Date.now();
    let earliest: number | undefined;

    for (const acct of this.accounts) {
      if (acct.consecutiveFailures >= 3) continue;

      if (acct.globalRateLimitReset && acct.globalRateLimitReset > now) {
        if (earliest === undefined || acct.globalRateLimitReset < earliest) {
          earliest = acct.globalRateLimitReset;
        }
      }

      if (model && this.config.perModelRateLimits) {
        const modelReset = acct.rateLimitResets[model];
        if (modelReset && modelReset > now) {
          if (earliest === undefined || modelReset < earliest) {
            earliest = modelReset;
          }
        }
      }
    }

    return earliest;
  }

  // ── Private helpers ──────────────────────────────────────

  /** Find the current account object in this.accounts, handling orphaned references. */
  private resolveAccount(account: ManagedAccount): ManagedAccount {
    const key =
      account.userId && account.accountId
        ? `${account.userId}/${account.accountId}`
        : account.refresh ?? account.apiKey ?? String(account.index);
    const found = this.accounts.find((a) => {
      const aKey = a.userId && a.accountId ? `${a.userId}/${a.accountId}` : a.refresh ?? a.apiKey ?? String(a.index);
      return aKey === key;
    });
    if (this.config.debug && found && found !== account) {
      console.log(
        `[multi-auth] resolveAccount: orphaned ref for ${account.label || account.email || `acc-${account.index}`} → resolved to fresh object`,
      );
    }
    return found ?? account;
  }

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
    this.accounts.forEach((a, i) => {
      a.id ??= crypto.randomUUID();
      a.index = i;
    });
  }

  /** Stable identity for an account, independent of its mutable array index. */
  private pendingKey(account: ManagedAccount): string {
    if (account.id) return `id:${account.id}`;
    if (account.userId && account.accountId) return `${account.userId}/${account.accountId}`;
    if (account.refresh) return `r:${account.refresh}`;
    if (account.apiKey) return `k:${account.apiKey}`;
    return `i:${account.index}`;
  }

  private priorityOf(account: ManagedAccount): number {
    return typeof account.priority === "number" && Number.isFinite(account.priority)
      ? account.priority
      : 0;
  }

  private bestAvailablePriority(
    model: string | undefined,
    now: number,
    exclude: Set<number>,
  ): number | undefined {
    let priority: number | undefined;
    for (const acct of this.accounts) {
      if (exclude.has(acct.index)) continue;
      if (!this.isAvailable(acct, model, now)) continue;
      const acctPriority = this.priorityOf(acct);
      if (priority === undefined || acctPriority < priority) {
        priority = acctPriority;
      }
    }
    return priority;
  }

  private isAvailable(account: ManagedAccount, model: string | undefined, now: number): boolean {
    if (account.consecutiveFailures >= 3) return false;
    if (this.pendingAccounts.has(this.pendingKey(account))) return false;
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
    const priority = this.bestAvailablePriority(model, now, exclude);
    if (priority === undefined) return null;

    for (const acct of this.accounts) {
      if (exclude.has(acct.index)) continue;
      if (!this.isAvailable(acct, model, now)) continue;
      if (this.priorityOf(acct) !== priority) continue;

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
    return !!window.resetsAt && window.resetsAt > now;
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
    let bestPriority = Infinity;

    for (const acct of this.accounts) {
      if (exclude.has(acct.index)) continue;
      if (acct.consecutiveFailures >= 3) continue;
      const priority = this.priorityOf(acct);

      let reset = acct.globalRateLimitReset || 0;
      if (model && this.config.perModelRateLimits) {
        const mr = acct.rateLimitResets[model] || 0;
        reset = Math.max(reset, mr);
      }

      if (priority < bestPriority || (priority === bestPriority && reset < earliest)) {
        bestPriority = priority;
        earliest = reset;
        best = acct;
      }
    }

    return best;
  }
}
