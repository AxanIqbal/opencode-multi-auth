import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ManagedAccount } from "../../accounts/types.js";

const CODEX_INSTALLATION_ID: string | undefined = (() => {
  try {
    const path = join(homedir(), ".codex", "installation_id");
    if (existsSync(path)) return readFileSync(path, "utf-8").trim();
  } catch { /* best-effort */ }
  return undefined;
})();

function traceparent(): string {
  const traceId = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const spanId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return `00-${traceId}-${spanId}-01`;
}

export function buildAuthHeaders(
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
