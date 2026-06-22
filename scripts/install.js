#!/usr/bin/env node
/**
 * opencode-multi-auth installer.
 *
 * Usage:
 *   node scripts/install.js              # interactive install
 *   node scripts/install.js --yes        # non-interactive, auto-install
 *
 * Adds the plugin to opencode.json and optionally
 * kicks off `opencode auth login` to register an account.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { execSync } from "node:child_process";

const PLUGIN_NAME = "opencode-multi-auth";

function configDir() {
  return join(homedir(), ".config", "opencode");
}

function configPath() {
  return join(configDir(), "opencode.json");
}

function readConfig() {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n");
}

function ask(query) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const autoYes = process.argv.includes("--yes") || process.argv.includes("-y");

  const cfg = readConfig();

  // Read existing plugins list
  const plugins = [];
  if (Array.isArray(cfg.plugin)) {
    plugins.push(...cfg.plugin.map(String));
  }

  if (plugins.includes(PLUGIN_NAME)) {
    console.log(`[multi-auth] Plugin "${PLUGIN_NAME}" is already registered in opencode.json`);
  } else {
    if (!autoYes) {
      const answer = await ask(
        `[multi-auth] Register "${PLUGIN_NAME}" in opencode.json? [Y/n] `,
      );
      if (answer.toLowerCase() === "n" || answer.toLowerCase() === "no") {
        console.log("[multi-auth] Install cancelled.");
        process.exit(0);
      }
    }

    plugins.push(PLUGIN_NAME);
    cfg.plugin = plugins;
    writeConfig(cfg);
    console.log(`[multi-auth] Added "${PLUGIN_NAME}" to opencode.json`);
  }

  // Login prompt
  if (!autoYes) {
    const answer = await ask(
      "[multi-auth] Add an OpenAI account now? [Y/n] ",
    );
    if (answer.toLowerCase() === "n" || answer.toLowerCase() === "no") {
      console.log("[multi-auth] Done. Run `opencode auth login` later to add accounts.");
      process.exit(0);
    }
  }

  console.log("[multi-auth] Launching auth flow...");
  try {
    execSync("opencode auth login", { stdio: "inherit", cwd: configDir() });
  } catch {
    console.log("[multi-auth] Auth flow interrupted or failed. Run `opencode auth login` manually.");
  }

  console.log("[multi-auth] Install complete.");
}

main().catch((err) => {
  console.error("[multi-auth] Install error:", err);
  process.exit(1);
});
