import type { MemoryProvider, CircuitBreakerState } from "../types.js";
import { logger } from "../logger.js";
import { CircuitBreaker } from "./circuit-breaker.js";

const LLM_CONCURRENCY_DEFAULT = 1;
const BREAKER_POLL_MS_DEFAULT = 1_000;

type Release = () => void;

function readPositiveInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ResilientProvider implements MemoryProvider {
  private breaker = new CircuitBreaker();
  private inFlight = 0;
  private waiters: Array<(release: Release) => void> = [];
  private readonly concurrency = readPositiveInt(
    "AGENTMEMORY_LLM_CONCURRENCY",
    LLM_CONCURRENCY_DEFAULT,
  );
  private readonly breakerPollMs = readPositiveInt(
    "AGENTMEMORY_CIRCUIT_BREAKER_POLL_MS",
    BREAKER_POLL_MS_DEFAULT,
  );
  name: string;

  constructor(private inner: MemoryProvider) {
    this.name = `resilient(${inner.name})`;
  }

  private async acquire(): Promise<Release> {
    if (this.inFlight < this.concurrency) {
      this.inFlight += 1;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(() => this.release());
      return;
    }
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  private async waitForBreaker(): Promise<void> {
    let logged = false;
    while (!this.breaker.isAllowed) {
      if (!logged) {
        logger.warn("LLM provider circuit breaker open, waiting for recovery", {
          provider: this.name,
          state: this.breaker.getState(),
          queued: this.waiters.length,
        });
        logged = true;
      }
      await sleep(this.breakerPollMs);
    }
  }

  private async call(fn: () => Promise<string>): Promise<string> {
    const release = await this.acquire();
    try {
      await this.waitForBreaker();
      try {
        const result = await fn();
        this.breaker.recordSuccess();
        return result;
      } catch (err) {
        this.breaker.recordFailure();
        throw err;
      }
    } finally {
      release();
    }
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(() => this.inner.compress(systemPrompt, userPrompt));
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(() => this.inner.summarize(systemPrompt, userPrompt));
  }

  get circuitState(): CircuitBreakerState {
    return this.breaker.getState();
  }
}
