export type ConnectOptions = {
  dryRun: boolean;
  force: boolean;
  /**
   * When true, the Codex adapter additionally writes a global
   * `~/.codex/hooks.json` block referencing absolute paths to bundled hook
   * scripts. Workaround for openai/codex#16430, which prevents plugin-local
   * hooks from dispatching on Codex Desktop. No-op for other adapters.
   */
  withHooks?: boolean;
  /**
   * When true, the OpenCode adapter additionally copies the bundled
   * agentmemory-capture.ts plugin into `~/.config/opencode/plugins/`,
   * registers it under the top-level `plugin` array in
   * `~/.config/opencode/opencode.json`, copies the 16-skill tree from
   * `plugin/skills/<name>/` to `<OPENCODE_CONFIG_DIR>/skills/<name>/SKILL.md`,
   * and removes the now-deprecated agentmemory legacy slash command files
   * (recall.md, remember.md, health.md) from `<OPENCODE_CONFIG_DIR>/commands/`
   * if they exist from a previous install (backed up to ~/.agentmemory/backups/
   * first). No-op for other adapters.
   */
  withPlugin?: boolean;
};

export type ConnectAdapter = {
  name: string;
  displayName: string;
  docs?: string;
  /**
   * One-line explanation of which protocol this adapter wires (REST hooks vs
   * MCP) and why. Printed above the install summary so users see — before
   * any config mutation — that REST is the primary surface and MCP is the
   * opt-in bridge for MCP-only clients.
   */
  protocolNote?: string;
  /**
   * Integration style, used by onboarding to group agents. "native" =
   * ships a first-party plugin / lifecycle hooks; "mcp" = wires the MCP
   * server only. Declared on the adapter so the picker never needs a
   * separate hardcoded list (#872). Defaults to "mcp" when omitted.
   */
  category?: "native" | "mcp";
  detect(): boolean;
  install(opts: ConnectOptions): Promise<ConnectResult>;
};

export type ConnectResult =
  | { kind: "installed"; mutatedPath?: string; backupPath?: string }
  | { kind: "already-wired"; mutatedPath?: string }
  | { kind: "stub"; reason: string }
  | { kind: "skipped"; reason: string };
