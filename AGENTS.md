# opencode-multi-auth

OpenCode plugin that overrides the built-in `openai` provider with multi-account rotation on rate limits. Routes Chat Completions through the ChatGPT Codex Responses API. OAuth tokens only, no API keys.

## STRUCTURE

```
src/
├── index.ts            # Plugin entry: custom fetch, rate-limit rotation, OAuth flows
├── accounts/
│   ├── manager.ts      # Account pool: selection, health, cooldowns, persistence
│   └── types.ts        # ManagedAccount, PluginConfig, QuotaSnapshot interfaces
├── auth/
│   └── tokens.ts       # JWT decode, token refresh, rate-limit parsing, URL rewrite
└── lib/
    └── storage.ts      # Secured JSON file I/O (0600 permissions)
```

## WHERE TO LOOK

| Task | File | Notes |
|------|------|-------|
| Account rotation on rate limit | `src/index.ts:532-594` | `isRateLimit` check + retry loop |
| Account selection strategy | `src/accounts/manager.ts:160-223` | `select`, `selectExcluding`, `pickQuotaAware` |
| Rate-limit reset tracking | `src/accounts/manager.ts:228-239` | `markRateLimited` writes `rateLimitResets[model]` or `globalRateLimitReset` |
| Retry-After response | `src/index.ts:406-416` | Sets `Retry-After` header from earliest reset; falls back to `rateLimitCooldownMs` |
| Parse rate-limit body | `src/auth/tokens.ts:190-233` | `parseRetryAfter`: header first, then body `resets_at` (epoch), default 60s |
| SSE → chat completion | `src/index.ts:134-182` | `buildChatCompletionFromSSE` |
| OAuth flows | `src/index.ts:658-742` | PKCE + local server (auto) vs manual paste |
| Token refresh | `src/auth/tokens.ts:104-152` | `refreshAccessToken` via `auth.openai.com/oauth/token` |
| Quota extraction | `src/index.ts:91-132` | From error body (`resets_at`) and response headers (`x-ratelimit-*`) |
| Account persistence | `src/lib/storage.ts` | `~/.config/opencode/openai-accounts.json` with `0600` |

## CONVENTIONS

- **ESM only**: TypeScript with `NodeNext` module resolution, explicit `.js` extensions on imports.
- **Plugin pattern**: Default export of `const MultiAuthPlugin: Plugin = async ({ client }) => {...}`.
- **Config injection**: `envConfig()` reads `OPENCODE_MULTI_AUTH_*`, merged with `DEFAULT_CONFIG` via `resolveConfig`.
- **Error body quota**: `extractQuotaFromErrorBody` parses `resets_at` from `error.details.resets_at` or top-level `resets_at`. Absolute epoch: `< 1e12` = seconds, `>= 1e12` = ms.
- **Rate-limit body parsing**: `parseRetryAfter` same epoch logic but also handles relative seconds (`< 1_000_000`) and `retry_after` fields.
- **Toast debounce**: Same-account toast suppressed for 5s to avoid spam.
- **Response wrapping**: SSE responses from Codex API are buffered and returned as standard `chat.completion` JSON.
- **Secure storage**: Account file written with `0o600`, directory with `0o700`.
- **No try-catch on token parsing**: Refresh errors are functional (return `{type: "error"}`), not thrown.

## ANTI-PATTERNS

- **Don't add new response formats**: Only Chat Completions → Codex Responses API conversion is supported. Chat Completions output is fabricated from SSE events.
- **Don't break `getEarliestReset` fallback**: `retryAfterResponse` must always set `Retry-After` — even when `getEarliestReset` returns undefined. The fallback `rateLimitCooldownMs` is the last resort.
- **Don't misuse `resets_at`**: The API returns absolute epoch timestamps, NOT relative seconds. `parseRetryAfter` and `extractQuotaFromErrorBody` handle both — any new parsing MUST distinguish.
- **Don't skip saved state**: `markRateLimited` and `updateQuota` call `this.save()` immediately. Persistence is not optional.
- **No generic `fetch` passthrough**: All requests must go through `customFetch` for account rotation.

## COMMANDS

```bash
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
opencode plugin add "$(pwd)"   # register locally
opencode auth login            # add account
opencode run -m openai/gpt-5.5 "..."   # use with rotation
```

## NOTES

- Plugin registers models `gpt-5.5`, `gpt-5.4-mini`, `codex-auto-review` with reasoning variants.
- Account selection defaults to `quota-aware` — prefers accounts with most remaining reported quota.
- Accounts with `consecutiveFailures >= 3` are excluded from selection and skipped by `getEarliestReset`.
- `selectExcluding` with `allowFallback=false` returns null immediately when no healthy account found (skips ratelimited ones).
- Two `Date.now()` calls exist in the rate-limit marking flow — minor drift is acceptable.
