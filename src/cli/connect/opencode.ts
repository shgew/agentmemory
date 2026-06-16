import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import type { ConnectAdapter, ConnectOptions, ConnectResult } from "./types.js";
import {
  backupFile,
  logAlreadyWired,
  logBackup,
  logInstalled,
  readJsonSafe,
  writeJsonAtomic,
} from "./util.js";
import { findPluginRoot } from "./codex-hooks.js";

// OpenCode does not use the standard `mcpServers` block. Its config is a
// top-level `mcp` key whose entries carry `type`, `command` as an array,
// and `enabled` (docs: README "OpenCode (MCP only)"). So it needs its own
// adapter rather than createJsonMcpAdapter.

const CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode.json");
const DETECT_DIR = join(homedir(), ".config", "opencode");
// `--with-plugin` resolves the bundled `plugin/opencode/agentmemory-capture.ts`
// from the installed @agentmemory/agentmemory package, copies it under
// ~/.config/opencode/plugins/, registers it in the top-level "plugin"
// array of opencode.json, and copies the recall + remember slash commands.
const PLUGINS_DIR = join(DETECT_DIR, "plugins");
const COMMANDS_DIR = join(DETECT_DIR, "commands");
const PLUGIN_FILENAME = "agentmemory-capture.ts";
const PLUGIN_REL_PATH = `./plugins/${PLUGIN_FILENAME}`;
const SLASH_COMMANDS = ["recall.md", "remember.md"];

// No `environment` block: OpenCode does not expand shell-style
// `${VAR:-default}` values, and writing them literally would override the
// user's real shell AGENTMEMORY_URL with an unexpanded string. The stdio
// child inherits the shell environment (an exported AGENTMEMORY_URL /
// AGENTMEMORY_SECRET still reaches the server), and the @agentmemory/mcp
// shim defaults unset vars (URL -> localhost:3111, no secret, all tools).
const OPENCODE_ENTRY = {
  type: "local",
  command: ["npx", "-y", "@agentmemory/mcp"],
  enabled: true,
};

type OpencodeConfig = Record<string, unknown>;
type McpEntry = Record<string, unknown>;

function entryMatches(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const command = (entry as McpEntry)["command"];
  return Array.isArray(command) && command.includes("@agentmemory/mcp");
}

function mergePluginArray(existing: unknown, entry: string): string[] {
  const current = Array.isArray(existing)
    ? (existing as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  if (current.includes(entry)) return current;
  return [...current, entry];
}

function installPluginAssets(
  config: OpencodeConfig,
  opts: ConnectOptions,
): { copied: string[]; pluginEntry: string } | { skipped: string } {
  let pluginRoot: string;
  try {
    pluginRoot = findPluginRoot();
  } catch (err) {
    return { skipped: err instanceof Error ? err.message : String(err) };
  }

  const pluginSource = join(pluginRoot, "opencode", PLUGIN_FILENAME);
  if (!existsSync(pluginSource)) {
    return {
      skipped: `bundled plugin source not found at ${pluginSource}`,
    };
  }

  const copied: string[] = [];

  if (opts.dryRun) {
    p.log.info(
      `[dry-run] Would copy ${PLUGIN_FILENAME} to ${PLUGINS_DIR}/`,
    );
    for (const cmd of SLASH_COMMANDS) {
      p.log.info(`[dry-run] Would copy ${cmd} to ${COMMANDS_DIR}/`);
    }
    p.log.info(
      `[dry-run] Would merge "${PLUGIN_REL_PATH}" into top-level "plugin" array in ${CONFIG_PATH}`,
    );
    return { copied: [], pluginEntry: PLUGIN_REL_PATH };
  }

  mkdirSync(PLUGINS_DIR, { recursive: true });
  const pluginTarget = join(PLUGINS_DIR, PLUGIN_FILENAME);
  if (existsSync(pluginTarget)) {
    const backupPath = backupFile(pluginTarget, "opencode-plugin", "ts");
    logBackup(backupPath);
  }
  copyFileSync(pluginSource, pluginTarget);
  copied.push(pluginTarget);

  mkdirSync(COMMANDS_DIR, { recursive: true });
  for (const cmd of SLASH_COMMANDS) {
    const cmdSource = join(pluginRoot, "opencode", "commands", cmd);
    if (!existsSync(cmdSource)) continue;
    const cmdTarget = join(COMMANDS_DIR, cmd);
    if (existsSync(cmdTarget)) {
      const backupPath = backupFile(cmdTarget, "opencode-command", "md");
      logBackup(backupPath);
    }
    copyFileSync(cmdSource, cmdTarget);
    copied.push(cmdTarget);
  }

  config["plugin"] = mergePluginArray(config["plugin"], PLUGIN_REL_PATH);
  // resolved entry: ./plugins/agentmemory-capture.ts

  return { copied, pluginEntry: PLUGIN_REL_PATH };
}

export const adapter: ConnectAdapter = {
  name: "opencode",
  displayName: "OpenCode",
  category: "mcp",
  docs: "https://github.com/rohitg00/agentmemory#other-agents",
  protocolNote:
    "Using MCP via ~/.config/opencode/opencode.json (top-level `mcp` key). Pass --with-plugin to also install the auto-capture plugin and slash commands.",

  detect(): boolean {
    return existsSync(DETECT_DIR);
  },

  async install(opts: ConnectOptions): Promise<ConnectResult> {
    const existing = readJsonSafe<OpencodeConfig>(CONFIG_PATH);
    const next: OpencodeConfig = existing ? { ...existing } : {};
    const existingMcp = next["mcp"];
    const mcp: Record<string, McpEntry> =
      existingMcp &&
      typeof existingMcp === "object" &&
      !Array.isArray(existingMcp)
        ? { ...(existingMcp as Record<string, McpEntry>) }
        : {};

    const alreadyHas = entryMatches(mcp["agentmemory"]);
    if (alreadyHas && !opts.force) {
      logAlreadyWired(this.displayName, CONFIG_PATH);
      if (opts.withPlugin) {
        const pluginResult = installPluginAssets(next, opts);
        if ("skipped" in pluginResult) {
          p.log.warn(
            `OpenCode plugin install skipped: ${pluginResult.skipped}.`,
          );
        } else if (!opts.dryRun) {
          writeJsonAtomic(CONFIG_PATH, next);
          logInstalled(`${this.displayName} plugin`, PLUGINS_DIR);
        }
      }
      return { kind: "already-wired", mutatedPath: CONFIG_PATH };
    }

    if (opts.dryRun) {
      p.log.info(
        `[dry-run] Would ${alreadyHas ? "overwrite" : "add"} mcp.agentmemory in ${CONFIG_PATH}`,
      );
      if (opts.withPlugin) {
        installPluginAssets(next, opts);
      }
      return { kind: "installed", mutatedPath: CONFIG_PATH };
    }

    let backupPath: string | undefined;
    if (existsSync(CONFIG_PATH)) {
      backupPath = backupFile(CONFIG_PATH, this.name);
      logBackup(backupPath);
    } else {
      mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    }

    mcp["agentmemory"] = { ...OPENCODE_ENTRY };
    next["mcp"] = mcp;

    let pluginInstallNote: string | undefined;
    if (opts.withPlugin) {
      const pluginResult = installPluginAssets(next, opts);
      if ("skipped" in pluginResult) {
        pluginInstallNote = `Plugin install skipped: ${pluginResult.skipped}`;
        p.log.warn(pluginInstallNote);
      } else {
        pluginInstallNote = `Copied ${pluginResult.copied.length} file(s) to ${DETECT_DIR}`;
      }
    }

    writeJsonAtomic(CONFIG_PATH, next);

    const verify = readJsonSafe<OpencodeConfig>(CONFIG_PATH);
    const verifyMcp = verify?.["mcp"] as Record<string, McpEntry> | undefined;
    if (!entryMatches(verifyMcp?.["agentmemory"])) {
      p.log.error(
        `Verification failed: ${CONFIG_PATH} did not contain mcp.agentmemory after write.`,
      );
      return { kind: "skipped", reason: "verification-failed" };
    }

    logInstalled(this.displayName, CONFIG_PATH);
    if (opts.withPlugin && pluginInstallNote) {
      p.log.info(pluginInstallNote);
    }
    return {
      kind: "installed",
      mutatedPath: CONFIG_PATH,
      ...(backupPath !== undefined && { backupPath }),
    };
  },
};
