/**
 * Idempotency cache for write operations.
 *
 * Pattern: clients pass an opaque `idempotencyKey` (UUID) alongside their
 * write payload. If the same (toolName, key) tuple is seen within TTL,
 * the original result is returned — the handler does not re-execute.
 *
 * This is local-only (in-memory LRU). For multi-instance production,
 * back it with Redis SETNX + EXPIRE — the API doesn't change.
 *
 * TTL defaults to 5 minutes, capacity 500 entries.
 */

import type { ToolResult } from "../types.js";

interface CacheEntry {
  result: ToolResult;
  expiresAt: number;
}

export class IdempotencyCache {
  private readonly cache = new Map<string, CacheEntry>();
  // In-flight promises for keys currently being executed. Two concurrent
  // calls with the same key will share the SAME promise — the handler runs
  // exactly once. This solves the race where two retries arrive in the same
  // tick and both miss the cache.
  private readonly inFlight = new Map<string, Promise<ToolResult>>();

  constructor(
    private readonly ttlMs: number = 5 * 60 * 1000,
    private readonly maxEntries: number = 500
  ) {}

  private compositeKey(toolName: string, key: string): string {
    return `${toolName}::${key}`;
  }

  /**
   * Returns cached result if present and unexpired. Otherwise:
   *   - If another call with the same key is in flight, await its result
   *     (deduplicated execution).
   *   - Else execute fn, cache the successful result, return it.
   *
   * Errors are NOT cached — failures may be retried.
   * `cached === true` means we returned a previously stored or in-flight result.
   */
  async wrap(
    toolName: string,
    key: string,
    fn: () => Promise<ToolResult>
  ): Promise<{ result: ToolResult; cached: boolean }> {
    const composite = this.compositeKey(toolName, key);

    // 1. Already-completed cached result?
    const hit = this.cache.get(composite);
    if (hit && hit.expiresAt > Date.now()) {
      return { result: hit.result, cached: true };
    }

    // 2. Concurrent in-flight call with the same key? Await it.
    const inFlight = this.inFlight.get(composite);
    if (inFlight) {
      const result = await inFlight;
      return { result, cached: true };
    }

    // 3. Fresh execution — register in-flight, run, then promote to cache.
    const promise = (async (): Promise<ToolResult> => {
      const result = await fn();
      if (!result.isError) {
        this.cache.set(composite, {
          result,
          expiresAt: Date.now() + this.ttlMs,
        });
        this.evictIfNeeded();
      }
      return result;
    })();

    this.inFlight.set(composite, promise);
    try {
      const result = await promise;
      return { result, cached: false };
    } finally {
      this.inFlight.delete(composite);
    }
  }

  private evictIfNeeded(): void {
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** For tests: clear all entries */
  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  size(): number {
    return this.cache.size;
  }

  inFlightSize(): number {
    return this.inFlight.size;
  }
}
