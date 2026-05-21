// Tiny per-process circuit breaker.
// State machine: CLOSED -> (fail threshold) -> OPEN -> (cooldown) -> HALF_OPEN -> (success) -> CLOSED
//                                                              \-> (fail) ----> OPEN
//
// Why per-process and not Redis-backed: each `web` pod is its own JVM-equivalent
// for upstream-failure detection. A shared breaker would let one bad pod open
// the breaker for the whole fleet; a per-pod breaker fails over correctly when
// the LB sends new traffic to a healthier pod.

type State = "closed" | "open" | "half_open";

export class CircuitOpenError extends Error {
  constructor(public readonly name_: string) {
    super(`circuit_open:${name_}`);
    this.name = "CircuitOpenError";
  }
}

export interface BreakerOptions {
  failureThreshold: number; // consecutive failures to open
  cooldownMs: number;       // time spent in OPEN before HALF_OPEN probe
}

export class CircuitBreaker {
  private state: State = "closed";
  private failures = 0;
  private openedAt = 0;

  constructor(
    public readonly name: string,
    private readonly opts: BreakerOptions = { failureThreshold: 5, cooldownMs: 30_000 }
  ) {}

  // Throws CircuitOpenError if the breaker is currently OPEN and cooldown hasn't elapsed.
  // Otherwise transitions to HALF_OPEN if cooldown elapsed, or stays CLOSED.
  precheck() {
    if (this.state === "open") {
      if (Date.now() - this.openedAt >= this.opts.cooldownMs) {
        this.state = "half_open";
      } else {
        throw new CircuitOpenError(this.name);
      }
    }
  }

  markSuccess() {
    this.failures = 0;
    this.state = "closed";
  }

  markFailure() {
    this.failures += 1;
    if (this.state === "half_open" || this.failures >= this.opts.failureThreshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.precheck();
    try {
      const result = await fn();
      this.markSuccess();
      return result;
    } catch (err) {
      this.markFailure();
      throw err;
    }
  }

  // For tests / introspection.
  inspect() {
    return { name: this.name, state: this.state, failures: this.failures };
  }
}

// Module-level singletons keyed by provider. Adapter callers grab one with
// `breakerFor(provider)` so all calls to a provider share state within a pod.
const breakers = new Map<string, CircuitBreaker>();
export function breakerFor(provider: string): CircuitBreaker {
  let b = breakers.get(provider);
  if (!b) {
    b = new CircuitBreaker(provider);
    breakers.set(provider, b);
  }
  return b;
}
