import type { AccountManager } from "../../accounts/manager.js";
import type { ManagedAccount, PluginConfig, QuotaSnapshot, QuotaWindow } from "../../accounts/types.js";

const WHAM_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

type FetchWithTimeout = (
  url: string | URL | Request,
  init?: RequestInit,
  timeoutMs?: number,
) => Promise<Response>;

interface QuotaRefreshDependencies {
  readonly cfg: PluginConfig;
  readonly manager: AccountManager;
  readonly fetchWithTimeout: FetchWithTimeout;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function parseUsageWindow(value: unknown): QuotaWindow | undefined {
  const window = asRecord(value);
  if (!window) return undefined;

  const usedPercent = window.used_percent;
  const resetAt = window.reset_at;
  const windowSeconds = window.limit_window_seconds;
  if (typeof usedPercent !== "number" && typeof resetAt !== "number" && typeof windowSeconds !== "number") {
    return undefined;
  }

  return {
    ...(typeof usedPercent === "number" ? { usedPercent } : {}),
    ...(typeof resetAt === "number" ? { resetsAt: resetAt * 1000 } : {}),
    ...(typeof windowSeconds === "number" ? { windowMinutes: windowSeconds / 60 } : {}),
  };
}

function parseWhamUsage(value: unknown): QuotaSnapshot | undefined {
  const body = asRecord(value);
  const rateLimit = asRecord(body?.rate_limit);
  if (!rateLimit) return undefined;

  const primary = parseUsageWindow(rateLimit.primary_window);
  const secondary = parseUsageWindow(rateLimit.secondary_window);
  if (!primary && !secondary) return undefined;

  return {
    primary,
    secondary,
    planType: typeof body?.plan_type === "string" ? body.plan_type : undefined,
    rateLimitReachedType: typeof body?.rate_limit_reached_type === "string" ? body.rate_limit_reached_type : undefined,
    updatedAt: Date.now(),
  };
}

export function extractQuotaFromErrorBody(body: string): QuotaSnapshot | undefined {
  try {
    const json = JSON.parse(body);
    const resetsAtField =
      json?.error?.details?.resets_at ??
      json?.error?.resets_at ??
      json?.resets_at;
    if (typeof resetsAtField !== "undefined") {
      const epoch =
        typeof resetsAtField === "number"
          ? resetsAtField < 1_000_000_000_000
            ? resetsAtField * 1000
            : resetsAtField
          : new Date(String(resetsAtField)).getTime();
      if (Number.isFinite(epoch)) {
        return { primary: { resetsAt: epoch }, updatedAt: Date.now() };
      }
    }
  } catch { /* ignore parse errors */ }
  return undefined;
}

export function extractQuotaFromHeaders(headers: Headers): QuotaSnapshot | undefined {
  const remaining =
    headers.get("x-ratelimit-remaining-requests") ??
    headers.get("x-ratelimit-remaining-tokens") ??
    headers.get("x-ratelimit-remaining") ??
    headers.get("ratelimit-remaining");
  const reset =
    headers.get("x-ratelimit-reset-requests") ??
    headers.get("x-ratelimit-reset-tokens") ??
    headers.get("x-ratelimit-reset") ??
    headers.get("ratelimit-reset");
  if (remaining || reset) {
    const snapshot: QuotaSnapshot = { updatedAt: Date.now() };
    const primary: { usedPercent?: number; resetsAt?: number } = {};
    if (remaining) {
      const count = parseInt(remaining, 10);
      if (Number.isFinite(count)) primary.usedPercent = Math.max(0, Math.min(100, 100 - count));
    }
    if (reset) {
      const epoch = parseInt(reset, 10);
      if (Number.isFinite(epoch)) primary.resetsAt = epoch * 1000;
    }
    if (primary.usedPercent !== undefined || primary.resetsAt !== undefined) {
      snapshot.primary = primary;
    }
    return snapshot;
  }
  return undefined;
}

export function createQuotaRefresher(
  dependencies: QuotaRefreshDependencies,
): (account: ManagedAccount, model: string | undefined) => Promise<boolean> {
  const { cfg, manager, fetchWithTimeout } = dependencies;
  return async function refreshQuota(account: ManagedAccount, model: string | undefined): Promise<boolean> {
    if (!account.access || !account.accountId) return false;

    try {
      const response = await fetchWithTimeout(WHAM_USAGE_ENDPOINT, {
        headers: {
          authorization: `Bearer ${account.access}`,
          "chatgpt-account-id": account.accountId,
          "user-agent": "Codex/codex_cli_rs",
        },
      }, 10_000);
      if (!response.ok) {
        if (cfg.debug) {
          console.log(`[multi-auth] Quota refresh failed for ${account.label || account.email || account.index}: ${response.status}`);
        }
        return false;
      }

      const quota = parseWhamUsage(await response.json());
      if (!quota) return false;
      manager.updateQuota(account, quota, model);
      if (manager.hasQuotaCapacity(account, model)) {
        manager.clearRateLimit(account, model);
      }
      return true;
    } catch (error) {
      if (cfg.debug) {
        console.log(`[multi-auth] Quota refresh error for ${account.label || account.email || account.index}: ${String(error)}`);
      }
      return false;
    }
  };
}
