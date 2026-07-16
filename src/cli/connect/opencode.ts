import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as p from "@clack/prompts";
import type { ConnectAdapter, ConnectOptions, ConnectResult } from "./types.js";
import {
  backupFile,
  logAlreadyWired,
  logBackup,
  logInstalled,
  readJsoncSafe,
  upsertJsoncNestedPropertyAtomic,
  writeJsonAtomic,
} from "./util.js";
import { findPluginRoot } from "./codex-hooks.js";

// OpenCode does not use the standard `mcpServers` block. Its config is a
// top-level `mcp` key whose entries carry `type`, `command` as an array,
// and `enabled` (docs: README "OpenCode (MCP only)"). So it needs its own
// adapter rather than createJsonMcpAdapter.

function opencodeDir(): string {
  return process.env["OPENCODE_CONFIG_DIR"]?.trim() || join(homedir(), ".config", "opencode");
}
function configPath(): string {
  const jsonc = join(opencodeDir(), "opencode.jsonc");
  if (existsSync(jsonc)) return jsonc;
  return join(opencodeDir(), "opencode.json");
}
function detectDir(): string { return opencodeDir(); }
function pluginsDir(): string { return join(opencodeDir(), "plugins"); }
function skillsDir(): string { return join(opencodeDir(), "skills"); }
const PLUGIN_FILENAME = "agentmemory-capture.ts";
const SKILL_SOURCE_REL = "skills";
const LEGACY_COMMAND_FILES = ["recall.md", "remember.md", "health.md"];
const LEGACY_COMMAND_HASHES: Record<string, string> = {
  "recall.md": "3b05701dbade65e1192726592b922faace26bf0b659f31e7b54a6a584880e97b",
  "remember.md": "8e27caf25ba2d2f1fd7944f0454c90cf9b4b5ff24054a91c5baeb242025fa6a9",
  "health.md": "362ef5eb83ef59821e4cfcecfdb397cf5ad0d274a39e751f1c0ffc906abc78b6",
};

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

function isGeneratedLegacyCommand(path: string, name: string): boolean {
  const expected = LEGACY_COMMAND_HASHES[name];
  if (!expected) return false;
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  return actual === expected;
}

function cleanupLegacyCommands(dryRun: boolean): string[] {
  const removed: string[] = [];
  const legacyDir = join(opencodeDir(), "commands");
  if (!existsSync(legacyDir)) return removed;
  for (const name of LEGACY_COMMAND_FILES) {
    const legacyPath = join(legacyDir, name);
    if (!existsSync(legacyPath)) continue;
    if (!isGeneratedLegacyCommand(legacyPath, name)) continue;
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
  opts: ConnectOptions,
): { copied: string[] } | { skipped: string } {
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
    return { copied: [] };
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

  return { copied };
}

function writeConfig(path: string, config: OpencodeConfig): void {
  if (path.endsWith(".jsonc") && existsSync(path)) {
    upsertJsoncNestedPropertyAtomic(
      path,
      "mcp",
      "agentmemory",
      OPENCODE_ENTRY,
    );
    return;
  }
  writeJsonAtomic(path, config);
}

export const adapter: ConnectAdapter = {
  name: "opencode",
  displayName: "OpenCode",
  category: "mcp",
  docs: "https://github.com/rohitg00/agentmemory#other-agents",
  protocolNote:
    "Using MCP via ~/.config/opencode/opencode.jsonc or opencode.json (top-level `mcp` key). Pass --with-plugin to also install the auto-capture plugin and 16 skills (9 invocable: recall, remember, health, recap, handoff, forget, commit-context, commit-history, session-history; 7 reference). OpenCode auto-discovers the copied plugin and surfaces invocable skills in the slash command palette.",

  detect(): boolean {
    return existsSync(detectDir());
  },

  async install(opts: ConnectOptions): Promise<ConnectResult> {
    const targetConfigPath = configPath();
    const configExists = existsSync(targetConfigPath);
    const parsed = readJsoncSafe<unknown>(targetConfigPath);
    if (
      configExists &&
      (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    ) {
      p.log.error(
        `OpenCode config is not valid JSON/JSONC: ${targetConfigPath}`,
      );
      return { kind: "skipped", reason: "invalid-config" };
    }
    const existing = parsed as OpencodeConfig | null;
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
      logAlreadyWired(this.displayName, targetConfigPath);
      if (opts.withPlugin) {
        const pluginResult = installPluginAssets(opts);
        if ("skipped" in pluginResult) {
          p.log.warn(
            `OpenCode plugin install skipped: ${pluginResult.skipped}.`,
          );
        } else if (!opts.dryRun) {
          logInstalled(`${this.displayName} plugin`, pluginsDir());
        }
      }
      return { kind: "already-wired", mutatedPath: targetConfigPath };
    }

    if (opts.dryRun) {
      p.log.info(
        `[dry-run] Would ${alreadyHas ? "overwrite" : "add"} mcp.agentmemory in ${targetConfigPath}`,
      );
      if (opts.withPlugin) {
        installPluginAssets(opts);
      }
      return { kind: "installed", mutatedPath: targetConfigPath };
    }

    let backupPath: string | undefined;
    if (configExists) {
      backupPath = backupFile(
        targetConfigPath,
        this.name,
        targetConfigPath.endsWith(".jsonc") ? "jsonc" : "json",
      );
      logBackup(backupPath);
    } else {
      mkdirSync(dirname(targetConfigPath), { recursive: true });
    }

    mcp["agentmemory"] = { ...OPENCODE_ENTRY };
    next["mcp"] = mcp;

    let pluginInstallNote: string | undefined;
    if (opts.withPlugin) {
      const pluginResult = installPluginAssets(opts);
      if ("skipped" in pluginResult) {
        pluginInstallNote = `Plugin install skipped: ${pluginResult.skipped}`;
        p.log.warn(pluginInstallNote);
      } else {
        pluginInstallNote = `Copied ${pluginResult.copied.length} file(s) to ${detectDir()}`;
      }
    }

    writeConfig(targetConfigPath, next);

    const verify = readJsoncSafe<OpencodeConfig>(targetConfigPath);
    const verifyMcp = verify?.["mcp"] as Record<string, McpEntry> | undefined;
    if (!entryMatches(verifyMcp?.["agentmemory"])) {
      p.log.error(
        `Verification failed: ${targetConfigPath} did not contain mcp.agentmemory after write.`,
      );
      return { kind: "skipped", reason: "verification-failed" };
    }

    logInstalled(this.displayName, targetConfigPath);
    if (opts.withPlugin && pluginInstallNote) {
      p.log.info(pluginInstallNote);
    }
    return {
      kind: "installed",
      mutatedPath: targetConfigPath,
      ...(backupPath !== undefined && { backupPath }),
    };
  },
};
