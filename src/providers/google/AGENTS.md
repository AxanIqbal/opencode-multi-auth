# Google Provider Operational Guide

## Ownership
Handles Google Gemini and Gemma model requests. Responsible for model aliasing, API-key injection, and rotation across the Google API-key pool.

## Public Facade Exports
- `createGoogleLoader`: Main entry point for the Google fetch pipeline.
- `GEMINI_MODELS`: List of supported Google model aliases.
- `extractGoogleModelFromUrl`: Utility to parse model IDs from Google API URLs.
- `withGoogleApiKey`: Utility to inject API keys into requests.

## Allowed Dependency Boundaries
- `../../accounts/manager.js`: Account selection and health state.
- `../../accounts/types.js`: Shared types and configuration.
- `../../auth/tokens.js`: Rate-limit parsing and dummy key constants.

## Real Request/Response Flows
1. **Intercept**: `customGoogleFetch` captures the request.
2. **Identify**: Extracts model ID from the URL path.
3. **Select**: `AccountManager` picks a healthy Google API-key account.
4. **Inject**: `withGoogleApiKey` adds the key to URL search params and `x-goog-api-key` header.
5. **Dispatch**: Request is sent to the Google AI Studio endpoint.
6. **Return**: Response is returned directly to the caller.

## Branch Conditions
- **Rate Limit**: Status 429, 503, or 529 triggers cooldown marking and rotation.
- **Auth/Model Error**: Status 401, 403, or 400 marks a cooldown on the current account before attempting rotation to another key.

## AccountManager State Effects
- `select`: Adds the account identity to the `pendingAccounts` Set.
- `markRateLimited`: Sets a `resets_at` timestamp in `rateLimitResets[model]` or `globalRateLimitReset`.
- `releasePending`: Removes the account identity from the `pendingAccounts` Set.

## Retry/Error Paths
- **Network Failure**: Returns 502 Bad Gateway.
- **Rotation Loop**: Continues trying healthy keys until success or all keys are exhausted.
- **Exhaustion**: On rate-limit rotation failure, returns 503 Service Unavailable with a `Retry-After` header based on the earliest key reset.

## Required Verification
- `lsp_diagnostics` must be clean for `src/providers/google/index.ts`.
- Manual QA: `opencode run -m google/gemini-2.5-flash "test"` must return a valid response.

## Per-file Logical Limit
- `index.ts`: 163 logical lines (Well within the 500-line limit).

## Mandatory Update Rule
MANDATORY: Update this guide in the same change when provider behavior, flow, conditions, or dependencies change.
