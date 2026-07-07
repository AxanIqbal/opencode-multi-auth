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

import { existsSync, lstatSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PLUGIN_NAME = "opencode-multi-auth";
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOOGLE_PLUGIN_LINK = `${PACKAGE_ROOT}-google`;

function ensureGooglePluginPath() {
  if (existsSync(GOOGLE_PLUGIN_LINK)) {
    const stat = lstatSync(GOOGLE_PLUGIN_LINK);
    if (stat.isSymbolicLink()) {
      if (realpathSync(GOOGLE_PLUGIN_LINK) === PACKAGE_ROOT) return GOOGLE_PLUGIN_LINK;
      throw new Error(`${GOOGLE_PLUGIN_LINK} points outside ${PACKAGE_ROOT}.`);
    }
    if (stat.isDirectory()) {
      const pkg = JSON.parse(readFileSync(join(GOOGLE_PLUGIN_LINK, "package.json"), "utf-8"));
      if (pkg?.name === PLUGIN_NAME) return GOOGLE_PLUGIN_LINK;
      throw new Error(`${GOOGLE_PLUGIN_LINK} is not an ${PLUGIN_NAME} checkout.`);
    }
    throw new Error(`${GOOGLE_PLUGIN_LINK} exists but is not a directory or symlink.`);
  }
  symlinkSync(PACKAGE_ROOT, GOOGLE_PLUGIN_LINK, "dir");
  return GOOGLE_PLUGIN_LINK;
}

function pluginEntries() {
  return [
    [PACKAGE_ROOT, { provider: "openai" }],
    [ensureGooglePluginPath(), { provider: "google" }],
  ];
}

function isMultiAuthEntry(entry) {
  if (entry === PLUGIN_NAME || entry === PACKAGE_ROOT || entry === GOOGLE_PLUGIN_LINK) return true;
  if (!Array.isArray(entry)) return false;
  return entry[0] === PLUGIN_NAME || entry[0] === PACKAGE_ROOT || entry[0] === GOOGLE_PLUGIN_LINK;
}

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
  let plugins = [];
  if (Array.isArray(cfg.plugin)) {
    plugins = [...cfg.plugin];
  }

  const hasMultiAuth = plugins.some(isMultiAuthEntry);

  if (hasMultiAuth) {
    plugins = plugins.filter((entry) => !isMultiAuthEntry(entry));
    plugins.push(...pluginEntries());
    cfg.plugin = plugins;
    writeConfig(cfg);
    console.log(`[multi-auth] Updated "${PLUGIN_NAME}" provider entries in opencode.json`);
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

    plugins.push(...pluginEntries());
    cfg.plugin = plugins;
    writeConfig(cfg);
    console.log(`[multi-auth] Added "${PLUGIN_NAME}" provider entries to opencode.json`);
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
