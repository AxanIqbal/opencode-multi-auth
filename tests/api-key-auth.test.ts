import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const testRoot = join(process.env.TMPDIR ?? "/tmp", `opencode-multi-auth-${Date.now()}-${Math.random().toString(16).slice(2)}`);

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

function methodScript(provider: "openai" | "google", label: string): string {
  return `
    import { MultiAuthPlugin } from "./src/index.ts";
    const hooks = await MultiAuthPlugin({ client: { tui: { showToast: async () => undefined } } }, { provider: ${JSON.stringify(provider)} });
    const method = hooks.auth?.methods.find((item) => item.label === ${JSON.stringify(label)});
    console.log("RESULT:" + JSON.stringify({
      type: method?.type,
      promptKeys: method?.prompts?.map((prompt) => prompt.key) ?? null,
    }));
    await hooks.dispose?.();
  `;
}

function apiLoginScript(provider: "openai" | "google", apiKey: string, label: string): string {
  return `
    import { existsSync, readFileSync } from "node:fs";
    import { join } from "node:path";
    import { MultiAuthPlugin } from "./src/index.ts";

    const client = { tui: { showToast: async () => undefined } };
    const openAIHooks = await MultiAuthPlugin({ client }, { provider: "openai" });
    const googleHooks = await MultiAuthPlugin({ client }, { provider: "google" });
    const targetHooks = ${JSON.stringify(provider)} === "openai" ? openAIHooks : googleHooks;
    const method = targetHooks.auth?.methods.find((item) => item.label === ${JSON.stringify(provider === "openai" ? "OpenAI API Key" : "Google API Key")});
    const auth = await method.authorize({ api_key: ${JSON.stringify(apiKey)}, label: ${JSON.stringify(label)} });
    const result = await auth.callback();
    if (result.type !== "success") throw new Error("API key callback failed");

    await openAIHooks.dispose?.();
    await googleHooks.dispose?.();

    const home = process.env.HOME;
    const openAIFile = join(home, ".config", "opencode", "openai-accounts.json");
    const googleFile = join(home, ".config", "opencode", "google-accounts.json");
    const readAccounts = (file) => existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")).accounts : [];

    console.log("RESULT:" + JSON.stringify({
      result,
      openAIExists: existsSync(openAIFile),
      googleExists: existsSync(googleFile),
      openAIAccounts: readAccounts(openAIFile),
      googleAccounts: readAccounts(googleFile),
    }));
  `;
}

function bothApiLoginScript(): string {
  return `
    import { existsSync, readFileSync } from "node:fs";
    import { join } from "node:path";
    import { MultiAuthPlugin } from "./src/index.ts";

    const client = { tui: { showToast: async () => undefined } };
    const openAIHooks = await MultiAuthPlugin({ client }, { provider: "openai" });
    const googleHooks = await MultiAuthPlugin({ client }, { provider: "google" });

    const openAIMethod = openAIHooks.auth?.methods.find((item) => item.label === "OpenAI API Key");
    const openAIAuth = await openAIMethod.authorize({ api_key: "sk-openai-test", label: "openai-work" });
    const openAIResult = await openAIAuth.callback();
    if (openAIResult.type !== "success") throw new Error("OpenAI API key callback failed");

    const googleMethod = googleHooks.auth?.methods.find((item) => item.label === "Google API Key");
    const googleAuth = await googleMethod.authorize({ api_key: "AIza-google-test", label: "google-work" });
    const googleResult = await googleAuth.callback();
    if (googleResult.type !== "success") throw new Error("Google API key callback failed");

    await openAIHooks.dispose?.();
    await googleHooks.dispose?.();

    const home = process.env.HOME;
    const openAIFile = join(home, ".config", "opencode", "openai-accounts.json");
    const googleFile = join(home, ".config", "opencode", "google-accounts.json");
    const readAccounts = (file) => existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")).accounts : [];

    console.log("RESULT:" + JSON.stringify({
      openAIAccounts: readAccounts(openAIFile),
      googleAccounts: readAccounts(googleFile),
    }));
  `;
}

beforeEach(() => {
  resetHome(testRoot);
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("API-key auth methods", () => {
  test("Google API key method is plugin-handled and asks only for key plus label", () => {
    const home = homeFor("google-method");
    resetHome(home);

    expect(runPluginScript(home, methodScript("google", "Google API Key"))).toEqual({
      type: "oauth",
      promptKeys: ["api_key", "label"],
    });
  });

  test("OpenAI API key method is plugin-handled and asks only for key plus label", () => {
    const home = homeFor("openai-method");
    resetHome(home);

    expect(runPluginScript(home, methodScript("openai", "OpenAI API Key"))).toEqual({
      type: "oauth",
      promptKeys: ["api_key", "label"],
    });
  });
});

describe("API-key plugin callback", () => {
  test("OpenAI API key login adds only to OpenAI accounts JSON", () => {
    const home = homeFor("openai-login");
    resetHome(home);

    expect(runPluginScript(home, apiLoginScript("openai", "sk-openai-test", "openai-work"))).toMatchObject({
      result: { type: "success", key: "sk-openai-test", provider: "openai" },
      openAIExists: true,
      googleExists: false,
      openAIAccounts: [{ apiKey: "sk-openai-test", label: "openai-work" }],
    });
  });

  test("Google API key login adds only to Google accounts JSON", () => {
    const home = homeFor("google-login");
    resetHome(home);

    expect(runPluginScript(home, apiLoginScript("google", "AIza-google-test", "google-work"))).toMatchObject({
      result: { type: "success", key: "AIza-google-test", provider: "google" },
      openAIExists: false,
      googleExists: true,
      googleAccounts: [{ apiKey: "AIza-google-test", label: "google-work" }],
    });
  });

  test("OpenAI and Google API key logins store different keys in different JSON files", () => {
    const home = homeFor("both-login");
    resetHome(home);

    expect(runPluginScript(home, bothApiLoginScript())).toMatchObject({
      openAIAccounts: [{ apiKey: "sk-openai-test", label: "openai-work" }],
      googleAccounts: [{ apiKey: "AIza-google-test", label: "google-work" }],
    });
  });
});
