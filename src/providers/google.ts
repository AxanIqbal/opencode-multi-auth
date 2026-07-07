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
}): () => Promise<Record<string, unknown>> {
  const { cfg, googleManager, fetchWithTimeout } = options;

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
        return new Response(
          JSON.stringify({ error: "No available Google API-key accounts" }),
          { status: 503, headers: { "Content-Type": "application/json", "Retry-After": String(Math.ceil(cfg.rateLimitCooldownMs / 1000)) } },
        );
      }

      const prepared = withGoogleApiKey(inputUrl, init, account.apiKey);
      let response: Response;
      try {
        response = await fetchWithTimeout(prepared.url, prepared.init);
      } catch (err) {
        googleManager.releasePending(account.index);
        return new Response(
          JSON.stringify({ error: `Network error: ${err instanceof Error ? err.message : String(err)}` }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        );
      }

      if (response.ok) {
        googleManager.releasePending(account.index);
        return response;
      }

      if (isRateLimit(response.status) || response.status === 401 || response.status === 403 || response.status === 400) {
        const body = await response.clone().text().catch(() => undefined);
        const cooldown = isRateLimit(response.status) ? parseRetryAfter(response, body) : cfg.rateLimitCooldownMs;
        googleManager.markRateLimited(account, cooldown, model);
        const excluded = new Set<number>([account.index]);
        googleManager.releasePending(account.index);

        let next = await googleManager.selectExcluding(excluded, model, false);
        while (next?.apiKey) {
          const nextPrepared = withGoogleApiKey(inputUrl, init, next.apiKey);
          let retryResponse: Response;
          try {
            retryResponse = await fetchWithTimeout(nextPrepared.url, nextPrepared.init);
          } catch {
            googleManager.releasePending(next.index);
            excluded.add(next.index);
            next = await googleManager.selectExcluding(excluded, model, false);
            continue;
          }

          if (retryResponse.ok) {
            googleManager.releasePending(next.index);
            return retryResponse;
          }

          if (isRateLimit(retryResponse.status) || retryResponse.status === 401 || retryResponse.status === 403 || retryResponse.status === 400) {
            const retryBody = await retryResponse.clone().text().catch(() => undefined);
            const retryCooldown = isRateLimit(retryResponse.status) ? parseRetryAfter(retryResponse, retryBody) : cfg.rateLimitCooldownMs;
            googleManager.markRateLimited(next, retryCooldown, model);
            googleManager.releasePending(next.index);
            excluded.add(next.index);
            next = await googleManager.selectExcluding(excluded, model, false);
            continue;
          }

          googleManager.releasePending(next.index);
          return retryResponse;
        }
      }

      googleManager.releasePending(account.index);
      return response;
    }

    const firstAccount = googleManager.list().find((account) => account.apiKey);
    return {
      apiKey: firstAccount?.apiKey ?? DUMMY_API_KEY,
      fetch: customGoogleFetch,
    };
  };
}
