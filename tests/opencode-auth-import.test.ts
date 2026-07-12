import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const testRoot = join(process.env.TMPDIR ?? "/tmp", `opencode-auth-import-${Date.now()}-${Math.random().toString(16).slice(2)}`);

function homeFor(name: string): string {
  return join(testRoot, name);
}

function resetHome(home: string): void {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
}

function runPluginScript(home: string, source: string): unknown {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--eval", source],
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(`${result.stderr.toString()}\n${result.stdout.toString()}`);
  }

  const line = result.stdout
    .toString()
    .split("\n")
    .findLast((item) => item.startsWith("RESULT:"));
  if (!line) throw new Error(`Missing RESULT line:\n${result.stdout.toString()}\n${result.stderr.toString()}`);
  return JSON.parse(line.slice("RESULT:".length));
}

function repeatedOpenCodeApiImportScript(provider: "openai" | "google", apiKey: string): string {
  const accountsFile = provider === "openai" ? "openai-accounts.json" : "google-accounts.json";
  const label = `${provider} import`;
  return `
    import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { AccountManager } from "./src/accounts/manager.ts";
    import { GOOGLE_ACCOUNTS_FILE } from "./src/lib/storage.ts";

    const home = process.env.HOME;
    const authDir = join(home, ".local", "share", "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      ${JSON.stringify(provider)}: { type: "api", key: ${JSON.stringify(apiKey)} },
    }));

    const accountsFile = ${JSON.stringify(provider)} === "openai"
      ? join(home, ".config", "opencode", ${JSON.stringify(accountsFile)})
      : GOOGLE_ACCOUNTS_FILE;

    const first = new AccountManager({ quietMode: true }, accountsFile);
    first.load();
    first.importApiKeyFromOpenCodeAuth(${JSON.stringify(provider)}, ${JSON.stringify(label)});

    const second = new AccountManager({ quietMode: true }, accountsFile);
    second.load();
    second.importApiKeyFromOpenCodeAuth(${JSON.stringify(provider)}, ${JSON.stringify(label)});

    const store = JSON.parse(readFileSync(accountsFile, "utf-8"));
    console.log("RESULT:" + JSON.stringify({ accounts: store.accounts }));
  `;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function fakeAccessToken(claims: Record<string, unknown>): string {
  return [base64UrlJson({ alg: "none", typ: "JWT" }), base64UrlJson(claims), "signature"].join(".");
}

function refreshOnlyOAuthImportScript(accessToken: string): string {
  return `
    import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { AccountManager } from "./src/accounts/manager.ts";

    const home = process.env.HOME;
    const authDir = join(home, ".local", "share", "opencode");
    const accountsFile = join(home, ".config", "opencode", "openai-accounts.json");
    mkdirSync(authDir, { recursive: true });

    const manager = new AccountManager({ quietMode: true }, accountsFile);
    manager.addAccount("refresh-old", ${JSON.stringify(accessToken)}, Date.now() + 60_000);

    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      openai: { type: "oauth", refresh: "refresh-new" },
    }));

    const fresh = new AccountManager({ quietMode: true }, accountsFile);
    fresh.load();
    fresh.importFromOpenCodeAuth();

    const store = JSON.parse(readFileSync(accountsFile, "utf-8"));
    console.log("RESULT:" + JSON.stringify({ accounts: store.accounts }));
  `;
}

function removeAccountPersistenceScript(): string {
  return `
    import { readFileSync } from "node:fs";
    import { join } from "node:path";
    import { AccountManager } from "./src/accounts/manager.ts";

    const home = process.env.HOME;
    const accountsFile = join(home, ".config", "opencode", "openai-accounts.json");
    const manager = new AccountManager({ quietMode: true }, accountsFile);
    manager.addApiKey("sk-keep", "keep");
    manager.addApiKey("sk-remove", "remove");
    manager.removeAccount(1);

    const fresh = new AccountManager({ quietMode: true }, accountsFile);
    fresh.load();
    const store = JSON.parse(readFileSync(accountsFile, "utf-8"));
    console.log("RESULT:" + JSON.stringify({ accounts: store.accounts, freshAccounts: fresh.list() }));
  `;
}

function removedOpenCodeApiImportScript(): string {
  return `
    import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { AccountManager } from "./src/accounts/manager.ts";

    const home = process.env.HOME;
    const authDir = join(home, ".local", "share", "opencode");
    const accountsFile = join(home, ".config", "opencode", "openai-accounts.json");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      openai: { type: "api", key: "sk-removed-auth" },
    }));

    const manager = new AccountManager({ quietMode: true }, accountsFile);
    manager.load();
    manager.importApiKeyFromOpenCodeAuth("openai", "OpenAI API Key");
    manager.removeAccount(0);

    const fresh = new AccountManager({ quietMode: true }, accountsFile);
    fresh.load();
    fresh.importApiKeyFromOpenCodeAuth("openai", "OpenAI API Key");

    const store = JSON.parse(readFileSync(accountsFile, "utf-8"));
    console.log("RESULT:" + JSON.stringify({ accounts: store.accounts, freshAccounts: fresh.list() }));
  `;
}

function googleLoaderDoesNotImportAuthScript(): string {
  return `
    import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { AccountManager } from "./src/accounts/manager.ts";
    import { resolveConfig } from "./src/accounts/types.ts";
    import { GOOGLE_ACCOUNTS_FILE } from "./src/lib/storage.ts";
    import { createGoogleLoader } from "./src/providers/google.ts";

    const home = process.env.HOME;
    const authDir = join(home, ".local", "share", "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({
      google: { type: "api", key: "AIza-from-opencode-auth" },
    }));

    const googleManager = new AccountManager({ quietMode: true }, GOOGLE_ACCOUNTS_FILE);
    googleManager.load();
    const loader = createGoogleLoader({
      cfg: resolveConfig({ quietMode: true }),
      googleManager,
      fetchWithTimeout: async () => new Response("{}"),
    });

    await loader();
    const accounts = existsSync(GOOGLE_ACCOUNTS_FILE)
      ? JSON.parse(readFileSync(GOOGLE_ACCOUNTS_FILE, "utf-8")).accounts
      : [];
    console.log("RESULT:" + JSON.stringify({ accounts, managerAccounts: googleManager.list() }));
  `;
}

beforeEach(() => {
  resetHome(testRoot);
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("OpenCode auth import idempotency", () => {
  test("removed accounts stay removed after saving and reloading", () => {
    const home = homeFor("remove-account-persistence");
    resetHome(home);

    expect(runPluginScript(home, removeAccountPersistenceScript())).toMatchObject({
      accounts: [{ apiKey: "sk-keep", label: "keep" }],
      freshAccounts: [{ apiKey: "sk-keep", label: "keep" }],
    });
  });

  test("removed OpenCode API key is not re-imported from auth store", () => {
    const home = homeFor("removed-opencode-api-import");
    resetHome(home);

    expect(runPluginScript(home, removedOpenCodeApiImportScript())).toMatchObject({
      accounts: [],
      freshAccounts: [],
    });
  });

  test("Google loader does not import built-in OpenCode auth key during model use", () => {
    const home = homeFor("google-loader-no-auth-import");
    resetHome(home);

    expect(runPluginScript(home, googleLoaderDoesNotImportAuthScript())).toMatchObject({
      accounts: [],
      managerAccounts: [],
    });
  });

  test("OpenAI API key import is idempotent across fresh managers", () => {
    const home = homeFor("openai-import-idempotent");
    resetHome(home);

    expect(runPluginScript(home, repeatedOpenCodeApiImportScript("openai", "sk-openai-import"))).toMatchObject({
      accounts: [{ apiKey: "sk-openai-import" }],
    });
  });

  test("Google API key import is idempotent across fresh managers", () => {
    const home = homeFor("google-import-idempotent");
    resetHome(home);

    expect(runPluginScript(home, repeatedOpenCodeApiImportScript("google", "AIza-google-import"))).toMatchObject({
      accounts: [{ apiKey: "AIza-google-import" }],
    });
  });

  test("OAuth import without current access token does not duplicate existing OAuth accounts", () => {
    const home = homeFor("oauth-import-rotated-refresh");
    resetHome(home);
    const accessToken = fakeAccessToken({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-123",
        chatgpt_user_id: "user-123",
      },
      "https://api.openai.com/profile": { email: "person@example.test" },
    });

    expect(runPluginScript(home, refreshOnlyOAuthImportScript(accessToken))).toMatchObject({
      accounts: [
        {
          refresh: "refresh-old",
          userId: "user-123",
          accountId: "account-123",
          email: "person@example.test",
        },
      ],
    });
  });
});
