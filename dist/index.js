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
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { AccountManager } from "./accounts/manager.js";
import { resolveConfig } from "./accounts/types.js";
import { decodeJWT, extractAccountId, extractEmail, extractPlanType, rewriteURL, DUMMY_API_KEY, CODEX_BASE_URL, isRateLimit, parseRetryAfter, } from "./auth/tokens.js";
// ── Constants ──────────────────────────────────────────────
const PROVIDER_ID = "openai";
const RESPONSES_ENDPOINT = `${CODEX_BASE_URL}/responses`;
const REASONING_VARIANTS = ["low", "medium", "high", "xhigh"];
const REASONING_VARIANT_CONFIG = Object.fromEntries(REASONING_VARIANTS.map((effort) => [effort, { reasoningEffort: effort }]));
function parseSSE(body) {
    const events = [];
    let currentEvent = "";
    let currentData = "";
    for (const line of body.split("\n")) {
        if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
        }
        else if (line.startsWith("data: ")) {
            currentData = line.slice(6);
        }
        else if (line === "") {
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
function buildChatCompletionFromSSE(events, model) {
    let fullText = "";
    let responseId = `chatcmpl-${uuidv4()}`;
    let created = Math.floor(Date.now() / 1000);
    let usage = {};
    for (const evt of events) {
        try {
            const parsed = JSON.parse(evt.data);
            if (evt.event === "response.output_text.delta") {
                fullText += parsed.delta || "";
            }
            if (evt.event === "response.completed" && parsed.response) {
                created = parsed.response.created_at;
                if (parsed.response.id)
                    responseId = parsed.response.id;
                if (parsed.response.usage) {
                    usage = {
                        prompt_tokens: parsed.response.usage.input_tokens || 0,
                        completion_tokens: parsed.response.usage.output_tokens || 0,
                        total_tokens: parsed.response.usage.total_tokens || 0,
                    };
                }
            }
        }
        catch { /* skip malformed events */ }
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
function toResponsesBody(chatBody) {
    const messages = chatBody.messages || [];
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
    const body = {
        model: chatBody.model,
        input,
        instructions,
        store: false,
        stream: true,
    };
    const effort = typeof chatBody.reasoningEffort === "string" ? chatBody.reasoningEffort
        : typeof chatBody.reasoning_effort === "string" ? chatBody.reasoning_effort
            : undefined;
    if (effort && REASONING_VARIANTS.includes(effort)) {
        body.reasoning = { effort };
    }
    return body;
}
async function wrapSSEAsChatCompletion(sseResponse, model) {
    const sseText = await sseResponse.text();
    const events = parseSSE(sseText);
    const completion = buildChatCompletionFromSSE(events, model || "");
    return new Response(JSON.stringify(completion), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });
}
// ── Fingerprint helpers ────────────────────────────────────
const CODEX_INSTALLATION_ID = (() => {
    try {
        const p = join(homedir(), ".codex", "installation_id");
        if (existsSync(p))
            return readFileSync(p, "utf-8").trim();
    }
    catch { /* best-effort */ }
    return undefined;
})();
function uuidv4() {
    return crypto.randomUUID();
}
function traceparent() {
    const traceId = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const spanId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    return `00-${traceId}-${spanId}-01`;
}
// ── Plugin config from environment ─────────────────────────
function envConfig() {
    const strategy = process.env.OPENCODE_MULTI_AUTH_STRATEGY;
    return {
        accountSelectionStrategy: strategy,
        debug: process.env.OPENCODE_MULTI_AUTH_DEBUG === "1",
        quietMode: process.env.OPENCODE_MULTI_AUTH_QUIET === "1",
        pidOffsetEnabled: process.env.OPENCODE_MULTI_AUTH_PID_OFFSET === "1",
        perModelRateLimits: process.env.OPENCODE_MULTI_AUTH_PER_MODEL !== "0",
        rateLimitCooldownMs: parseInt(process.env.OPENCODE_MULTI_AUTH_COOLDOWN_MS ?? "", 10) || 60_000,
    };
}
// ── Helpers ────────────────────────────────────────────────
function extractModel(body) {
    if (!body)
        return undefined;
    try {
        const parsed = JSON.parse(body);
        return typeof parsed.model === "string" ? parsed.model : undefined;
    }
    catch {
        return undefined;
    }
}
function extractSessionKey(body) {
    if (!body)
        return undefined;
    try {
        const parsed = JSON.parse(body);
        const key = parsed.prompt_cache_key;
        return typeof key === "string" && key.trim().length > 0 ? key.trim() : undefined;
    }
    catch {
        return undefined;
    }
}
function buildAuthHeaders(init, account) {
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.delete("Authorization");
    headers.delete("openai-authorization");
    headers.set("authorization", `Bearer ${account.access}`);
    headers.set("openai-authorization", `Bearer ${account.access}`);
    // Account/workspace routing — lowercase to match native Codex CLI
    if (account.accountId) {
        headers.set("chatgpt-account-id", account.accountId);
    }
    // Fingerprint: mimic native Codex CLI request profile
    headers.set("user-agent", "Codex/codex_cli_rs");
    headers.set("x-client-request-id", uuidv4());
    if (CODEX_INSTALLATION_ID) {
        headers.set("x-codex-installation-id", CODEX_INSTALLATION_ID);
    }
    headers.set("traceparent", traceparent());
    return headers;
}
// ── Toast helpers ──────────────────────────────────────────
let lastToastAccount = -1;
let lastToastTime = 0;
const TOAST_DEBOUNCE = 5000;
async function showToast(client, message, variant = "info") {
    try {
        await client.tui.showToast({ body: { message, variant } });
    }
    catch {
        // TUI not available
    }
}
// ── Plugin factory ─────────────────────────────────────────
export const MultiAuthPlugin = async ({ client }) => {
    const cfg = resolveConfig(envConfig());
    const debug = cfg.debug;
    const manager = new AccountManager(cfg);
    manager.load();
    manager.importFromOpenCodeAuth();
    // ── Loader: intercept fetch requests ──────────────────
    async function loader(_getAuth, _provider) {
        // ── Custom fetch ──────────────────────────────────
        async function customFetch(input, init) {
            const bodyStr = typeof init?.body === "string" ? init.body : undefined;
            const model = extractModel(bodyStr);
            const now = Date.now();
            let account = await manager.select(model);
            if (!account) {
                return new Response(JSON.stringify({ error: "No available OpenAI accounts" }), { status: 503, headers: { "Content-Type": "application/json" } });
            }
            // ── Toast: show which account is active ─────────
            if (!cfg.quietMode && manager.count() > 1) {
                const id = account.label || account.email || `Acct ${account.index + 1}`;
                if (account.index !== lastToastAccount ||
                    now - lastToastTime > TOAST_DEBOUNCE) {
                    lastToastAccount = account.index;
                    lastToastTime = now;
                    showToast(client, `[multi-auth] ${id} (${account.index + 1}/${manager.count()})`, "info");
                }
            }
            // ── Ensure valid token ────────────────────────
            const tokenOk = await manager.ensureValidToken(account);
            if (!tokenOk) {
                // Try next account
                const next = await manager.selectExcluding(new Set([account.index]), model);
                if (next) {
                    if (!cfg.quietMode) {
                        const from = account.label || account.email || `Acct ${account.index + 1}`;
                        const to = next.label || next.email || `Acct ${next.index + 1}`;
                        showToast(client, `[multi-auth] Token refresh failed for ${from}, switching to ${to}`, "warning");
                    }
                    account = next;
                    const tokenOk2 = await manager.ensureValidToken(account);
                    if (!tokenOk2) {
                        return new Response(JSON.stringify({ error: "Token refresh failed for all available accounts" }), { status: 401, headers: { "Content-Type": "application/json" } });
                    }
                }
                else {
                    return new Response(JSON.stringify({ error: "Token refresh failed, no fallback accounts" }), { status: 401, headers: { "Content-Type": "application/json" } });
                }
            }
            // ── Prepare request (fill requestUrl + requestInit) ──
            const headers = buildAuthHeaders(init, account);
            const inputUrl = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
            const parsedUrl = new URL(inputUrl);
            const isChatEndpoint = parsedUrl.pathname === "/v1/chat/completions" || parsedUrl.pathname === "/chat/completions";
            let requestUrl;
            let requestInit;
            if (isChatEndpoint) {
                // Transform Chat Completions → Codex Responses API
                const chatBody = bodyStr ? JSON.parse(bodyStr) : undefined;
                if (!chatBody) {
                    return new Response(JSON.stringify({ error: "Empty request body" }), { status: 400, headers: { "Content-Type": "application/json" } });
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
                if (debug) {
                    console.log(`[multi-auth] → ${account.label || account.email || `acc-${account.index}`} ${chatBody.model || ""} (responses API)`);
                }
            }
            else {
                // Standard passthrough for non-chat endpoints (models, etc.)
                let url;
                try {
                    url = rewriteURL(inputUrl);
                }
                catch {
                    url = inputUrl;
                }
                requestUrl = url;
                requestInit = { ...init, headers };
                if (debug) {
                    console.log(`[multi-auth] → ${account.label || account.email || `acc-${account.index}`} ${model || ""}`);
                }
            }
            // ── Execute request with retry/rotation ─────────
            function withAccount(acc) {
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
            let response = await fetch(requestUrl, requestInit);
            // ── Handle rate limits ────────────────────────
            if (isRateLimit(response.status)) {
                const retryBody = await response.clone().text().catch(() => undefined);
                const cooldown = parseRetryAfter(response, retryBody);
                if (debug) {
                    console.log(`[multi-auth] Rate limit (${response.status}) on ${account.label || account.email || account.index}, cooldown ${cooldown}ms`);
                }
                manager.markRateLimited(account, cooldown, model);
                if (!cfg.quietMode) {
                    const id = account.label || account.email || `Acct ${account.index + 1}`;
                    const min = Math.ceil(cooldown / 60000);
                    showToast(client, `[multi-auth] ${id} rate-limited. Retry in ${min}m.`, "warning");
                }
                // Rotate to next available account
                const next = await manager.selectExcluding(new Set([account.index]), model);
                if (next) {
                    if (!cfg.quietMode) {
                        const from = account.label || account.email || `Acct ${account.index + 1}`;
                        const to = next.label || next.email || `Acct ${next.index + 1}`;
                        showToast(client, `[multi-auth] Switching ${from} → ${to}`, "info");
                    }
                    await manager.ensureValidToken(next);
                    if (debug) {
                        console.log(`[multi-auth] Retrying on ${next.label || next.email || `acc-${next.index}`}`);
                    }
                    const retryResponse = await fetch(requestUrl, withAccount(next));
                    if (debug && isRateLimit(retryResponse.status)) {
                        console.log(`[multi-auth] Retry also rate-limited (${retryResponse.status})`);
                    }
                    // Post-process SSE if it succeeded and this is chat
                    if (isChatEndpoint && retryResponse.ok) {
                        return wrapSSEAsChatCompletion(retryResponse, model);
                    }
                    return retryResponse;
                }
                // All accounts exhausted
                if (!cfg.quietMode) {
                    showToast(client, "[multi-auth] All accounts rate-limited. Waiting for cooldown.", "error");
                }
                return response;
            }
            // ── Handle auth errors ────────────────────────
            if (response.status === 401) {
                if (debug)
                    console.log("[multi-auth] 401, forcing token refresh");
                const refreshed = await manager.ensureValidToken(account);
                if (refreshed) {
                    const retryResponse = await fetch(requestUrl, withAccount(account));
                    if (isChatEndpoint && retryResponse.ok) {
                        return wrapSSEAsChatCompletion(retryResponse, model);
                    }
                    return retryResponse;
                }
                // Try next account
                const next = await manager.selectExcluding(new Set([account.index]), model);
                if (next) {
                    await manager.ensureValidToken(next);
                    const retryResponse = await fetch(requestUrl, withAccount(next));
                    if (isChatEndpoint && retryResponse.ok) {
                        return wrapSSEAsChatCompletion(retryResponse, model);
                    }
                    return retryResponse;
                }
                return response;
            }
            // ── Handle 400 (model not supported, etc.) ─────
            if (response.status === 400) {
                const next = await manager.selectExcluding(new Set([account.index]), model);
                if (next) {
                    if (!cfg.quietMode) {
                        const from = account.label || account.email || `Acct ${account.index + 1}`;
                        const to = next.label || next.email || `Acct ${next.index + 1}`;
                        showToast(client, `[multi-auth] Model issue on ${from}, trying ${to}`, "info");
                    }
                    await manager.ensureValidToken(next);
                    const retryResponse = await fetch(requestUrl, withAccount(next));
                    if (isChatEndpoint && retryResponse.ok) {
                        return wrapSSEAsChatCompletion(retryResponse, model);
                    }
                    return retryResponse;
                }
            }
            // ── Post-process SSE for successful chat completions ──
            if (isChatEndpoint && response.ok) {
                return wrapSSEAsChatCompletion(response, model);
            }
            return response;
        }
        return {
            apiKey: DUMMY_API_KEY,
            baseURL: CODEX_BASE_URL,
            fetch: customFetch,
        };
    }
    // ── OAuth flow builder (Auto) ──────────────────────────
    function buildAutoFlow(verifier, state, url, server) {
        return {
            url,
            method: "auto",
            instructions: "Complete the OAuth flow in your browser.",
            callback: async () => {
                const result = await server.waitForCode(state);
                server.close();
                if (!result)
                    return { type: "failed" };
                // Exchange code for tokens
                const tokens = await exchangeCode(result.code, verifier);
                if (tokens.type !== "success")
                    return { type: "failed" };
                // Add to account manager
                const info = tokens.access ? decodeJWT(tokens.access) : null;
                const email = info ? extractEmail(info) : undefined;
                manager.addAccount(tokens.refresh, tokens.access, tokens.expires, email);
                return {
                    type: "success",
                    provider: PROVIDER_ID,
                    refresh: tokens.refresh,
                    access: tokens.access,
                    expires: tokens.expires,
                };
            },
        };
    }
    // ── OAuth flow builder (Manual / code input) ───────────
    function buildManualFlow(verifier, expectedState, url) {
        return {
            url,
            method: "code",
            instructions: "Open the URL in your browser, complete the flow, and paste the full redirect URL (or the code parameter) here.",
            callback: async (input) => {
                // Parse the code from either a full URL or just the code parameter
                let code;
                try {
                    const parsed = new URL(input);
                    code = parsed.searchParams.get("code") ?? undefined;
                    const state = parsed.searchParams.get("state");
                    if (state && state !== expectedState) {
                        console.error("[multi-auth] State mismatch in manual OAuth flow");
                        return { type: "failed" };
                    }
                }
                catch {
                    // Not a URL — treat the whole input as the code
                    code = input;
                }
                if (!code)
                    return { type: "failed" };
                const tokens = await exchangeCode(code, verifier);
                if (tokens.type !== "success")
                    return { type: "failed" };
                const info = tokens.access ? decodeJWT(tokens.access) : null;
                const email = info ? extractEmail(info) : undefined;
                manager.addAccount(tokens.refresh, tokens.access, tokens.expires, email);
                return {
                    type: "success",
                    provider: PROVIDER_ID,
                    refresh: tokens.refresh,
                    access: tokens.access,
                    expires: tokens.expires,
                };
            },
        };
    }
    // ── Return hooks ───────────────────────────────────────
    return {
        auth: {
            provider: PROVIDER_ID,
            loader,
            methods: [
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
                            key: PROVIDER_ID,
                            provider: PROVIDER_ID,
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
                    if (accounts.length === 0) {
                        return [
                            "OpenAI Multi-Account Status",
                            "",
                            "  No accounts configured.",
                            "",
                            "  Add one:  opencode auth login",
                            "",
                        ].join("\n");
                    }
                    const now = Date.now();
                    const active = manager.getActive();
                    const lines = [
                        `OpenAI Multi-Account Status (${accounts.length} accounts)`,
                        "",
                    ];
                    for (const acct of accounts) {
                        const isActive = active && acct.index === active.index;
                        const label = acct.label || acct.email || `Account ${acct.index + 1}`;
                        const plan = acct.planType ? ` [${acct.planType}]` : "";
                        const status = acct.consecutiveFailures >= 3 ? "[DISABLED]"
                            : isActive ? "[ACTIVE]"
                                : "[READY]";
                        const limited = acct.globalRateLimitReset && acct.globalRateLimitReset > now
                            ? ` (rate-limited until ${new Date(acct.globalRateLimitReset).toLocaleTimeString()})`
                            : "";
                        lines.push(`  ${status} ${label}${plan}${limited}`);
                    }
                    return lines.join("\n");
                },
            }),
        },
        // ── Config hook: register tool + models ────────────
        config: async (cfg) => {
            cfg.command = cfg.command || {};
            cfg.command["multi-auth-list"] = {
                template: "Run the multi-auth-list tool and output the result EXACTLY as returned, without any additional text.",
                description: "List all configured OpenAI accounts and their status.",
            };
            cfg.experimental = cfg.experimental || {};
            cfg.experimental.primary_tools = cfg.experimental.primary_tools || [];
            if (!cfg.experimental.primary_tools.includes("multi-auth-list")) {
                cfg.experimental.primary_tools.push("multi-auth-list");
            }
            // Register models exposed by the Codex backend for ChatGPT accounts.
            cfg.provider = cfg.provider || {};
            cfg.provider.openai = cfg.provider.openai || {};
            cfg.provider.openai.models = cfg.provider.openai.models || {};
            const models = cfg.provider.openai.models;
            const CODEX_MODELS = [
                "gpt-5.5", "gpt-5.4-mini", "codex-auto-review",
            ];
            for (const id of CODEX_MODELS) {
                if (!models[id]) {
                    models[id] = { name: id };
                }
                if (id.startsWith("gpt-")) {
                    const model = models[id];
                    model.variants = {
                        ...(model.variants ?? {}),
                        ...REASONING_VARIANT_CONFIG,
                    };
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
async function createPKCE() {
    const verifier = base64URLEncode(crypto.getRandomValues(new Uint8Array(32)));
    const challengeBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = base64URLEncode(new Uint8Array(challengeBuffer));
    return { verifier, challenge };
}
function base64URLEncode(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** Create the full OAuth authorization flow parameters. */
async function createOAuthFlow() {
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
async function exchangeCode(code, verifier) {
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
        const data = (await res.json());
        return {
            type: "success",
            access: data.access_token,
            refresh: data.refresh_token ?? "",
            expires: Date.now() + (data.expires_in ?? 3600) * 1000,
        };
    }
    catch (err) {
        console.error(`[multi-auth] Token exchange error: ${String(err)}`);
        return { type: "failed" };
    }
}
/** Start a local server to receive the OAuth callback. */
async function startLocalServer(expectedState) {
    let resolveCode = null;
    let serverReady = false;
    let closeTimer;
    const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", REDIRECT_URI);
        if (url.pathname !== "/auth/callback") {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not found");
            return;
        }
        const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
        if (error) {
            if (resolveCode)
                resolveCode(null);
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("OAuth failed");
            return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || state !== expectedState) {
            if (resolveCode)
                resolveCode(null);
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Invalid OAuth callback");
            return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html><html><body><p>OAuth complete! You can close this tab.</p></body></html>`);
        if (closeTimer)
            clearTimeout(closeTimer);
        if (resolveCode)
            resolveCode({ code });
    });
    return new Promise((resolve) => {
        server.listen(1455, "localhost", () => {
            serverReady = true;
            const waitForCode = (s) => {
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
                if (closeTimer)
                    clearTimeout(closeTimer);
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
function openBrowser(url) {
    const platform = process.platform;
    try {
        if (platform === "darwin") {
            execFileSync("open", [url], { timeout: 3000 });
        }
        else if (platform === "win32") {
            execFileSync("cmd", ["/c", "start", "", url], { timeout: 3000 });
        }
        else {
            try {
                execFileSync("xdg-open", [url], { timeout: 3000, stdio: "ignore" });
            }
            catch {
                execFileSync("sensible-browser", [url], { timeout: 3000, stdio: "ignore" });
            }
        }
    }
    catch {
        // Browser open failed, user will open manually
    }
}
//# sourceMappingURL=index.js.map