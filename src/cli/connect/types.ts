export type ConnectOptions = {
  dryRun: boolean;
  force: boolean;
  /** Installs global Codex Desktop hooks when plugin-local hooks do not run. */
  withHooks?: boolean;
  /** Installs the OpenCode capture plugin and bundled skills. */
  withPlugin?: boolean;
};

export type ConnectAdapter = {
  name: string;
  displayName: string;
  docs?: string;
  /** One-line explanation of the protocol this adapter wires. */
  protocolNote?: string;
  /** Integration style used to group adapters during onboarding. */
  category?: "native" | "mcp";
  detect(): boolean;
  install(opts: ConnectOptions): Promise<ConnectResult>;
};

export type ConnectResult =
  | { kind: "installed"; mutatedPath?: string; backupPath?: string }
  | { kind: "already-wired"; mutatedPath?: string }
  | { kind: "stub"; reason: string }
  | { kind: "skipped"; reason: string };
