import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const testRoot = join(
  process.env.TMPDIR ?? "/tmp",
  `opencode-multi-auth-authrot-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);

type Scenario = "rotates-on-401" | "all-accounts-401";

function runAuthRotationScenario(scenario: Scenario): unknown {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--eval",
      `
        import { AccountManager } from "./src/accounts/manager.ts";
        import { DEFAULT_CONFIG } from "./src/accounts/types.ts";
        import { createOpenAILoader } from "./src/providers/openai/index.ts";

        const scenario = ${JSON.stringify(scenario)};
        const manager = new AccountManager(
          { ...DEFAULT_CONFIG, quietMode: true },
          ${JSON.stringify(join(testRoot, `${scenario}.json`))},
        );
        manager.addApiKey("sk-a");
        manager.addApiKey("sk-b");

        const expiredBody = JSON.stringify({ error: "Provided authentication token is expired. Please try signing in again." });
        let calls = 0;
        const loader = await createOpenAILoader({
          cfg: { ...DEFAULT_CONFIG, quietMode: true },
          manager,
          client: {},
          fetchWithTimeout: async () => {
            calls++;
            if (scenario === "all-accounts-401") {
              return new Response(expiredBody, { status: 401, headers: { "Content-Type": "application/json" } });
            }
            if (calls <= 2) {
              return new Response(expiredBody, { status: 401, headers: { "Content-Type": "application/json" } });
            }
            return new Response(
              "event: response.output_text.delta\\ndata: {\\\"delta\\\":\\\"Hello\\\"}\\n\\n" +
              "event: response.completed\\ndata: {\\\"response\\\":{\\\"id\\\":\\\"resp-auth-rot\\\",\\\"created_at\\\":1700000000,\\\"usage\\\":{\\\"input_tokens\\\":3,\\\"output_tokens\\\":1,\\\"total_tokens\\\":4}}}\\n\\n",
            );
          },
          showToast: async () => undefined,
        })();
        const response = await loader.fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] }),
        });
        const text = await response.text();
        let parsed: unknown = null;
        try { parsed = JSON.parse(text); } catch {}
        console.log("RESULT:" + JSON.stringify({ status: response.status, calls, body: parsed }));
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

test("rotates past an invalid-token account to the next healthy account", () => {
  // Given two API-key accounts where the first rejects with an expired-token 401.
  // When the loader dispatches a Chat Completions request.
  const result = runAuthRotationScenario("rotates-on-401");

  // Then it keeps rotating instead of surfacing the 401, and returns the wrapped completion.
  expect(result).toMatchObject({
    status: 200,
    calls: 3,
    body: { id: "resp-auth-rot", object: "chat.completion" },
  });
});

test("surfaces the original auth error only after every account rejects", () => {
  // Given two API-key accounts that both reject with an expired-token 401.
  // When the loader dispatches a Chat Completions request.
  const result = runAuthRotationScenario("all-accounts-401");

  // Then it exhausts the pool and preserves the original error body instead of crashing.
  expect(result).toMatchObject({
    status: 401,
    calls: 3,
    body: { error: "Provided authentication token is expired. Please try signing in again." },
  });
});