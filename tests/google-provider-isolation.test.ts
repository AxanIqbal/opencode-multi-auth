import { expect, test } from "bun:test";
import { join } from "node:path";

test("returns a retryable unavailable response without dispatch when no Google API key exists", () => {
  // Given an empty Google account manager and a fetch seam that records dispatches.
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--eval",
      `
        import { AccountManager } from "./src/accounts/manager.ts";
        import { DEFAULT_CONFIG } from "./src/accounts/types.ts";
        import { createGoogleLoader } from "./src/providers/google/index.ts";

        const config = { ...DEFAULT_CONFIG, quietMode: true, rateLimitCooldownMs: 12_000 };
        const manager = new AccountManager(
          config,
          ${JSON.stringify(join(process.env.TMPDIR ?? "/tmp", `opencode-google-no-key-${Date.now()}.json`))},
        );
        let upstreamCalls = 0;
        const loader = createGoogleLoader({
          cfg: config,
          googleManager: manager,
          fetchWithTimeout: async () => {
            upstreamCalls += 1;
            return new Response("unexpected upstream request");
          },
        });
        const provider = await loader();
        if (typeof provider.fetch !== "function") throw new Error("Google loader did not expose fetch");
        const response = await provider.fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
          { method: "POST" },
        );
        console.log("RESULT:" + JSON.stringify({
          status: response.status,
          retryAfter: response.headers.get("retry-after"),
          body: await response.json(),
          upstreamCalls,
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

  // When the provider fetch handles a Gemini request without an API key.
  const observed: unknown = JSON.parse(line.slice("RESULT:".length));

  // Then it signals a retryable configuration failure without calling upstream.
  expect(observed).toEqual({
    status: 503,
    retryAfter: "12",
    body: { error: "No Google API-key accounts configured. Run opencode auth login and choose Google API Key." },
    upstreamCalls: 0,
  });
});
