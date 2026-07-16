import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Regression guard for the 0.9.27 export-surface fix that split the plugin into
// two files: distributing the plugin as a SINGLE standalone file is the whole
// contract (`agentmemory connect opencode --with-plugin`, the manual `cp` docs,
// and nix all copy this one file alone into ~/.config/opencode/plugins/). Any
// local sibling-module import would crash every single-file install
// with ERR_MODULE_NOT_FOUND. This test copies the plugin ALONE into a fresh tmp
// dir and imports it in isolation to prove it has no local-sibling dependency.
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_SOURCE = join(TEST_DIR, "..", "plugin", "opencode", "agentmemory-capture.ts");

let tmpDir: string;
let copiedPluginPath: string;

// Repo-local tmp dir: vitest's Vite transform only serves .ts files under the
// workspace root (server.fs.allow), so an os.tmpdir() path would be refused.
async function importCopiedPlugin(): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(copiedPluginPath).href)) as Record<string, unknown>;
}

describe("OpenCode plugin standalone import", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(TEST_DIR, ".tmp-standalone-"));
    copiedPluginPath = join(tmpDir, "agentmemory-capture.ts");
    copyFileSync(PLUGIN_SOURCE, copiedPluginPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("imports when copied alone with no sibling files", async () => {
    await expect(importCopiedPlugin()).resolves.toBeDefined();
  });

  it("exposes exactly one runtime export: AgentmemoryCapturePlugin", async () => {
    const mod = await importCopiedPlugin();
    expect(Object.keys(mod)).toEqual(["AgentmemoryCapturePlugin"]);
  });

  it("returns a hooks object with an event function for undefined, null, and directory inputs", async () => {
    const mod = await importCopiedPlugin();
    const factory = mod.AgentmemoryCapturePlugin as (input: unknown) => Promise<Record<string, unknown>>;

    for (const input of [undefined, null, { directory: tmpDir }]) {
      const hooks = await factory(input);
      expect(hooks).toBeTypeOf("object");
      expect(hooks).not.toBeNull();
      expect(hooks.event).toEqual(expect.any(Function));
    }
  });
});
