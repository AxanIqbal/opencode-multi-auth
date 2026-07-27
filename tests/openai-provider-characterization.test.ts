import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const testRoot = join(
  process.env.TMPDIR ?? "/tmp",
  `opencode-openai-provider-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);

type Scenario = "invalid-json" | "chat-completion" | "quota-headers";

function runScenario(scenario: Scenario): unknown {
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
        manager.addApiKey("sk-characterization");

        const requests = [];
        const loader = await createOpenAILoader({
          cfg: { ...DEFAULT_CONFIG, quietMode: true },
          manager,
          client: {},
          fetchWithTimeout: async (url, init) => {
            requests.push({
              url: String(url),
              method: init?.method,
              headers: Object.fromEntries(new Headers(init?.headers).entries()),
              body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
            });
            if (scenario === "invalid-json") {
              throw new Error("Invalid JSON must not reach the upstream fetch");
            }
            const headers = scenario === "quota-headers"
              ? {
                  "x-ratelimit-remaining-requests": "30",
                  "x-ratelimit-reset-requests": "12345",
                }
              : undefined;
            return new Response(
              "event: response.output_text.delta\\ndata: {\\\"delta\\\":\\\"Hello \\\"}\\n\\n" +
              "event: response.output_text.delta\\ndata: {\\\"delta\\\":\\\"world\\\"}\\n\\n" +
              "event: response.completed\\ndata: {\\\"response\\\":{\\\"id\\\":\\\"resp-characterization\\\",\\\"created_at\\\":1700000000,\\\"usage\\\":{\\\"input_tokens\\\":11,\\\"output_tokens\\\":7,\\\"total_tokens\\\":18}}}\\n\\n",
              { headers },
            );
          },
          showToast: async () => undefined,
        })();
        const fetch = loader.fetch;
        if (typeof fetch !== "function") throw new Error("OpenAI loader did not expose fetch");
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          body: scenario === "invalid-json"
            ? "{ not valid JSON"
            : JSON.stringify({
                model: "gpt-5.5",
                messages: [
                  { role: "system", content: "Use terse answers." },
                  { role: "user", content: "Say hello." },
                ],
                reasoning_effort: "high",
              }),
        });
        console.log("RESULT:" + JSON.stringify({
          status: response.status,
          contentType: response.headers.get("content-type"),
          body: await response.json(),
          upstreamCalls: requests.length,
          request: requests[0],
          quota: manager.list()[0]?.quota,
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

test("returns 400 without upstream fetch when Chat Completions JSON is invalid", () => {
  // Given an API-key account and malformed Chat Completions JSON.
  // When the loader receives the request.
  const result = runScenario("invalid-json");

  // Then it rejects locally before dispatching upstream.
  expect(result).toEqual({
    status: 400,
    contentType: "application/json",
    body: { error: "Invalid request body" },
    upstreamCalls: 0,
  });
});

test("converts Chat Completions requests and wraps Responses SSE as chat.completion", () => {
  // Given a Chat Completions request with system instructions and reasoning effort.
  // When the loader dispatches its transformed Responses request.
  const result = runScenario("chat-completion");

  // Then it preserves the observable Chat Completions contract.
  expect(result).toMatchObject({
    status: 200,
    contentType: "application/json",
    upstreamCalls: 1,
    request: {
      url: "https://chatgpt.com/backend-api/codex/responses",
      method: "POST",
      headers: {
        authorization: "Bearer sk-characterization",
        "openai-authorization": "Bearer sk-characterization",
        "content-type": "application/json",
        "openai-beta": "responses=experimental",
      },
      body: {
        model: "gpt-5.5",
        instructions: "Use terse answers.",
        input: [{ role: "user", content: "Say hello." }],
        store: false,
        stream: true,
        reasoning: { effort: "high" },
      },
    },
    body: {
      id: "resp-characterization",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-5.5",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Hello world" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    },
  });
});

test("persists quota parsed from successful Chat Completions response headers", () => {
  // Given a successful Responses SSE with rate-limit headers.
  // When the Chat Completions loader handles that response.
  const result = runScenario("quota-headers");

  // Then the practical response-header quota seam updates the selected account.
  expect(result).toMatchObject({
    status: 200,
    upstreamCalls: 1,
    quota: { primary: { usedPercent: 70, resetsAt: 12345000 } },
  });
});
