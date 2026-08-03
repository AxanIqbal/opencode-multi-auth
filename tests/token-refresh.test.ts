import { expect, test } from "bun:test";
import { join } from "node:path";

function runRefreshTokenReuseScenario(): unknown {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--eval",
      `
        globalThis.fetch = async () => new Response(JSON.stringify({
          error: {
            message: "Your refresh token has already been used to generate a new access token.",
            type: "invalid_request_error",
            param: null,
            code: "refresh_token_reused",
          },
        }), { status: 400 });

        const { refreshAccessToken } = await import("./src/auth/tokens.ts");
        console.log("RESULT:" + JSON.stringify(await refreshAccessToken("stale-refresh-token")));
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
  if (!line) throw new Error(`Missing RESULT line:\n${result.stdout.toString()}`);
  return JSON.parse(line.slice("RESULT:".length));
}

test("classifies OpenAI nested refresh_token_reused errors", () => {
  // Given OpenAI's nested OAuth error response for an already-consumed refresh token.
  // When the token exchange fails.
  const result = runRefreshTokenReuseScenario();

  // Then AccountManager can activate its existing stale-token recovery path.
  expect(result).toMatchObject({
    type: "error",
    code: "refresh_token_reused",
  });
});
