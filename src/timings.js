import { performance } from 'node:perf_hooks';

/**
 * Wall-clock phase timings.
 *
 * Collected on every run, not only with `--verbose`, so reports and audit
 * logs show which phase was slow. A phase that throws or is aborted (for
 * example by the scan budget) still records the time it consumed.
 */

export class PhaseTimer {
  constructor() {
    this.phases = new Map();
  }

  /**
   * Runs `fn` and adds its duration to `name`.
   * @template T
   * @param {string} name
   * @param {() => Promise<T>|T} fn
   * @returns {Promise<T>}
   */
  async measure(name, fn) {
    const started = performance.now();
    try {
      return await fn();
    } finally {
      this.record(name, performance.now() - started);
    }
  }

  record(name, ms) {
    const phase = this.phases.get(name) ?? { phase: name, ms: 0, count: 0 };
    phase.ms += ms;
    phase.count++;
    this.phases.set(name, phase);
  }

  /**
   * @returns {Array<{phase: string, ms: number, count: number}>} slowest first
   */
  toJSON() {
    return [...this.phases.values()]
      .map((phase) => ({ ...phase, ms: Math.round(phase.ms) }))
      .sort((a, b) => b.ms - a.ms);
  }
}

/**
 * Measures `fn` when `timer` exists, otherwise just runs it.
 */
export function timed(timer, name, fn) {
  return timer ? timer.measure(name, fn) : fn();
}
