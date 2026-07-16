import type { MemoryProvider, CircuitBreakerState } from "../types.js";
import { logger } from "../logger.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { getEnvVar } from "../config.js";

const LLM_CONCURRENCY_DEFAULT = 1;
const BREAKER_POLL_MS_DEFAULT = 1_000;
const LLM_TIMEOUT_MS_DEFAULT = 60_000;
const MAX_TIMER_MS = 2_147_483_647;

type Release = () => void;
type Waiter = {
  resolve: (release: Release) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function readPositiveInt(key: string, fallback: number): number {
  const raw = getEnvVar(key);
  if (!raw) return fallback;
  const value = Number(raw);
  return /^[1-9]\d*$/.test(raw.trim()) &&
    Number.isSafeInteger(value) &&
    value <= MAX_TIMER_MS
    ? value
    : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ResilientProvider implements MemoryProvider {
  private breaker = new CircuitBreaker();
  private inFlight = 0;
  private waiters: Waiter[] = [];
  private readonly concurrency = readPositiveInt(
    "AGENTMEMORY_LLM_CONCURRENCY",
    LLM_CONCURRENCY_DEFAULT,
  );
  private readonly breakerPollMs = readPositiveInt(
    "AGENTMEMORY_CIRCUIT_BREAKER_POLL_MS",
    BREAKER_POLL_MS_DEFAULT,
  );
  private readonly maxBreakerWaitMs = readPositiveInt(
    "AGENTMEMORY_LLM_TIMEOUT_MS",
    LLM_TIMEOUT_MS_DEFAULT,
  );
  name: string;

  constructor(private inner: MemoryProvider) {
    this.name = `resilient(${inner.name})`;
  }

  private async acquire(deadline: number): Promise<Release> {
    if (this.inFlight < this.concurrency) {
      this.inFlight += 1;
      return () => this.release();
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw this.timeoutError();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(this.timeoutError());
        }, remaining),
      } satisfies Waiter;
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(() => this.release());
      return;
    }
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  private timeoutError(): Error {
    return new Error(
      `LLM call exceeded ${this.maxBreakerWaitMs}ms total timeout (set AGENTMEMORY_LLM_TIMEOUT_MS to raise the bound)`,
    );
  }

  private async waitForBreaker(deadline: number): Promise<void> {
    let logged = false;
    while (!this.breaker.tryAcquire()) {
      if (!logged) {
        logger.warn("LLM provider circuit breaker open, waiting for recovery", {
          provider: this.name,
          state: this.breaker.getState(),
          queued: this.waiters.length,
          maxWaitMs: this.maxBreakerWaitMs,
        });
        logged = true;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `LLM circuit breaker open longer than ${this.maxBreakerWaitMs}ms, failing fast (set AGENTMEMORY_LLM_TIMEOUT_MS to raise the bound)`,
        );
      }
      await sleep(Math.min(this.breakerPollMs, remaining));
    }
  }

  private async call(fn: () => Promise<string>): Promise<string> {
    const deadline = Date.now() + this.maxBreakerWaitMs;
    const release = await this.acquire(deadline);
    try {
      await this.waitForBreaker(deadline);
    } catch (error) {
      release();
      throw error;
    }

    const execution = fn().then(
      (result) => {
        this.breaker.recordSuccess();
        return result;
      },
      (error) => {
        this.breaker.recordFailure();
        throw error;
      },
    ).finally(release);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw this.timeoutError();
    let timeout: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(this.timeoutError()), remaining);
    });
    return Promise.race([execution, timedOut]).finally(() => {
      clearTimeout(timeout);
    });
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
