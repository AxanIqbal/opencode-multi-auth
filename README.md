# opencode-multi-auth

OpenCode plugin that transparently overrides the built-in `openai` provider with automatic multi-account rotation on rate limits. Supports ChatGPT OAuth accounts and Google AI Studio API-key pools for Gemini models.

## How it works

The plugin registers itself as provider `openai`, replacing the built-in one. Every request to `openai/<model>` goes through a custom fetch pipeline that:

1. Selects an account from a pool (sticky by default, round-robin optional)
2. Rewrites Chat Completions format to the ChatGPT Codex Responses API format
3. Buffers SSE streamed responses and returns standard `chat.completion` JSON
4. On rate limits (429, 503, 529) or auth errors (401): auto-rotates to the next healthy account
5. Refreshes OAuth tokens proactively before expiry
6. Routes `gemini-*` model IDs to Google AI Studio with API-key rotation

## Prerequisites

- OpenCode with plugin support
- Node.js >= 20
- One or more ChatGPT accounts (free tier works), or Google AI Studio API keys for Gemini

## Install

Clone from GitHub, build, and add as a local plugin:

```bash
git clone https://github.com/AxanIqbal/opencode-multi-auth.git
cd opencode-multi-auth
bun install && bun run build
opencode plugin add "$(pwd)"
```

Or manually add the local path to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["/absolute/path/to/opencode-multi-auth"]
}
```

> `opencode plugin add` accepts npm module names, not GitHub repos. To enable
> `opencode plugin add opencode-multi-auth`, publish this package to npm first.

Then add an account:

```bash
opencode auth login
```

Choose one of:
- **ChatGPT OAuth (Browser)** — opens your browser for login, handles callback automatically
- **Add Account (Paste Token)** — paste an access token and refresh token directly (headless)
- **ChatGPT OAuth (Manual / Headless)** — get a URL to open, paste the resulting code
- **OpenAI API Key** — standard API key fallback
- **Google API Key** — stores an AI Studio key in the Google key pool

## Usage

```bash
# Any openai model routes through the plugin automatically
opencode run -m openai/gpt-5.5 "hello"

# With reasoning variants
opencode run -m openai/gpt-5.5 --variant high "explain quantum computing"

# List registered accounts and their health
opencode run -m openai/gpt-5.4-mini "list accounts"

# Gemini aliases route through the Google API-key pool
opencode run -m openai/gemini-2.5-flash "hello from gemini"
```

### Available models

The plugin registers these Codex-specific models:
- `gpt-5.5` — flagship model, supports reasoning variants
- `gpt-5.4-mini` — lighter/faster, supports reasoning variants
- `codex-auto-review` — automated code review

All GPT models support `--variant`: `low`, `medium`, `high`, `xhigh`.

Gemini aliases are registered under `openai/` because this plugin owns the `openai` loader that performs key rotation:

- `gemini-2.5-flash`
- `gemini-2.5-flash-image`
- `gemini-2.5-flash-lite`
- `gemini-2.5-flash-preview-tts`
- `gemini-2.5-pro`
- `gemini-2.5-pro-preview-tts`
- `gemini-3-flash-preview`
- `gemini-3-pro-image-preview`
- `gemini-3.1-flash-image-preview`
- `gemini-3.1-flash-lite`
- `gemini-3.1-pro-preview`
- `gemini-3.1-pro-preview-customtools`
- `gemini-3.5-flash`
- `gemini-embedding-001`
- `gemini-flash-latest`
- `gemini-flash-lite-latest`
- `gemma-4-26b-a4b-it`
- `gemma-4-31b-it`

### Account management

```
opencode run -m openai/gpt-5.4-mini "list accounts"
```

Shows each account's status: `[ACTIVE]`, `[READY]`, `[DISABLED]` (after 3+ consecutive failures), and any active rate-limit cooldowns.

Set an account as a fallback by giving it a larger priority number:

```
opencode run -m openai/gpt-5.4-mini "set account 2 priority 10"
```

Priorities are tiers: lower numbers are selected first, and the default is `0`. An account with priority `10` is only used when no priority `0` account is available for that model. Within the same priority tier, the configured selection strategy still applies.

Rate-limited accounts are still checked for OAuth token refresh on plugin startup and every 30 minutes while the plugin process is running, so a long `resets_at` cooldown does not prevent token maintenance.

## Adding accounts

### Paste tokens

Get an access token and refresh token from an existing ChatGPT session, then use the "Add Account (Paste Token)" auth method. Tokens are stored in `~/.config/opencode/openai-accounts.json` with `0600` permissions.

### OAuth browser flow

Opens `https://auth.openai.com/oauth/authorize` with the official OpenCode client ID and PKCE. After authorization, tokens are exchanged and stored automatically.

### Google API keys

Choose "Google API Key" in `opencode auth login` once per key. Requests to `openai/gemini-*` use those stored keys in priority/rotation order. OpenCode model names like `google/gemini-*` are not intercepted by this plugin because OpenCode currently attaches this loader to one provider ID; use the same model suffix with `openai/` to get rotation.

## Configuration

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_MULTI_AUTH_STRATEGY` | `quota-aware` | Account selection: `quota-aware`, `sticky`, or `round-robin` |
| `OPENCODE_MULTI_AUTH_DEBUG` | `0` | Enable debug logging |
| `OPENCODE_MULTI_AUTH_QUIET` | `0` | Suppress toast notifications |
| `OPENCODE_MULTI_AUTH_PER_MODEL` | `1` | Track rate limits per model (`0` = global) |
| `OPENCODE_MULTI_AUTH_COOLDOWN_MS` | `60000` | Cooldown duration after rate limit (ms) |
| `OPENCODE_MULTI_AUTH_PID_OFFSET` | `0` | Offset account selection by PID for parallel processes |
| `OPENCODE_MULTI_AUTH_QUOTA_CRITICAL_PERCENT` | `95` | Treat an account as exhausted when reported usage reaches this percentage until reset |

### Selection strategies

- **quota-aware** (default): Prefers the account with the most remaining reported Codex quota. Accounts without quota history fall back to least-recently-used until usage data is observed.
- **sticky**: First successful account is reused for the session. Falls back on rate limit.
- **round-robin**: Cycles through accounts evenly. Useful for parallel processes sharing the same account file.

All strategies honor account priority first. Use `multi-auth-set-priority` for OpenAI accounts or `multi-auth-set-google-priority` for Google API-key accounts; lower numbers are preferred.

## Account rotation behavior

| Response | Action |
|---|---|
| 429, 503, 529 | Mark account rate-limited, set cooldown, rotate to next healthy account |
| 401 | Attempt token refresh, retry once. If still failing, rotate. |
| 400 | Model not supported on this account, rotate to next. |
| 3+ consecutive failures | Account marked `[DISABLED]`, excluded from selection. |

## Files

| Path | Purpose |
|---|---|
| `~/.config/opencode/openai-accounts.json` | Encrypted account store (0600 permissions) |
| `~/.config/opencode/google-accounts.json` | Google API-key account store (0600 permissions) |
| `~/.config/opencode/opencode.json` | Plugin registration in plugins array |

## Security

- Account tokens and Google API keys are stored with `0600` permissions (owner read/write only)
- Fingerprint headers mimic native Codex CLI to reduce ban risk: `User-Agent`, `x-client-request-id` (per-request UUID), `x-codex-installation-id`, `traceparent` (W3C trace context)
- Token refresh via `auth.openai.com/oauth/token` with PKCE
- `execSync` replaced with `execFileSync` for browser launch

## Build

```bash
bun run build       # compile TypeScript
bun run typecheck   # type-check without emitting
```

## License

MIT
