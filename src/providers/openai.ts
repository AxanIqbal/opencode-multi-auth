import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import type { AccountManager } from "../accounts/manager.js";
import type { ManagedAccount, PluginConfig, QuotaSnapshot } from "../accounts/types.js";
import {
  CODEX_BASE_URL,
  DUMMY_API_KEY,
  isRateLimit,
  parseRetryAfter,
  rewriteURL,
} from "../auth/tokens.js";

const RESPONSES_ENDPOINT = `${CODEX_BASE_URL}/responses`;
const REASONING_VARIANTS = ["low", "medium", "high", "xhigh"] as const;
const REASONING_VARIANT_CONFIG = Object.fromEntries(
  REASONING_VARIANTS.map((effort) => [effort, { reasoningEffort: effort }]),
);

const CODEX_MODELS = [
  "gpt-5.5", "gpt-5.4-mini", "codex-auto-review",
];

interface SSEData {
  event: string;
  data: string;
}

function parseSSE(body: string): SSEData[] {
  const events: SSEData[] = [];
  let currentEvent = "";
  let currentData = "";

  for (const line of body.split("\n")) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      currentData = line.slice(6);
    } else if (line === "") {
      if (currentData) {
        events.push({ event: currentEvent, data: currentData });
      }
      currentEvent = "";
      currentData = "";
    }
  }

  if (currentData) {
    events.push({ event: currentEvent, data: currentData });
  }

  return events;
}

function extractQuotaFromErrorBody(body: string): QuotaSnapshot | undefined {
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

function extractQuotaFromHeaders(headers: Headers): QuotaSnapshot | undefined {
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
      const n = parseInt(remaining, 10);
      if (Number.isFinite(n)) primary.usedPercent = Math.max(0, Math.min(100, 100 - n));
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

function buildChatCompletionFromSSE(
  events: SSEData[],
  model: string,
): Record<string, unknown> {
  let fullText = "";
  let responseId = `chatcmpl-${crypto.randomUUID()}`;
  let created = Math.floor(Date.now() / 1000);
  let usage: Record<string, number> = {};

  for (const evt of events) {
    try {
      const parsed = JSON.parse(evt.data);

      if (evt.event === "response.output_text.delta") {
        fullText += parsed.delta || "";
      }

      if (evt.event === "response.completed" && parsed.response) {
        created = parsed.response.created_at;
        if (parsed.response.id) responseId = parsed.response.id;
        if (parsed.response.usage) {
          usage = {
            prompt_tokens: parsed.response.usage.input_tokens || 0,
            completion_tokens: parsed.response.usage.output_tokens || 0,
            total_tokens: parsed.response.usage.total_tokens || 0,
          };
        }
      }
    } catch { /* skip malformed events */ }
  }

  return {
    id: responseId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: fullText,
        },
        finish_reason: "stop",
      },
    ],
    usage,
  };
}

function toResponsesBody(chatBody: Record<string, unknown>): Record<string, unknown> {
  const messages = (chatBody.messages as Array<Record<string, unknown>>) || [];

  let instructions = "You are a helpful assistant.";
  const filteredMessages = messages.filter((m) => {
    if (m.role === "system") {
      instructions = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return false;
    }
    return true;
  });

  const input = filteredMessages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  }));

  const body: Record<string, unknown> = {
    model: chatBody.model,
    input,
    instructions,
    store: false,
    stream: true,
  };

  const effort =
    typeof chatBody.reasoningEffort === "string" ? chatBody.reasoningEffort
      : typeof chatBody.reasoning_effort === "string" ? chatBody.reasoning_effort
        : undefined;
  if (effort && REASONING_VARIANTS.includes(effort as typeof REASONING_VARIANTS[number])) {
    body.reasoning = { effort };
  }

  return body;
}

async function wrapSSEAsChatCompletion(
  sseResponse: Response,
  model: string | undefined,
): Promise<Response> {
  const sseText = await sseResponse.text();
  const events = parseSSE(sseText);
  const completion = buildChatCompletionFromSSE(events, model || "");
  return new Response(JSON.stringify(completion), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const CODEX_INSTALLATION_ID: string | undefined = (() => {
  try {
    const p = join(homedir(), ".codex", "installation_id");
    if (existsSync(p)) return readFileSync(p, "utf-8").trim();
  } catch { /* best-effort */ }
  return undefined;
})();

function traceparent(): string {
  const traceId = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const spanId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return `00-${traceId}-${spanId}-01`;
}

function extractModel(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed.model === "string" ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

function buildAuthHeaders(
  init: RequestInit | undefined,
  account: ManagedAccount,
): Headers {
  const headers = new Headers(init?.headers);
  const bearerToken = account.apiKey ?? account.access;
  headers.delete("authorization");
  headers.delete("Authorization");
  headers.delete("openai-authorization");
  headers.set("authorization", `Bearer ${bearerToken}`);
  headers.set("openai-authorization", `Bearer ${bearerToken}`);

  if (account.accountId) {
    headers.set("chatgpt-account-id", account.accountId);
  }

  headers.set("user-agent", "Codex/codex_cli_rs");
  headers.set("x-client-request-id", crypto.randomUUID());
  if (CODEX_INSTALLATION_ID) {
    headers.set("x-codex-installation-id", CODEX_INSTALLATION_ID);
  }
  headers.set("traceparent", traceparent());

  return headers;
}

export function createOpenAILoader(options: {
  cfg: PluginConfig;
  manager: AccountManager;
  client: PluginInput["client"];
  fetchWithTimeout: (url: string | URL | Request, init?: RequestInit, timeoutMs?: number) => Promise<Response>;
  showToast: (message: string, variant?: "info" | "warning" | "error") => Promise<void>;
}): () => Promise<Record<string, unknown>> {
  const { cfg, manager, client, fetchWithTimeout, showToast } = options;
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
      manager.importApiKeyFromOpenCodeAuth("openai", "OpenAI API Key");

      function retryAfterResponse(msg: string): Response {
        const reset = manager.getEarliestReset(model);
        const hdrs: Record<string, string> = { "Content-Type": "application/json" };

        if (lastRateLimitHeaders) {
          for (const key of ["retry-after-ms", "retry-after", "retry-after-ms"] as const) {
            if (lastRateLimitHeaders[key]) hdrs[key] = lastRateLimitHeaders[key];
          }
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

      let account = await manager.select(model);
      if (!account) {
        return retryAfterResponse("No available OpenAI accounts");
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
        const next = await manager.selectExcluding(new Set([prev]), model);
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
        let cooldown = parseRetryAfter(response, retryBody);

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
        let next = await manager.selectExcluding(excluded, model, false);
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
            next = await manager.selectExcluding(excluded, model, false);
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
            let retryCooldown = parseRetryAfter(retryResponse, retryBody);
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
            next = await manager.selectExcluding(excluded, model, false);
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
            const next = await manager.selectExcluding(new Set([account.index]), model);
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

        const next = await manager.selectExcluding(new Set([account.index]), model);
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
        const next = await manager.selectExcluding(new Set([account.index]), model);
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

export function registerOpenAIModels(models: Record<string, unknown>): void {
  for (const id of CODEX_MODELS) {
    if (!models[id]) {
      models[id] = { name: id };
    }
    if (id.startsWith("gpt-")) {
      const model = models[id] as Record<string, unknown> & {
        variants?: Record<string, Record<string, unknown>>;
      };
      model.variants = {
        ...(model.variants ?? {}),
        ...REASONING_VARIANT_CONFIG,
      };
    }
  }
}
