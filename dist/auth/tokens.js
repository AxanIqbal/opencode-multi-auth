/**
 * Token management utilities.
 *
 * - JWT decode (no signature verification — we only read the payload)
 * - Token refresh via OpenAI's OAuth token endpoint
 * - Account ID / email extraction from JWT claims
 */
// ── Constants ────────────────────────────────────────────────
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
// ── JWT helpers ──────────────────────────────────────────────
/** Decode the payload of a JWT without verifying the signature. */
export function decodeJWT(token) {
    try {
        const parts = token.split(".");
        if (parts.length !== 3)
            return null;
        const payload = parts[1];
        // Base64url → base64
        const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
        const decoded = atob(base64);
        return JSON.parse(decoded);
    }
    catch {
        return null;
    }
}
/** Extract the ChatGPT account ID from JWT claims. */
export function extractAccountId(claims) {
    const auth = claims["https://api.openai.com/auth"];
    return auth?.chatgpt_account_id;
}
/** Extract the ChatGPT user ID from JWT claims. */
export function extractUserId(claims) {
    const auth = claims["https://api.openai.com/auth"];
    return auth?.chatgpt_user_id;
}
/** Extract plan type from JWT claims. */
export function extractPlanType(claims) {
    const auth = claims["https://api.openai.com/auth"];
    return auth?.chatgpt_plan_type;
}
/** Extract email from JWT profile claims. */
export function extractEmail(claims) {
    const profile = claims["https://api.openai.com/profile"];
    return profile?.email;
}
/** Extract all useful fields from an access token. */
export function extractTokenInfo(token) {
    const claims = decodeJWT(token);
    if (!claims)
        return {};
    return {
        accountId: extractAccountId(claims),
        userId: extractUserId(claims),
        planType: extractPlanType(claims),
        email: extractEmail(claims),
    };
}
/**
 * Exchange a refresh token for new access+refresh tokens using
 * OpenAI's OAuth token endpoint.
 */
export async function refreshAccessToken(refreshToken) {
    try {
        const body = new URLSearchParams({
            grant_type: "refresh_token",
            client_id: OAUTH_CLIENT_ID,
            refresh_token: refreshToken,
        });
        const res = await fetch(OAUTH_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            let code;
            try {
                const json = JSON.parse(text);
                code = json.error;
            }
            catch { /* ignore parse errors */ }
            if (code === "invalid_grant" || code === "refresh_token_reused") {
                return { type: "error", code, message: text || `Token refresh failed: ${res.status}` };
            }
            return { type: "error", message: text || `Token refresh failed: ${res.status}` };
        }
        const data = (await res.json());
        return {
            type: "success",
            access: data.access_token,
            refresh: data.refresh_token ?? refreshToken,
            expires: Date.now() + (data.expires_in ?? 3600) * 1000,
        };
    }
    catch (err) {
        return {
            type: "error",
            message: `Token refresh network error: ${String(err)}`,
        };
    }
}
// ── Codex backend helpers ────────────────────────────────────
/** The Codex API base URL. */
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
/** Dummy API key that OpenCode expects our provider to have. */
export const DUMMY_API_KEY = "opencode-multi-auth-dummy-key";
/** Default client version sent when querying the Codex models endpoint. */
const CODEX_CLIENT_VERSION = "0.125.0";
/**
 * Rewrite standard OpenAI API paths to the Codex proxy backend,
 * preserving query parameters and adding client_version for /models.
 */
export function rewriteURL(original) {
    const u = new URL(original);
    if (u.pathname === "/v1/chat/completions" || u.pathname === "/chat/completions") {
        return `${CODEX_BASE_URL}/chat/completions`;
    }
    if (u.pathname === "/v1/models" || u.pathname === "/models") {
        u.searchParams.set("client_version", CODEX_CLIENT_VERSION);
        return `${CODEX_BASE_URL}/models?${u.searchParams.toString()}`;
    }
    return original;
}
// ── Rate-limit detection helpers ────────────────────────────
const RATE_LIMIT_CODES = new Set([429, 503, 529]);
export function isRateLimit(status) {
    return RATE_LIMIT_CODES.has(status);
}
/** Parse Retry-After header or response body to get cooldown ms. */
export function parseRetryAfter(response, body) {
    // 1. Try Retry-After header
    const header = response.headers.get("Retry-After");
    if (header) {
        const seconds = parseInt(header, 10);
        if (!isNaN(seconds) && seconds > 0)
            return seconds * 1000;
        // Could be an HTTP-date — parse it
        const date = new Date(header);
        if (!isNaN(date.getTime()))
            return Math.max(0, date.getTime() - Date.now());
    }
    // 2. Try response body fields
    if (body) {
        try {
            const json = JSON.parse(body);
            // Common field names across providers
            const resetField = json?.error?.details?.resets_at ??
                json?.resets_at ??
                json?.reset_time ??
                json?.retry_after;
            if (resetField) {
                const ms = typeof resetField === "number"
                    ? resetField * 1000 // seconds
                    : new Date(resetField).getTime() - Date.now();
                if (!isNaN(ms) && ms > 0)
                    return ms;
            }
        }
        catch { /* ignore */ }
    }
    // 3. Default 60s
    return 60_000;
}
//# sourceMappingURL=tokens.js.map