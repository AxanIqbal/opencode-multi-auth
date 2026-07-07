import type { Auth } from "@opencode-ai/sdk";

/** Single managed account in the pool */
export interface QuotaWindow {
  usedPercent?: number;
  windowMinutes?: number;
  resetsAt?: number;
}

export interface QuotaSnapshot {
  primary?: QuotaWindow;
  secondary?: QuotaWindow;
  planType?: string;
  rateLimitReachedType?: string;
  updatedAt: number;
}

export interface ManagedAccount {
  /** Index within the accounts array (auto-assigned) */
  index: number;
  /** Human-readable label (email or custom name) */
  label?: string;
  /** Email extracted from JWT profile */
  email?: string;
  /** OpenAI user ID from JWT */
  userId?: string;
  /** ChatGPT account/workspace ID from JWT */
  accountId?: string;
  /** Plan type: free, plus, pro, team, etc */
  planType?: string;
  /** When this account was added */
  addedAt: number;
  /** Last time this account was used */
  lastUsed?: number;
  priority?: number;
  /** OAuth refresh token — used to get new access tokens */
  refresh?: string;
  apiKey?: string;
  /** Current access token (may be expired, refreshed on use) */
  access?: string;
  /** Expiry timestamp (ms) for the access token */
  expires?: number;
  /** Per-model rate-limit reset timestamps: model -> reset epoch ms */
  rateLimitResets: Record<string, number>;
  /** Global rate-limit reset (when no model context) */
  globalRateLimitReset?: number;
  quota?: QuotaSnapshot;
  quotaByModel?: Record<string, QuotaSnapshot>;
  /** Consecutive failures for backoff */
  consecutiveFailures: number;
  /** Whether a token refresh is in flight */
  isRefreshing?: boolean;
  /** Promise for the ongoing refresh (dedup) */
  refreshPromise?: Promise<boolean>;
  /** Last refresh error message */
  lastRefreshError?: string;
}

/** Persisted on-disk format */
export interface AccountsStore {
  version: 1;
  accounts: ManagedAccount[];
  activeAccountIndex: number;
  roundRobinCursor: number;
}

/** Plugin configuration from env / opencode.json provider options */
export interface PluginConfig {
  /** account-selection strategy */
  accountSelectionStrategy: "sticky" | "round-robin" | "quota-aware";
  /** Print debug logs */
  debug: boolean;
  /** Suppress toast / console messages */
  quietMode: boolean;
  /** Offset account selection by PID (parallel processes) */
  pidOffsetEnabled: boolean;
  /** Refresh tokens N ms before they expire */
  proactiveRefreshThresholdMs: number;
  /** Remove accounts whose refresh token becomes invalid_grant */
  removeOnInvalidGrant: boolean;
  /** Track rate limits per model (true) or globally (false) */
  perModelRateLimits: boolean;
   /** Cooldown in ms after a rate-limit (default: 60s) */
   rateLimitCooldownMs: number;
   /** Fetch timeout in ms (default: 300s = 5 minutes) */
   fetchTimeoutMs: number;
   quotaCriticalThresholdPercent: number;
}

export const DEFAULT_CONFIG: PluginConfig = {
   accountSelectionStrategy: "quota-aware",
   debug: false,
   quietMode: false,
   pidOffsetEnabled: false,
   proactiveRefreshThresholdMs: 5 * 60 * 1000,
   removeOnInvalidGrant: true,
   perModelRateLimits: true,
   rateLimitCooldownMs: 60_000,
   fetchTimeoutMs: 300_000,
   quotaCriticalThresholdPercent: 95,
};

/** Merge partial config with defaults */
export function resolveConfig(partial?: Partial<PluginConfig>): PluginConfig {
  return { ...DEFAULT_CONFIG, ...partial };
}
