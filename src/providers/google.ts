import type { AccountManager } from "../accounts/manager.js";
import type { PluginConfig } from "../accounts/types.js";
import { DUMMY_API_KEY, isRateLimit, parseRetryAfter } from "../auth/tokens.js";

export const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-image",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro",
  "gemini-2.5-pro-preview-tts",
  "gemini-3-flash-preview",
  "gemini-3-pro-image-preview",
  "gemini-3.1-flash-image-preview",
  "gemini-3.1-flash-lite",
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-3.5-flash",
  "gemini-embedding-001",
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
  "gemma-4-26b-a4b-it",
  "gemma-4-31b-it",
];

export function extractGoogleModelFromUrl(input: string): string | undefined {
  try {
    const url = new URL(input);
    const match = url.pathname.match(/\/models\/([^/:]+)(?::|$)/);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

export function withGoogleApiKey(input: string, init: RequestInit | undefined, apiKey: string): { url: string; init: RequestInit } {
  const url = new URL(input);
  url.searchParams.set("key", apiKey);
  const headers = new Headers(init?.headers);
  headers.set("x-goog-api-key", apiKey);
  return {
    url: url.toString(),
    init: { ...init, headers },
  };
}

export function createGoogleLoader(options: {
  cfg: PluginConfig;
  googleManager: AccountManager;
  fetchWithTimeout: (url: string | URL | Request, init?: RequestInit, timeoutMs?: number) => Promise<Response>;
  showToast?: (message: string, variant?: "info" | "warning" | "error") => Promise<void>;
}): () => Promise<Record<string, unknown>> {
  const { cfg, googleManager, fetchWithTimeout, showToast } = options;
  let lastToastAccount = -1;
  let lastToastTime = 0;
  const toastDebounce = 5000;

  async function notify(message: string, variant: "info" | "warning" | "error" = "info"): Promise<void> {
    if (cfg.quietMode || !showToast) return;
    await showToast(message, variant);
  }

  function retryAfterResponse(message: string, model: string | undefined): Response {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const reset = googleManager.getEarliestReset(model);
    if (reset) {
      headers["Retry-After"] = String(Math.max(1, Math.ceil((reset - Date.now()) / 1000)));
    } else {
      headers["Retry-After"] = String(Math.ceil(cfg.rateLimitCooldownMs / 1000));
    }
    return new Response(JSON.stringify({ error: message }), { status: 503, headers });
  }

  return async function googleLoader(): Promise<Record<string, unknown>> {
    async function customGoogleFetch(
      input: Request | string | URL,
      init?: RequestInit,
    ): Promise<Response> {
      googleManager.importApiKeyFromOpenCodeAuth("google", "OpenCode Google");
      const inputUrl = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      const model = extractGoogleModelFromUrl(inputUrl);
      let account = await googleManager.select(model);
      if (!account?.apiKey) {
        const message = googleManager.count() > 0
          ? `All Google API-key accounts are unavailable for ${model ?? "this request"}. Waiting for cooldown.`
          : "No Google API-key accounts configured. Run opencode auth login and choose Google API Key.";
        if (cfg.debug) console.log(`[multi-auth] ${message}`);
        await notify(`[multi-auth] ${message}`, googleManager.count() > 0 ? "warning" : "error");
        return retryAfterResponse(message, model);
      }

      if (cfg.debug) {
        console.log(`[multi-auth] → ${account.label || `Google ${account.index + 1}`} ${model ?? "google"} (google API)`);
      }

      if (!cfg.quietMode && googleManager.count() > 1) {
        const id = account.label || `Google ${account.index + 1}`;
        const now = Date.now();
        if (account.index !== lastToastAccount || now - lastToastTime > toastDebounce) {
          lastToastAccount = account.index;
          lastToastTime = now;
          await notify(`[multi-auth] ${id} (${account.index + 1}/${googleManager.count()})`, "info");
        }
      }

      const prepared = withGoogleApiKey(inputUrl, init, account.apiKey);
      let response: Response;
      try {
        response = await fetchWithTimeout(prepared.url, prepared.init);
      } catch (err) {
        googleManager.releasePending(account);
        return new Response(
          JSON.stringify({ error: `Network error: ${err instanceof Error ? err.message : String(err)}` }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        );
      }

      if (response.ok) {
        googleManager.releasePending(account);
        return response;
      }

      if (isRateLimit(response.status) || response.status === 401 || response.status === 403 || response.status === 400) {
        const body = await response.clone().text().catch(() => undefined);
        const cooldown = isRateLimit(response.status) ? parseRetryAfter(response, body) : cfg.rateLimitCooldownMs;
        googleManager.markRateLimited(account, cooldown, model);
        if (cfg.debug) {
          console.log(`[multi-auth] Google unavailable (${response.status}) on ${account.label || `Google ${account.index + 1}`}, cooldown ${cooldown}ms`);
        }
        await notify(`[multi-auth] ${account.label || `Google ${account.index + 1}`} unavailable for ${model ?? "Google"}. Trying another key.`, "warning");
        const excluded = new Set<number>([account.index]);
        googleManager.releasePending(account);

        let next = await googleManager.selectExcluding(excluded, model, false);
        while (next?.apiKey) {
          await notify(`[multi-auth] Switching ${account.label || `Google ${account.index + 1}`} → ${next.label || `Google ${next.index + 1}`}`, "info");
          if (cfg.debug) console.log(`[multi-auth] Retrying Google on ${next.label || `Google ${next.index + 1}`}`);
          const nextPrepared = withGoogleApiKey(inputUrl, init, next.apiKey);
          let retryResponse: Response;
          try {
            retryResponse = await fetchWithTimeout(nextPrepared.url, nextPrepared.init);
          } catch {
            googleManager.releasePending(next);
            excluded.add(next.index);
            next = await googleManager.selectExcluding(excluded, model, false);
            continue;
          }

          if (retryResponse.ok) {
            googleManager.releasePending(next);
            return retryResponse;
          }

          if (isRateLimit(retryResponse.status) || retryResponse.status === 401 || retryResponse.status === 403 || retryResponse.status === 400) {
            const retryBody = await retryResponse.clone().text().catch(() => undefined);
            const retryCooldown = isRateLimit(retryResponse.status) ? parseRetryAfter(retryResponse, retryBody) : cfg.rateLimitCooldownMs;
            googleManager.markRateLimited(next, retryCooldown, model);
            await notify(`[multi-auth] ${next.label || `Google ${next.index + 1}`} unavailable for ${model ?? "Google"}. Trying another key.`, "warning");
            googleManager.releasePending(next);
            excluded.add(next.index);
            next = await googleManager.selectExcluding(excluded, model, false);
            continue;
          }

          googleManager.releasePending(next);
          return retryResponse;
        }

        await notify(`[multi-auth] All Google API-key accounts are unavailable for ${model ?? "this request"}. Waiting for cooldown.`, "error");
        return retryAfterResponse(`All Google API-key accounts are unavailable for ${model ?? "this request"}`, model);
      }

      googleManager.releasePending(account);
      return response;
    }

    googleManager.importApiKeyFromOpenCodeAuth("google", "OpenCode Google");
    const firstAccount = googleManager.list().find((account) => account.apiKey);
    return {
      apiKey: firstAccount?.apiKey ?? DUMMY_API_KEY,
      fetch: customGoogleFetch,
    };
  };
}
