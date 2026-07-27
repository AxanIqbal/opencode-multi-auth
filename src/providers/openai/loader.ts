import type { PluginInput } from "@opencode-ai/plugin";
import type { AccountManager } from "../../accounts/manager.js";
import type { ManagedAccount, PluginConfig } from "../../accounts/types.js";
import {
  CODEX_BASE_URL,
  DUMMY_API_KEY,
  isRateLimit,
  parseRetryAfter,
  rewriteURL,
} from "../../auth/tokens.js";
import { buildAuthHeaders } from "./headers.js";
import {
  createQuotaRefresher,
  extractQuotaFromErrorBody,
  extractQuotaFromHeaders,
} from "./quota.js";
import { toResponsesBody, wrapSSEAsChatCompletion } from "./request.js";

const RESPONSES_ENDPOINT = `${CODEX_BASE_URL}/responses`;

function extractModel(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed.model === "string" ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

export function createOpenAILoader(options: {
  cfg: PluginConfig;
  manager: AccountManager;
  client: PluginInput["client"];
  fetchWithTimeout: (url: string | URL | Request, init?: RequestInit, timeoutMs?: number) => Promise<Response>;
  showToast: (message: string, variant?: "info" | "warning" | "error") => Promise<void>;
}): () => Promise<Record<string, unknown>> {
  const { cfg, manager, client, fetchWithTimeout, showToast } = options;
  const refreshQuota = createQuotaRefresher({ cfg, manager, fetchWithTimeout });
  let lastToastAccount = -1;
  let lastToastTime = 0;
  const toastDebounce = 5000;

  return async function openAILoader(): Promise<Record<string, unknown>> {
    async function customFetch(
      input: Request | string | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const bodyStr = typeof init?.body === "string" ? init.body : undefined;
      const model = extractModel(bodyStr);
      const now = Date.now();
      let lastRateLimitHeaders: Record<string, string> | undefined;

      function retryAfterResponse(msg: string): Response {
        const reset = manager.getEarliestReset(model);
        const hdrs: Record<string, string> = { "Content-Type": "application/json" };

        if (lastRateLimitHeaders) {
          for (const [key, val] of Object.entries(lastRateLimitHeaders)) {
            if (key.startsWith("x-ratelimit-")) hdrs[key] = val;
          }
        }

        if (reset) {
          const secs = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
          hdrs["Retry-After"] = String(secs);
        } else if (!hdrs["retry-after"]) {
          hdrs["Retry-After"] = String(Math.ceil(cfg.rateLimitCooldownMs / 1000));
        }
        return new Response(JSON.stringify({ error: msg }), { status: 503, headers: hdrs });
      }

      async function selectQuotaEligible(
        excluded: Set<number>,
        allowFallback = true,
      ): Promise<ManagedAccount | null> {
        let next = await manager.selectExcluding(excluded, model, allowFallback);
        while (next) {
          if (
            await manager.ensureValidToken(next) &&
            (await refreshQuota(next, model) || !manager.requiresQuotaSnapshot(next)) &&
            manager.hasQuotaCapacity(next, model)
          ) {
            return next;
          }
          manager.releasePending(next);
          excluded.add(next.index);
          next = await manager.selectExcluding(excluded, model, allowFallback);
        }
        return null;
      }

      let account = await manager.select(model);
      if (!account) {
        for (const blocked of manager.list()) {
          await refreshQuota(blocked, model);
        }
        account = await manager.select(model);
        if (!account) {
          return retryAfterResponse("No available OpenAI accounts");
        }
      }

      if (!cfg.quietMode && manager.count() > 1) {
        const id = account.label || account.email || `Acct ${account.index + 1}`;
        if (
          account.index !== lastToastAccount ||
          now - lastToastTime > toastDebounce
        ) {
          lastToastAccount = account.index;
          lastToastTime = now;
          showToast(
            `[multi-auth] ${id} (${account.index + 1}/${manager.count()})`,
            "info",
          );
        }
      }

      const tokenOk = await manager.ensureValidToken(account);
      if (!tokenOk) {
        const failed = account;
        const prev = account.index;
        const next = await selectQuotaEligible(new Set([prev]));
        if (next) {
          if (!cfg.quietMode) {
            const from = account.label || account.email || `Acct ${prev + 1}`;
            const to = next.label || next.email || `Acct ${next.index + 1}`;
            showToast(`[multi-auth] Token refresh failed for ${from}, switching to ${to}`, "warning");
          }
          manager.releasePending(failed);
          account = next;
          const tokenOk2 = await manager.ensureValidToken(account);
          if (!tokenOk2) {
            manager.releasePending(account);
            return new Response(
              JSON.stringify({ error: "Token refresh failed for all available accounts" }),
              { status: 401, headers: { "Content-Type": "application/json" } },
            );
          }
        } else {
          manager.releasePending(failed);
          return new Response(
            JSON.stringify({ error: "Token refresh failed, no fallback accounts" }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      const quotaExcluded = new Set<number>();
      while (true) {
        if (!await manager.ensureValidToken(account)) {
          manager.releasePending(account);
          quotaExcluded.add(account.index);
          const next = await manager.selectExcluding(quotaExcluded, model, false);
          if (!next) {
            return new Response(
              JSON.stringify({ error: "Token refresh failed for all available accounts" }),
              { status: 401, headers: { "Content-Type": "application/json" } },
            );
          }
          account = next;
          continue;
        }

        const quotaUpdated = await refreshQuota(account, model);
        if ((quotaUpdated || !manager.requiresQuotaSnapshot(account)) && manager.hasQuotaCapacity(account, model)) {
          break;
        }

        quotaExcluded.add(account.index);
        manager.releasePending(account);
        const next = await manager.selectExcluding(quotaExcluded, model, false);
        if (!next) {
          return retryAfterResponse("No available OpenAI accounts within quota limits");
        }
        account = next;
      }

      const headers = buildAuthHeaders(init, account);

      const inputUrl = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const parsedUrl = new URL(inputUrl);
      const isChatEndpoint = parsedUrl.pathname === "/v1/chat/completions" || parsedUrl.pathname === "/chat/completions";

      let requestUrl: string;
      let requestInit: RequestInit;

      if (isChatEndpoint) {
        let chatBody: Record<string, unknown> | undefined;
        try {
          chatBody = bodyStr ? JSON.parse(bodyStr) : undefined;
        } catch {
          manager.releasePending(account);
          return new Response(
            JSON.stringify({ error: "Invalid request body" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        if (!chatBody) {
          manager.releasePending(account);
          return new Response(
            JSON.stringify({ error: "Empty request body" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }

        const responsesBody = toResponsesBody(chatBody);
        requestUrl = RESPONSES_ENDPOINT;
        requestInit = {
          method: "POST",
          headers: {
            ...Object.fromEntries(headers.entries()),
            "content-type": "application/json",
            "openai-beta": "responses=experimental",
          },
          body: JSON.stringify(responsesBody),
        };

        if (cfg.debug) {
          console.log(`[multi-auth] → ${account.label || account.email || `acc-${account.index}`} ${chatBody.model || ""} (responses API)`);
        }
      } else {
        let url: string;
        try {
          url = rewriteURL(inputUrl);
        } catch {
          url = inputUrl;
        }
        requestUrl = url;
        requestInit = { ...init, headers };

        if (cfg.debug) {
          console.log(`[multi-auth] → ${account.label || account.email || `acc-${account.index}`} ${model || ""}`);
        }
      }

      function withAccount(acc: ManagedAccount): RequestInit {
        if (isChatEndpoint) {
          const h = buildAuthHeaders(init, acc);
          h.set("openai-beta", "responses=experimental");
          return {
            method: "POST",
            headers: Object.fromEntries(h.entries()),
            body: requestInit.body,
          };
        }
        const h = buildAuthHeaders(init, acc);
        return { ...init, headers: h };
      }

      let response: Response;
      try {
        response = await fetchWithTimeout(requestUrl, requestInit);
      } catch (err) {
        manager.releasePending(account);
        if (cfg.debug) {
          console.log(`[multi-auth] Network error on ${account.label || account.email || `acc-${account.index}`}: ${err instanceof Error ? err.message : String(err)}`);
        }
        return new Response(
          JSON.stringify({
            error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
          }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        );
      }

      if (isRateLimit(response.status)) {
        const rlHeaders = response.headers;
        if (rlHeaders) {
          lastRateLimitHeaders = {};
          rlHeaders.forEach((val, key) => {
            const lk = key.toLowerCase();
            if (lk.startsWith("x-ratelimit-") || lk === "retry-after-ms" || lk === "retry-after") {
              lastRateLimitHeaders![lk] = val;
            }
          });
        }

        const retryBody = await response.clone().text().catch(() => undefined);
        let cooldown = Math.min(
          parseRetryAfter(response, retryBody),
          cfg.rateLimitCooldownMs,
        );

        if (retryBody) {
          const quota = extractQuotaFromErrorBody(retryBody);
          if (quota) manager.updateQuota(account, quota, model);

          if (cooldown === 60_000) {
            try {
              const body = JSON.parse(retryBody);
              const errType = body?.error?.code ?? body?.error?.type ?? "";
              if (errType === "insufficient_quota" || errType === "usage_limit_reached") {
                cooldown = 3_600_000;
              }
            } catch {}
          }
        }

        if (cfg.debug) {
          console.log(
            `[multi-auth] Rate limit (${response.status}) on ${account.label || account.email || account.index}, cooldown ${cooldown}ms`,
          );
          if (retryBody) console.log(`[multi-auth] Body: ${retryBody.slice(0, 300)}`);
        }

        manager.markRateLimited(account, cooldown, model);

        if (!cfg.quietMode) {
          const id = account.label || account.email || `Acct ${account.index + 1}`;
          const min = Math.ceil(cooldown / 60000);
          showToast(
            `[multi-auth] ${id} rate-limited. Retry in ${min}m.`,
            "warning",
          );
        }

        const excluded = new Set<number>([account.index]);
        manager.releasePending(account);
        let next = await selectQuotaEligible(excluded, false);
        while (next) {
          if (!cfg.quietMode) {
            const from = account.label || account.email || `Acct ${account.index + 1}`;
            const to = next.label || next.email || `Acct ${next.index + 1}`;
            showToast(`[multi-auth] Switching ${from} → ${to}`, "info");
          }

          await manager.ensureValidToken(next);
          if (cfg.debug) {
            console.log(`[multi-auth] Retrying on ${next.label || next.email || `acc-${next.index}`}`);
          }

          let retryResponse: Response;
          try {
            retryResponse = await fetchWithTimeout(requestUrl, withAccount(next));
          } catch (err) {
            manager.releasePending(next);
            if (cfg.debug) {
              console.log(`[multi-auth] Network error on ${next.label || next.email || `acc-${next.index}`}: ${err instanceof Error ? err.message : String(err)}`);
            }
            excluded.add(next.index);
            next = await selectQuotaEligible(excluded, false);
            continue;
          }

          if (isChatEndpoint && retryResponse.ok) {
            manager.releasePending(next);
            return wrapSSEAsChatCompletion(retryResponse, model);
          }
          if (retryResponse.ok) {
            manager.releasePending(next);
            return retryResponse;
          }

          if (isRateLimit(retryResponse.status)) {
            if (cfg.debug) {
              console.log(`[multi-auth] Retry also rate-limited (${retryResponse.status})`);
            }
            const rrlHeaders = retryResponse.headers;
            if (rrlHeaders) {
              lastRateLimitHeaders ??= {};
              rrlHeaders.forEach((val, key) => {
                const lk = key.toLowerCase();
                if (lk.startsWith("x-ratelimit-") || lk === "retry-after-ms" || lk === "retry-after") {
                  lastRateLimitHeaders![lk] = val;
                }
              });
            }
            const retryBody = await retryResponse.clone().text().catch(() => undefined);
            let retryCooldown = Math.min(
              parseRetryAfter(retryResponse, retryBody),
              cfg.rateLimitCooldownMs,
            );
            if (retryCooldown === 60_000 && retryBody) {
              try {
                const body = JSON.parse(retryBody);
                const errType = body?.error?.code ?? body?.error?.type ?? "";
                if (errType === "insufficient_quota" || errType === "usage_limit_reached") {
                  retryCooldown = 3_600_000;
                }
              } catch {}
            }
            manager.markRateLimited(next, retryCooldown, model);
            manager.releasePending(next);
            excluded.add(next.index);
            next = await selectQuotaEligible(excluded, false);
            continue;
          }

          manager.releasePending(next);
          return retryResponse;
        }

        if (!cfg.quietMode) {
          showToast("[multi-auth] All accounts rate-limited. Waiting for cooldown.", "error");
        }
        return retryAfterResponse("All OpenAI accounts are rate-limited");
      }

      if (response.status === 401) {
        if (cfg.debug) console.log("[multi-auth] 401, forcing token refresh");
        const refreshed = await manager.ensureValidToken(account);
        if (refreshed) {
          let retryResponse: Response;
          try {
            retryResponse = await fetchWithTimeout(requestUrl, withAccount(account));
          } catch (err) {
            manager.releasePending(account);
            if (cfg.debug) {
              console.log(`[multi-auth] Network error on ${account.label || account.email || `acc-${account.index}`}: ${err instanceof Error ? err.message : String(err)}`);
            }
            const next = await selectQuotaEligible(new Set([account.index]));
            if (next) {
              await manager.ensureValidToken(next);
              let retryResponse2: Response;
              try {
                retryResponse2 = await fetchWithTimeout(requestUrl, withAccount(next));
              } catch (err2) {
                manager.releasePending(next);
                if (cfg.debug) {
                  console.log(`[multi-auth] Network error on ${next.label || next.email || `acc-${next.index}`}: ${err2 instanceof Error ? err2.message : String(err2)}`);
                }
                return new Response(
                  JSON.stringify({
                    error: `Network error: ${err2 instanceof Error ? err2.message : String(err2)}`,
                  }),
                  { status: 502, headers: { "Content-Type": "application/json" } },
                );
              }
              if (isChatEndpoint && retryResponse2.ok) {
                manager.releasePending(next);
                return wrapSSEAsChatCompletion(retryResponse2, model);
              }
              manager.releasePending(next);
              return retryResponse2;
            }
            return new Response(
              JSON.stringify({
                error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
              }),
              { status: 502, headers: { "Content-Type": "application/json" } },
            );
          }
          if (isChatEndpoint && retryResponse.ok) {
            manager.releasePending(account);
            return wrapSSEAsChatCompletion(retryResponse, model);
          }
          manager.releasePending(account);
          return retryResponse;
        }

        const next = await selectQuotaEligible(new Set([account.index]));
        if (next) {
          manager.releasePending(account);
          await manager.ensureValidToken(next);
          let retryResponse: Response;
          try {
            retryResponse = await fetchWithTimeout(requestUrl, withAccount(next));
          } catch (err) {
            manager.releasePending(next);
            if (cfg.debug) {
              console.log(`[multi-auth] Network error on ${next.label || next.email || `acc-${next.index}`}: ${err instanceof Error ? err.message : String(err)}`);
            }
            return new Response(
              JSON.stringify({
                error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
              }),
              { status: 502, headers: { "Content-Type": "application/json" } },
            );
          }
          if (isChatEndpoint && retryResponse.ok) {
            manager.releasePending(next);
            return wrapSSEAsChatCompletion(retryResponse, model);
          }
          manager.releasePending(next);
          return retryResponse;
        }

        manager.releasePending(account);
        return response;
      }

      if (response.status === 400) {
        const next = await selectQuotaEligible(new Set([account.index]));
        if (next) {
          if (!cfg.quietMode) {
            const from = account.label || account.email || `Acct ${account.index + 1}`;
            const to = next.label || next.email || `Acct ${next.index + 1}`;
            showToast(`[multi-auth] Model issue on ${from}, trying ${to}`, "info");
          }
          manager.releasePending(account);
          await manager.ensureValidToken(next);
          let retryResponse: Response;
          try {
            retryResponse = await fetchWithTimeout(requestUrl, withAccount(next));
          } catch (err) {
            manager.releasePending(next);
            if (cfg.debug) {
              console.log(`[multi-auth] Network error on ${next.label || next.email || `acc-${next.index}`}: ${err instanceof Error ? err.message : String(err)}`);
            }
            return new Response(
              JSON.stringify({
                error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
              }),
              { status: 502, headers: { "Content-Type": "application/json" } },
            );
          }
          if (isChatEndpoint && retryResponse.ok) {
            manager.releasePending(next);
            return wrapSSEAsChatCompletion(retryResponse, model);
          }
          manager.releasePending(next);
          return retryResponse;
        }
      }

      if (isChatEndpoint && response.ok) {
        const quota = extractQuotaFromHeaders(response.headers);
        if (quota) manager.updateQuota(account, quota, model);
        manager.releasePending(account);
        return wrapSSEAsChatCompletion(response, model);
      }

      manager.releasePending(account);
      return response;
    }

    return {
      apiKey: DUMMY_API_KEY,
      baseURL: CODEX_BASE_URL,
      fetch: customFetch,
    };
  };
}
