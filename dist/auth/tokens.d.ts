/**
 * Token management utilities.
 *
 * - JWT decode (no signature verification — we only read the payload)
 * - Token refresh via OpenAI's OAuth token endpoint
 * - Account ID / email extraction from JWT claims
 */
/** Decode the payload of a JWT without verifying the signature. */
export declare function decodeJWT(token: string): Record<string, unknown> | null;
/** Extract the ChatGPT account ID from JWT claims. */
export declare function extractAccountId(claims: Record<string, unknown>): string | undefined;
/** Extract the ChatGPT user ID from JWT claims. */
export declare function extractUserId(claims: Record<string, unknown>): string | undefined;
/** Extract plan type from JWT claims. */
export declare function extractPlanType(claims: Record<string, unknown>): string | undefined;
/** Extract email from JWT profile claims. */
export declare function extractEmail(claims: Record<string, unknown>): string | undefined;
/** Extract all useful fields from an access token. */
export declare function extractTokenInfo(token: string): {
    accountId?: string;
    userId?: string;
    planType?: string;
    email?: string;
};
export interface TokenRefreshResult {
    type: "success";
    access: string;
    refresh: string;
    expires: number;
}
export interface TokenRefreshError {
    type: "error";
    code?: string;
    message: string;
}
export type TokenRefreshOutcome = TokenRefreshResult | TokenRefreshError;
/**
 * Exchange a refresh token for new access+refresh tokens using
 * OpenAI's OAuth token endpoint.
 */
export declare function refreshAccessToken(refreshToken: string): Promise<TokenRefreshOutcome>;
/** The Codex API base URL. */
export declare const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
/** Dummy API key that OpenCode expects our provider to have. */
export declare const DUMMY_API_KEY = "opencode-multi-auth-dummy-key";
/**
 * Rewrite standard OpenAI API paths to the Codex proxy backend,
 * preserving query parameters and adding client_version for /models.
 */
export declare function rewriteURL(original: string): string;
export declare function isRateLimit(status: number): boolean;
/** Parse Retry-After header or response body to get cooldown ms. */
export declare function parseRetryAfter(response: Response, body?: string): number;
//# sourceMappingURL=tokens.d.ts.map