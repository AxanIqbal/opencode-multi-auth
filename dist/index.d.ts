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
import { type Plugin } from "@opencode-ai/plugin";
export declare const MultiAuthPlugin: Plugin;
export default MultiAuthPlugin;
//# sourceMappingURL=index.d.ts.map