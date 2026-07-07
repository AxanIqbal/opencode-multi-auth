/**
 * opencode-multi-auth — OpenCode plugin for multi-account OpenAI rotation.
 *
 * Transparently overrides the built-in `openai` provider with automatic
 * account rotation on rate limits (429, 503, 529). Use `openai/<model>`
 * exactly as you normally would — the plugin handles the rest.
 *
 * Features:
 *  - Add accounts by pasting access_token + refresh_token directly
 *  - Full OAuth browser flow also supported
 *  - Auto-rotate on rate limits (429, 503, 529)
 *  - Automatic token refresh before expiry
 *  - Session-bound account stickiness
 *  - Per-account health tracking and cooldowns
 *
 * Provider ID: `openai` (overrides built-in)
 *
 * Install:
 *   1. opencode plugin add opencode-multi-auth
 *   2. opencode auth login  → choose an auth method
 *   3. opencode run -m openai/gpt-4o  → rotation works transparently
 */

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tool, type Plugin, type PluginInput, type PluginOptions, type AuthOAuthResult } from "@opencode-ai/plugin";
import { AccountManager } from "./accounts/manager.js";
import type { PluginConfig, QuotaSnapshot } from "./accounts/types.js";
import { resolveConfig } from "./accounts/types.js";
import {
  decodeJWT,
  extractAccountId,
  extractEmail,
  extractPlanType,
} from "./auth/tokens.js";
import { GOOGLE_ACCOUNTS_FILE } from "./lib/storage.js";
import { createGoogleLoader, GEMINI_MODELS } from "./providers/google.js";
import { createOpenAILoader, registerOpenAIModels } from "./providers/openai.js";

// ── Constants ──────────────────────────────────────────────

const OPENAI_PROVIDER_ID = "openai";
const GOOGLE_PROVIDER_ID = "google";

const TOKEN_MAINTENANCE_INTERVAL_MS = 30 * 60 * 1000;
type ProviderMode = "openai" | "google";

function providerMode(options?: PluginOptions): ProviderMode {
  return options?.provider === GOOGLE_PROVIDER_ID ? GOOGLE_PROVIDER_ID : OPENAI_PROVIDER_ID;
}

// ── Plugin config from environment ─────────────────────────

function envConfig(): Partial<PluginConfig> {
   const strategy = process.env.OPENCODE_MULTI_AUTH_STRATEGY as
     | "sticky"
     | "round-robin"
     | "quota-aware"
     | undefined;
   return {
     accountSelectionStrategy: strategy,
     debug: process.env.OPENCODE_MULTI_AUTH_DEBUG === "1",
     quietMode: process.env.OPENCODE_MULTI_AUTH_QUIET === "1",
     pidOffsetEnabled: process.env.OPENCODE_MULTI_AUTH_PID_OFFSET === "1",
     perModelRateLimits: process.env.OPENCODE_MULTI_AUTH_PER_MODEL !== "0",
     rateLimitCooldownMs: parseInt(
       process.env.OPENCODE_MULTI_AUTH_COOLDOWN_MS ?? "",
       10,
     ) || 60_000,
     fetchTimeoutMs: parseInt(
       process.env.OPENCODE_MULTI_AUTH_FETCH_TIMEOUT_MS ?? "",
       10,
     ) || 300_000,
     quotaCriticalThresholdPercent: parseInt(
       process.env.OPENCODE_MULTI_AUTH_QUOTA_CRITICAL_PERCENT ?? "",
       10,
     ) || 95,
   };
}

// ── Helpers ────────────────────────────────────────────────

function formatReset(resetsAt: number | undefined, now: number): string | undefined {
  if (!resetsAt) return undefined;
  const minutes = Math.max(0, Math.ceil((resetsAt - now) / 60000));
  if (minutes <= 0) return "reset now";
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  return `resets in ${hours}h`;
}

function formatQuota(quota: QuotaSnapshot | undefined, now: number): string {
  if (!quota) return "";

  const parts: string[] = [];
  if (quota.primary) {
    const reset = formatReset(quota.primary.resetsAt, now);
    if (typeof quota.primary.usedPercent === "number") {
      parts.push(`5h ${Math.max(0, Math.round(100 - quota.primary.usedPercent))}% left${reset ? `, ${reset}` : ""}`);
    } else if (reset) {
      parts.push(reset);
    }
  }

  if (quota.secondary) {
    const reset = formatReset(quota.secondary.resetsAt, now);
    if (typeof quota.secondary.usedPercent === "number") {
      parts.push(`weekly ${Math.max(0, Math.round(100 - quota.secondary.usedPercent))}% left${reset ? `, ${reset}` : ""}`);
    } else if (reset) {
      parts.push(reset);
    }
  }

  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

// ── Toast helpers ──────────────────────────────────────────

async function showToast(
  client: PluginInput["client"],
  message: string,
  variant: "info" | "warning" | "error" = "info",
): Promise<void> {
  try {
    await client.tui.showToast({ body: { message, variant } });
  } catch {
    // TUI not available
  }
}

// ── Plugin factory ─────────────────────────────────────────

export const MultiAuthPlugin: Plugin = async ({ client }: PluginInput, options?: PluginOptions) => {
    const cfg = resolveConfig(envConfig());
    const mode = providerMode(options);

    const manager = new AccountManager(cfg);
    const googleManager = new AccountManager(cfg, GOOGLE_ACCOUNTS_FILE);
    manager.load();
    googleManager.load();
    manager.importFromOpenCodeAuth();
   void manager.refreshExpiringTokens();
   const tokenMaintenanceTimer = setInterval(() => {
     void manager.refreshExpiringTokens();
   }, TOKEN_MAINTENANCE_INTERVAL_MS);
   tokenMaintenanceTimer.unref?.();

    // ── Timeout wrapper ──────────────────────────────────
   async function fetchWithTimeout(
     url: string | URL | Request,
     init?: RequestInit,
     timeoutMs: number = cfg.fetchTimeoutMs,
   ): Promise<Response> {
     const controller = new AbortController();
     const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
     try {
       return await globalThis.fetch(url, { ...init, signal: controller.signal });
     } catch (err) {
       if (err instanceof Error && err.name === "AbortError") {
         throw new Error("The operation timed out.");
       }
       throw err;
     } finally {
       clearTimeout(timeoutId);
     }
    }

    const googleLoader = createGoogleLoader({ cfg, googleManager, fetchWithTimeout });
    const openAILoader = createOpenAILoader({
      cfg,
      manager,
      client,
      fetchWithTimeout,
      showToast: (message, variant) => showToast(client, message, variant),
    });

  // ── OAuth flow builder (Auto) ──────────────────────────

  function buildAutoFlow(
    verifier: string,
    state: string,
    url: string,
    server: { waitForCode: (s: string) => Promise<{ code: string } | null>; close: () => void },
  ): AuthOAuthResult {
    return {
      url,
      method: "auto",
      instructions: "Complete the OAuth flow in your browser.",
      callback: async () => {
        const result = await server.waitForCode(state);
        server.close();
        if (!result) return { type: "failed" };

        // Exchange code for tokens
        const tokens = await exchangeCode(result.code, verifier);
        if (tokens.type !== "success") return { type: "failed" };

        // Add to account manager
        const info = tokens.access ? decodeJWT(tokens.access) : null;
        const email = info ? extractEmail(info) : undefined;
        manager.addAccount(tokens.refresh, tokens.access, tokens.expires, email);

        return {
          type: "success",
          provider: OPENAI_PROVIDER_ID,
          refresh: tokens.refresh,
          access: tokens.access,
          expires: tokens.expires,
        };
      },
    };
  }

  // ── OAuth flow builder (Manual / code input) ───────────

  function buildManualFlow(
    verifier: string,
    expectedState: string,
    url: string,
  ): AuthOAuthResult {
    return {
      url,
      method: "code",
      instructions:
        "Open the URL in your browser, complete the flow, and paste the full redirect URL (or the code parameter) here.",
      callback: async (input: string) => {
        // Parse the code from either a full URL or just the code parameter
        let code: string | undefined;
        try {
          const parsed = new URL(input);
          code = parsed.searchParams.get("code") ?? undefined;
          const state = parsed.searchParams.get("state");
          if (state && state !== expectedState) {
            console.error("[multi-auth] State mismatch in manual OAuth flow");
            return { type: "failed" };
          }
        } catch {
          // Not a URL — treat the whole input as the code
          code = input;
        }

        if (!code) return { type: "failed" };

        const tokens = await exchangeCode(code, verifier);
        if (tokens.type !== "success") return { type: "failed" };

        const info = tokens.access ? decodeJWT(tokens.access) : null;
        const email = info ? extractEmail(info) : undefined;
        manager.addAccount(tokens.refresh, tokens.access, tokens.expires, email);

        return {
          type: "success",
          provider: OPENAI_PROVIDER_ID,
          refresh: tokens.refresh,
          access: tokens.access,
          expires: tokens.expires,
        };
      },
    };
  }

  // ── Return hooks ───────────────────────────────────────

  return {
    dispose: async () => {
      googleManager.importApiKeyFromOpenCodeAuth("google", "OpenCode Google");
    },

    auth: {
      provider: mode,
      loader: mode === GOOGLE_PROVIDER_ID ? googleLoader : openAILoader,
      methods: mode === GOOGLE_PROVIDER_ID ? [
        {
          type: "api",
          label: "Google API Key",
          prompts: [
            {
              type: "text",
              key: "api_key",
              message: "Paste your Google AI Studio API key:",
              placeholder: "AIza...",
            },
            {
              type: "text",
              key: "label",
              message: "Label for this Google account/key:",
              placeholder: "personal / work / project name",
            },
          ],
          authorize: async (inputs) => {
            const apiKey = inputs?.api_key?.trim();
            if (!apiKey) {
              console.error("[multi-auth] Google API key is required");
              return { type: "failed" };
            }
            const account = googleManager.addApiKey(apiKey, inputs?.label?.trim() || undefined);
            console.log(`[multi-auth] Google API key added: ${account.label || `Google ${account.index + 1}`}`);
            return {
              type: "success",
              key: apiKey,
              provider: GOOGLE_PROVIDER_ID,
            };
          },
        },
      ] : [
        {
          type: "oauth",
          label: "ChatGPT OAuth (Browser)",
          authorize: async () => {
            const flow = await createOAuthFlow();
            const serverInfo = await startLocalServer(flow.state);
            openBrowser(flow.url);

            if (!serverInfo.ready) {
              serverInfo.close();
              return buildManualFlow(flow.pkceVerifier, flow.state, flow.url);
            }

            return buildAutoFlow(flow.pkceVerifier, flow.state, flow.url, serverInfo);
          },
        },
        {
          type: "api",
          label: "Add Account (Paste Token)",
          prompts: [
            {
              type: "text",
              key: "access_token",
              message: "Paste your OpenAI access token (JWT):",
              placeholder: "eyJhbGciOiJSUzI1NiIs...",
            },
            {
              type: "text",
              key: "refresh_token",
              message: "Paste your OpenAI refresh token:",
              placeholder: "eyJhbGciOiJSUzI1NiIs...",
            },
          ],
          authorize: async (inputs) => {
            const access = inputs?.access_token;
            const refresh = inputs?.refresh_token;
            if (!access || !refresh) {
              console.error("[multi-auth] Both access_token and refresh_token are required");
              return { type: "failed" };
            }

            const claims = decodeJWT(access);
            if (!claims) {
              console.error("[multi-auth] Invalid access token (not a valid JWT)");
              return { type: "failed" };
            }

            const email = extractEmail(claims);
            const planType = extractPlanType(claims);
            const accountId = extractAccountId(claims);
            manager.addAccount(refresh, access, Date.now() + 3600_000, email);
            const label = email || "Account";
            console.log(`[multi-auth] Account added: ${label}${planType ? ` [${planType}]` : ""}`);

            return {
              type: "success",
              key: OPENAI_PROVIDER_ID,
              provider: OPENAI_PROVIDER_ID,
            };
          },
        },
        {
          type: "oauth",
          label: "ChatGPT OAuth (Manual / Headless)",
          authorize: async () => {
            const flow = await createOAuthFlow();
            return buildManualFlow(flow.pkceVerifier, flow.state, flow.url);
          },
        },
        {
          type: "api",
          label: "OpenAI API Key",
        },
      ],
    },

    // ── Tool: list accounts ───────────────────────────────
    tool: {
      "multi-auth-list": tool({
        description: "List all configured OpenAI accounts and their health status.",
        args: {},
        async execute() {
          const accounts = manager.list();
          googleManager.importApiKeyFromOpenCodeAuth("google", "OpenCode Google");
          const googleAccounts = googleManager.list();
          if (accounts.length === 0 && googleAccounts.length === 0) {
            return [
              "Multi-Account Status",
              "",
              "  No accounts configured.",
              "",
              "  Add one:  opencode auth login",
              "",
            ].join("\n");
          }

          const now = Date.now();
          const active = manager.getActive();
          const lines: string[] = [
            `OpenAI Multi-Account Status (${accounts.length} accounts)`,
            "",
          ];

          for (const acct of accounts) {
            const isActive = active && acct.index === active.index;
            const label = acct.label || acct.email || `Account ${acct.index + 1}`;
            const plan = acct.planType ? ` [${acct.planType}]` : "";
            const priority = ` priority=${acct.priority ?? 0}`;
            const status = acct.consecutiveFailures >= 3 ? "[DISABLED]"
              : isActive ? "[ACTIVE]"
              : "[READY]";
            const limited = acct.globalRateLimitReset && acct.globalRateLimitReset > now
              ? ` (rate-limited until ${new Date(acct.globalRateLimitReset).toLocaleTimeString()})`
              : "";
            const quota = formatQuota(acct.quota, now);
            lines.push(`  ${status} #${acct.index + 1} ${label}${plan}${priority}${quota}${limited}`);
          }

          lines.push("", `Google API-Key Accounts (${googleAccounts.length} accounts)`);
          for (const acct of googleAccounts) {
            const label = acct.label || `Google ${acct.index + 1}`;
            const priority = ` priority=${acct.priority ?? 0}`;
            const status = acct.consecutiveFailures >= 3 ? "[DISABLED]" : "[READY]";
            const limited = acct.globalRateLimitReset && acct.globalRateLimitReset > now
              ? ` (rate-limited until ${new Date(acct.globalRateLimitReset).toLocaleTimeString()})`
              : "";
            lines.push(`  ${status} #${acct.index + 1} ${label}${priority}${limited}`);
          }

          return lines.join("\n");
        },
      }),
      "multi-auth-set-priority": tool({
        description: "Set an OpenAI account priority. Lower numbers are selected first; higher numbers are fallback accounts.",
        args: {
          account: tool.schema.number().int().min(1).describe("Displayed account number from multi-auth-list, starting at 1."),
          priority: tool.schema.number().int().min(0).describe("Selection priority. 0 is preferred; larger numbers are fallback tiers."),
        },
        async execute(args) {
          const account = manager.setPriority(args.account - 1, args.priority);
          if (!account) {
            return `No account #${args.account}. Run multi-auth-list to see available accounts.`;
          }
          const label = account.label || account.email || `Account ${account.index + 1}`;
          return `Set #${account.index + 1} ${label} priority=${account.priority ?? 0}. Lower numbers are selected first.`;
        },
      }),
      "multi-auth-set-google-priority": tool({
        description: "Set a Google API-key account priority. Lower numbers are selected first; higher numbers are fallback accounts.",
        args: {
          account: tool.schema.number().int().min(1).describe("Displayed Google account number from multi-auth-list, starting at 1."),
          priority: tool.schema.number().int().min(0).describe("Selection priority. 0 is preferred; larger numbers are fallback tiers."),
        },
        async execute(args) {
          const account = googleManager.setPriority(args.account - 1, args.priority);
          if (!account) {
            return `No Google account #${args.account}. Run multi-auth-list to see available accounts.`;
          }
          const label = account.label || `Google ${account.index + 1}`;
          return `Set Google #${account.index + 1} ${label} priority=${account.priority ?? 0}. Lower numbers are selected first.`;
        },
      }),
    },

    // ── Config hook: register tool + models ────────────
    config: async (cfg) => {
      cfg.command = cfg.command || {};
      cfg.command["multi-auth-list"] = {
        template:
          "Run the multi-auth-list tool and output the result EXACTLY as returned, without any additional text.",
        description: "List all configured OpenAI accounts and their status.",
      };
      cfg.command["multi-auth-set-priority"] = {
        template:
          "Use the multi-auth-set-priority tool to set the requested account number and priority, then output the result EXACTLY as returned, without any additional text.",
        description: "Set an OpenAI account priority. Lower numbers are selected first.",
      };
      cfg.command["multi-auth-set-google-priority"] = {
        template:
          "Use the multi-auth-set-google-priority tool to set the requested Google account number and priority, then output the result EXACTLY as returned, without any additional text.",
        description: "Set a Google API-key account priority. Lower numbers are selected first.",
      };
      cfg.experimental = cfg.experimental || {};
      cfg.experimental.primary_tools = cfg.experimental.primary_tools || [];
      if (!cfg.experimental.primary_tools.includes("multi-auth-list")) {
        cfg.experimental.primary_tools.push("multi-auth-list");
      }
      if (!cfg.experimental.primary_tools.includes("multi-auth-set-priority")) {
        cfg.experimental.primary_tools.push("multi-auth-set-priority");
      }
      if (!cfg.experimental.primary_tools.includes("multi-auth-set-google-priority")) {
        cfg.experimental.primary_tools.push("multi-auth-set-google-priority");
      }

      cfg.provider = cfg.provider || {};

      if (mode === OPENAI_PROVIDER_ID) {
        cfg.provider.openai = cfg.provider.openai || {};
        cfg.provider.openai.models = cfg.provider.openai.models || {};
        registerOpenAIModels(cfg.provider.openai.models as Record<string, unknown>);
      }

      if (mode === GOOGLE_PROVIDER_ID) {
        cfg.provider.google = cfg.provider.google || {};
        cfg.provider.google.models = cfg.provider.google.models || {};
        const models = cfg.provider.google.models;
        for (const id of GEMINI_MODELS) {
          if (!models[id]) {
            models[id] = { name: id };
          }
        }
      }
    },
  };
};

export default MultiAuthPlugin;

// ── OAuth flow primitives ──────────────────────────────────

const OAUTH_ISSUER = "https://auth.openai.com";
const OAUTH_AUTHORIZE_URL = `${OAUTH_ISSUER}/oauth/authorize`;
const OAUTH_TOKEN_URL = `${OAUTH_ISSUER}/oauth/token`;
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REDIRECT_URI = "http://localhost:1455/auth/callback";

/** Generate PKCE challenge pair. */
async function createPKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64URLEncode(crypto.getRandomValues(new Uint8Array(32)));
  const challengeBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = base64URLEncode(new Uint8Array(challengeBuffer));
  return { verifier, challenge };
}

function base64URLEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Create the full OAuth authorization flow parameters. */
async function createOAuthFlow(): Promise<{
  url: string;
  state: string;
  pkceVerifier: string;
}> {
  const state = base64URLEncode(crypto.getRandomValues(new Uint8Array(16)));
  const pkce = await createPKCE();

  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
    scope: "openid profile email offline_access",
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "opencode",
  });

  return {
    url: `${OAUTH_AUTHORIZE_URL}?${params.toString()}`,
    state,
    pkceVerifier: pkce.verifier,
  };
}

/** Exchange an authorization code for tokens. */
async function exchangeCode(
  code: string,
  verifier: string,
): Promise<
  | { type: "success"; access: string; refresh: string; expires: number }
  | { type: "failed" }
> {
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OAUTH_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    });

    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[multi-auth] Token exchange failed: ${res.status} ${text}`);
      return { type: "failed" };
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    return {
      type: "success",
      access: data.access_token,
      refresh: data.refresh_token ?? "",
      expires: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
  } catch (err) {
    console.error(`[multi-auth] Token exchange error: ${String(err)}`);
    return { type: "failed" };
  }
}

/** Start a local server to receive the OAuth callback. */
async function startLocalServer(
  expectedState: string,
): Promise<{
  ready: boolean;
  waitForCode: (state: string) => Promise<{ code: string } | null>;
  close: () => void;
}> {
  let resolveCode: ((value: { code: string } | null) => void) | null = null;
  let serverReady = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", REDIRECT_URI);
    if (url.pathname !== "/auth/callback") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    if (error) {
      if (resolveCode) resolveCode(null);
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("OAuth failed");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || state !== expectedState) {
      if (resolveCode) resolveCode(null);
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid OAuth callback");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><body><p>OAuth complete! You can close this tab.</p></body></html>`);

    if (closeTimer) clearTimeout(closeTimer);
    if (resolveCode) resolveCode({ code });
  });

  return new Promise((resolve) => {
    server.listen(1455, "localhost", () => {
      serverReady = true;
      const waitForCode = (s: string): Promise<{ code: string } | null> => {
        return new Promise((resolveWait) => {
          resolveCode = resolveWait;
          // Timeout after 5 minutes
          closeTimer = setTimeout(() => {
            resolveCode = null;
            resolveWait(null);
          }, 300_000);
        });
      };
      const close = () => {
        if (closeTimer) clearTimeout(closeTimer);
        server.close();
      };
      resolve({ ready: serverReady, waitForCode, close });
    });

    server.on("error", () => {
      // Port likely in use — fall back to manual flow
      resolve({ ready: false, waitForCode: () => Promise.resolve(null), close: () => server.close() });
    });
  });
}

/** Try to open a URL in the default browser. */
function openBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      execFileSync("open", [url], { timeout: 3000 });
    } else if (platform === "win32") {
      execFileSync("cmd", ["/c", "start", "", url], { timeout: 3000 });
    } else {
      try {
        execFileSync("xdg-open", [url], { timeout: 3000, stdio: "ignore" });
      } catch {
        execFileSync("sensible-browser", [url], { timeout: 3000, stdio: "ignore" });
      }
    }
  } catch {
    // Browser open failed, user will open manually
  }
}
