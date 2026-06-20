import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveProject } from "../src/hooks/_project.js";
import { RESOLVER_SCENARIOS } from "./_fixtures/project-resolver-scenarios.js";

describe("resolveProject - hook project basename resolver", () => {
  const originalEnv = process.env.AGENTMEMORY_PROJECT_NAME;

  beforeEach(() => {
    delete process.env.AGENTMEMORY_PROJECT_NAME;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENTMEMORY_PROJECT_NAME;
    } else {
      process.env.AGENTMEMORY_PROJECT_NAME = originalEnv;
    }
  });

  it.each(RESOLVER_SCENARIOS)("$name", ({ setup }) => {
    const scenario = setup();
    if (scenario.envProjectName !== undefined) {
      process.env.AGENTMEMORY_PROJECT_NAME = scenario.envProjectName;
    }

    try {
      for (const cwdArg of scenario.hookCwdArgs) {
        expect(resolveProject(cwdArg)).toBe(scenario.expected);
      }
    } finally {
      scenario.cleanup?.();
    }
  });
});
