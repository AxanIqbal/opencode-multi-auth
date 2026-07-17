import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const testRoot = join(
  process.env.TMPDIR ?? "/tmp",
  `opencode-multi-auth-retry-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);

function runRetryScenario(): { status: number; retryAfter: string | null; cooldownSeconds: number } {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--eval",
      `
        import { AccountManager } from "./src/accounts/manager.ts";
        import { DEFAULT_CONFIG } from "./src/accounts/types.ts";
        import { createOpenAILoader } from "./src/providers/openai.ts";

        const manager = new AccountManager(DEFAULT_CONFIG, ${JSON.stringify(join(testRoot, "accounts.json"))});
        manager.addApiKey("sk-test");
        const loader = await createOpenAILoader({
          cfg: { ...DEFAULT_CONFIG, quietMode: true },
          manager,
          client: {},
          fetchWithTimeout: async () => new Response("rate limited", {
            status: 429,
            headers: { "Retry-After": "345600" },
          }),
          showToast: async () => undefined,
        })();
        const response = await loader.fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          body: JSON.stringify({ model: "gpt-5.5" }),
        });
        console.log("RESULT:" + JSON.stringify({
          status: response.status,
          retryAfter: response.headers.get("retry-after"),
          cooldownSeconds: Math.ceil((manager.list()[0].rateLimitResets["gpt-5.5"] - Date.now()) / 1000),
        }));
      `,
    ],
    cwd: join(import.meta.dir, ".."),
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

beforeEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
  mkdirSync(testRoot, { recursive: true });
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

test("OpenAI rate limits never defer account-pool rechecks for days", () => {
  const result = runRetryScenario();

  expect(result.status).toBe(503);
  expect(Number.parseInt(result.retryAfter ?? "", 10)).toBeLessThanOrEqual(60);
  expect(result.cooldownSeconds).toBeLessThanOrEqual(60);
});
