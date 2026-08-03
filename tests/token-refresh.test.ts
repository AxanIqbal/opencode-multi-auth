import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AccountManager } from "../src/accounts/manager.js";

const testRoot = join(
  process.env.TMPDIR ?? "/tmp",
  `opencode-token-refresh-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);

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

test("serializes shared-account refreshes across managers", async () => {
  const accountsFile = join(testRoot, "openai-accounts.json");
  rmSync(testRoot, { recursive: true, force: true });
  mkdirSync(testRoot, { recursive: true });

  const firstManager = new AccountManager({ quietMode: true }, accountsFile);
  firstManager.addAccount("refresh-old", "expired-access", 0);
  const firstAccount = firstManager.list()[0];
  if (!firstAccount) throw new Error("Missing first manager account");
  const secondManager = new AccountManager({ quietMode: true }, accountsFile);
  secondManager.load();
  const secondAccount = secondManager.list()[0];
  if (!secondAccount) throw new Error("Missing second manager account");

  const originalFetch = globalThis.fetch;
  let refreshCalls = 0;
  let signalFirstRefresh: () => void = () => undefined;
  const firstRefreshStarted = new Promise<void>((resolve) => {
    signalFirstRefresh = resolve;
  });
  let releaseRefresh: () => void = () => undefined;
  const refreshCanComplete = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });

  globalThis.fetch = async () => {
    refreshCalls++;
    if (refreshCalls === 1) {
      signalFirstRefresh();
      await refreshCanComplete;
    }
    return new Response(JSON.stringify({
      access_token: "fresh-access",
      refresh_token: "refresh-new",
      expires_in: 3600,
    }));
  };

  try {
    // Given two managers sharing one account store with an expired OAuth token.
    const firstRefresh = firstManager.ensureValidToken(firstAccount);
    await firstRefreshStarted;

    // When both managers refresh at the same time.
    const secondRefresh = secondManager.ensureValidToken(secondAccount);
    releaseRefresh();
    const [firstOk, secondOk] = await Promise.all([firstRefresh, secondRefresh]);

    // Then one refresh consumes the rotated token and both managers adopt it.
    expect({
      firstOk,
      secondOk,
      refreshCalls,
      firstRefresh: firstAccount.refresh,
      secondRefresh: secondAccount.refresh,
    }).toEqual({
      firstOk: true,
      secondOk: true,
      refreshCalls: 1,
      firstRefresh: "refresh-new",
      secondRefresh: "refresh-new",
    });
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(testRoot, { recursive: true, force: true });
  }
});
