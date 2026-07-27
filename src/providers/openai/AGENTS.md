# OpenAI Provider Operational Guide

## Ownership
Handles OpenAI and Codex model requests. Responsible for model registration, request transformation (Chat Completions to ChatGPT Responses API), quota management, and account rotation for OpenAI OAuth and API-key accounts.

## Public Facade Exports
- `createOpenAILoader`: Main entry point for the OpenAI fetch pipeline.
- `registerOpenAIModels`: Registers supported Codex models and reasoning variants.

## Allowed Dependency Boundaries
- `../../accounts/manager.js`: Account selection and health state.
- `../../accounts/types.js`: Shared types and configuration.
- `../../auth/tokens.js`: URL rewriting and rate-limit parsing.
- Internal: `headers.ts` (Auth), `quota.ts` (Usage), `request.ts` (Transformation), `models.ts` (Registry).

## Real Request/Response Flows
1. **Intercept**: `customFetch` captures the request.
2. **Identify**: Extracts model ID from the JSON body.
3. **Select**: `AccountManager` picks a healthy account (quota-aware by default).
4. **Auth**: `ensureValidToken` refreshes OAuth tokens if needed; `buildAuthHeaders` injects Bearer tokens and Codex fingerprints.
5. **Transform**: If targeting `/v1/chat/completions`, the body is converted to the ChatGPT Responses API format.
6. **Dispatch**: Request is sent to `https://chatgpt.com/backend-api/codex/responses`.
7. **Wrap**: SSE stream is buffered and converted back to standard `chat.completion` JSON.

## Branch Conditions
- **Chat Endpoint**: Requests to `/v1/chat/completions` or `/chat/completions` trigger the Responses API transformation.
- **Rate Limit**: Status 429, 503, or 529 triggers cooldown marking and rotation.
- **Auth Error**: Status 401 triggers `ensureValidToken` (can no-op if token is fresh) and one same-account retry. If the retry is non-ok, it is returned directly. A fallback to a next account occurs only if the initial refresh fails or the same-account retry hits a network error.
- **Model Error**: Status 400 (unsupported model) attempts a single fallback to one next eligible account.

## AccountManager State Effects
- `select`: Adds the account identity to the `pendingAccounts` Set.
- `ensureValidToken`: Updates `access` and `refresh` tokens on disk.
- `updateQuota`: Merges fresh usage data into the account's quota snapshot.
- `markRateLimited`: Sets a `resets_at` timestamp in `rateLimitResets[model]` or `globalRateLimitReset`.
- `releasePending`: Removes the account identity from the `pendingAccounts` Set.

## Retry/Error Paths
- **Network Failure**: Returns 502 Bad Gateway.
- **Rate-Limit Rotation**: On status 429/503/529, the loop continues trying all healthy accounts until success or all accounts are exhausted.
- **Exhaustion**: If the Rate-Limit Rotation fails to find a successful account, returns 503 Service Unavailable with a `Retry-After` header based on the earliest account reset.
- **Model Fallback**: Status 400 attempts at most one fallback to a next eligible account; it does not loop through the entire pool.

## Required Verification
- `lsp_diagnostics` must be clean for all files in `src/providers/openai/`.
- Manual QA: `opencode run -m openai/gpt-5.5 "test"` must return a valid JSON completion.

## Per-file Logical Limit
- `loader.ts`: 490 logical lines (Complies with the ~500 line limit).
- All other files are well within the limit.

## Mandatory Update Rule
MANDATORY: Update this guide in the same change when provider behavior, flow, conditions, or dependencies change.
