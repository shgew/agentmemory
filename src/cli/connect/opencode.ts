import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, rmdirSync } from "node:fs";
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

// `--with-plugin` resolves the bundled `plugin/opencode/agentmemory-capture.ts`
// from the installed @agentmemory/agentmemory package, copies it under
// the opencode config dir's plugins/, registers it in the top-level "plugin"
// array of opencode.json, copies the agentmemory skills tree from
// `plugin/skills/` to `<opencode-config>/skills/<name>/SKILL.md`, AND removes
// any deprecated agentmemory legacy slash command files (recall.md,
// remember.md, health.md) from `<opencode-config>/commands/` left behind by
// earlier versions of this adapter (backed up to ~/.agentmemory/backups/
// first). OpenCode's command registry merges skills into its slash command
// palette as `source: "skill"`, so /recall, /remember, /health and the other
// invocable skills all appear in the palette while reference skills load on
// demand via the native `skill` tool. All paths are resolved lazily so
// OPENCODE_CONFIG_DIR set per-invocation (and test isolation via process.env
// mutation) takes effect.
function opencodeDir(): string {
  return process.env["OPENCODE_CONFIG_DIR"]?.trim() || join(homedir(), ".config", "opencode");
}
function configPath(): string { return join(opencodeDir(), "opencode.json"); }
function detectDir(): string { return opencodeDir(); }
function pluginsDir(): string { return join(opencodeDir(), "plugins"); }
function skillsDir(): string { return join(opencodeDir(), "skills"); }
const PLUGIN_FILENAME = "agentmemory-capture.ts";
const PLUGIN_REL_PATH = `./plugins/${PLUGIN_FILENAME}`;
const SKILL_SOURCE_REL = "skills";
const LEGACY_COMMAND_FILES = ["recall.md", "remember.md", "health.md"];

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

function copySkillTree(source: string, target: string): string[] {
  const copied: string[] = [];
  if (!existsSync(source)) return copied;
  mkdirSync(target, { recursive: true });
  const entries = readdirSync(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      copied.push(...copySkillTree(sourcePath, targetPath));
    } else if (entry.isFile()) {
      if (existsSync(targetPath)) {
        const backupPath = backupFile(targetPath, "opencode-skill", "md");
        logBackup(backupPath);
      }
      copyFileSync(sourcePath, targetPath);
      copied.push(targetPath);
    }
  }
  return copied;
}

function cleanupLegacyCommands(dryRun: boolean): string[] {
  const removed: string[] = [];
  const legacyDir = join(opencodeDir(), "commands");
  if (!existsSync(legacyDir)) return removed;
  for (const name of LEGACY_COMMAND_FILES) {
    const legacyPath = join(legacyDir, name);
    if (!existsSync(legacyPath)) continue;
    if (dryRun) {
      p.log.info(`[dry-run] Would remove deprecated ${legacyPath} (backed up to ~/.agentmemory/backups/ first)`);
      removed.push(legacyPath);
      continue;
    }
    const backupPath = backupFile(legacyPath, "opencode-legacy-command", "md");
    logBackup(backupPath);
    rmSync(legacyPath);
    removed.push(legacyPath);
  }
  if (!dryRun && removed.length > 0) {
    try {
      const remaining = readdirSync(legacyDir);
      if (remaining.length === 0) rmdirSync(legacyDir);
    } catch {
      // dir might have other (user) files; leave alone
    }
  }
  return removed;
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
      `[dry-run] Would copy ${PLUGIN_FILENAME} to ${pluginsDir()}/`,
    );
    const skillSource = join(pluginRoot, SKILL_SOURCE_REL);
    if (existsSync(skillSource)) {
      const skillDirs = readdirSync(skillSource, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      p.log.info(
        `[dry-run] Would copy ${skillDirs.length} skill subtree(s) (${skillDirs.join(", ")}) to ${skillsDir()}/`,
      );
    }
    cleanupLegacyCommands(true);
    p.log.info(
      `[dry-run] Would merge "${PLUGIN_REL_PATH}" into top-level "plugin" array in ${configPath()}`,
    );
    return { copied: [], pluginEntry: PLUGIN_REL_PATH };
  }

  mkdirSync(pluginsDir(), { recursive: true });
  const pluginTarget = join(pluginsDir(), PLUGIN_FILENAME);
  if (existsSync(pluginTarget)) {
    const backupPath = backupFile(pluginTarget, "opencode-plugin", "ts");
    logBackup(backupPath);
  }
  copyFileSync(pluginSource, pluginTarget);
  copied.push(pluginTarget);

  const skillSource = join(pluginRoot, SKILL_SOURCE_REL);
  if (existsSync(skillSource)) {
    const skillsCopied = copySkillTree(skillSource, skillsDir());
    copied.push(...skillsCopied);
  }

  const removedLegacy = cleanupLegacyCommands(false);
  copied.push(...removedLegacy);

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
    "Using MCP via ~/.config/opencode/opencode.json (top-level `mcp` key). Pass --with-plugin to also install the auto-capture plugin and 16 skills (9 invocable: recall, remember, health, recap, handoff, forget, commit-context, commit-history, session-history; 7 reference). OpenCode surfaces invocable skills in the slash command palette automatically.",

  detect(): boolean {
    return existsSync(detectDir());
  },

  async install(opts: ConnectOptions): Promise<ConnectResult> {
    const existing = readJsonSafe<OpencodeConfig>(configPath());
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
      logAlreadyWired(this.displayName, configPath());
      if (opts.withPlugin) {
        const pluginResult = installPluginAssets(next, opts);
        if ("skipped" in pluginResult) {
          p.log.warn(
            `OpenCode plugin install skipped: ${pluginResult.skipped}.`,
          );
        } else if (!opts.dryRun) {
          writeJsonAtomic(configPath(), next);
          logInstalled(`${this.displayName} plugin`, pluginsDir());
        }
      }
      return { kind: "already-wired", mutatedPath: configPath() };
    }

    if (opts.dryRun) {
      p.log.info(
        `[dry-run] Would ${alreadyHas ? "overwrite" : "add"} mcp.agentmemory in ${configPath()}`,
      );
      if (opts.withPlugin) {
        installPluginAssets(next, opts);
      }
      return { kind: "installed", mutatedPath: configPath() };
    }

    let backupPath: string | undefined;
    if (existsSync(configPath())) {
      backupPath = backupFile(configPath(), this.name);
      logBackup(backupPath);
    } else {
      mkdirSync(dirname(configPath()), { recursive: true });
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
        pluginInstallNote = `Copied ${pluginResult.copied.length} file(s) to ${detectDir()}`;
      }
    }

    writeJsonAtomic(configPath(), next);

    const verify = readJsonSafe<OpencodeConfig>(configPath());
    const verifyMcp = verify?.["mcp"] as Record<string, McpEntry> | undefined;
    if (!entryMatches(verifyMcp?.["agentmemory"])) {
      p.log.error(
        `Verification failed: ${configPath()} did not contain mcp.agentmemory after write.`,
      );
      return { kind: "skipped", reason: "verification-failed" };
    }

    logInstalled(this.displayName, configPath());
    if (opts.withPlugin && pluginInstallNote) {
      p.log.info(pluginInstallNote);
    }
    return {
      kind: "installed",
      mutatedPath: configPath(),
      ...(backupPath !== undefined && { backupPath }),
    };
  },
};
