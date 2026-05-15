import { describe, it, expect } from "vitest";
import { z } from "zod";
import { HookPipeline } from "../../src/registry/pipeline.js";
import { IdempotencyCache } from "../../src/registry/idempotency.js";
import { Logger } from "../../src/observability/logger.js";
import { ToolMetrics } from "../../src/observability/metrics.js";
import type { ToolDefinition } from "../../src/types.js";

describe("IdempotencyCache + pipeline integration", () => {
  it("second call within TTL returns the cached result without re-running the handler", async () => {
    let calls = 0;
    const def: ToolDefinition = {
      name: "brain.test.write",
      version: "1.0.0",
      description: "test",
      permission: "write",
      idempotent: true,
      inputSchema: {
        payload: z.string(),
        idempotencyKey: z.string().optional(),
      },
      handler: async ({ payload }) => {
        calls++;
        return {
          content: [{ type: "text", text: `wrote:${payload}:call#${calls}` }],
        };
      },
    };

    const pipeline = new HookPipeline({
      logger: new Logger({ test: true }),
      metrics: new ToolMetrics(),
      idempotencyCache: new IdempotencyCache(60_000, 100),
    });

    const args = { payload: "abc", idempotencyKey: "uuid-1" };
    const r1 = await pipeline.execute(def, args);
    const r2 = await pipeline.execute(def, args);

    expect(calls).toBe(1);
    expect(r1.content[0].text).toBe("wrote:abc:call#1");
    expect(r2.content[0].text).toBe("wrote:abc:call#1");
    expect(r2._meta?.idempotencyHit).toBe(true);
  });

  it("concurrent calls with the same key share a single execution", async () => {
    let calls = 0;
    const def: ToolDefinition = {
      name: "brain.test.concurrent",
      version: "1.0.0",
      description: "test",
      permission: "write",
      idempotent: true,
      inputSchema: {
        payload: z.string(),
        idempotencyKey: z.string().optional(),
      },
      handler: async ({ payload }) => {
        calls++;
        // Simulate latency so the second call arrives while the first
        // is still in flight.
        await new Promise((res) => setTimeout(res, 50));
        return {
          content: [{ type: "text", text: `wrote:${payload}` }],
        };
      },
    };

    const pipeline = new HookPipeline();
    const args = { payload: "race", idempotencyKey: "race-key" };
    const [r1, r2] = await Promise.all([
      pipeline.execute(def, args),
      pipeline.execute(def, args),
    ]);

    expect(calls).toBe(1);
    expect(r1.content[0].text).toBe("wrote:race");
    expect(r2.content[0].text).toBe("wrote:race");
    // The second concurrent call is also a "cached" hit (in-flight dedup).
    expect(r2._meta?.idempotencyHit).toBe(true);
  });

  it("different idempotency keys execute independently", async () => {
    let calls = 0;
    const def: ToolDefinition = {
      name: "brain.test.write2",
      version: "1.0.0",
      description: "test",
      permission: "write",
      idempotent: true,
      inputSchema: {
        payload: z.string(),
        idempotencyKey: z.string().optional(),
      },
      handler: async ({ payload }) => {
        calls++;
        return {
          content: [{ type: "text", text: `wrote:${payload}` }],
        };
      },
    };

    const pipeline = new HookPipeline();
    await pipeline.execute(def, { payload: "a", idempotencyKey: "key-1" });
    await pipeline.execute(def, { payload: "b", idempotencyKey: "key-2" });
    expect(calls).toBe(2);
  });
});
