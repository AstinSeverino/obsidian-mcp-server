import { describe, it, expect } from "vitest";
import { z } from "zod";
import { HookPipeline } from "../../src/registry/pipeline.js";
import { ToolError } from "../../src/registry/errors.js";
import { Logger } from "../../src/observability/logger.js";
import { ToolMetrics } from "../../src/observability/metrics.js";
import { IdempotencyCache } from "../../src/registry/idempotency.js";
import type { ToolDefinition } from "../../src/types.js";

function readTool(): ToolDefinition {
  return {
    name: "brain.test.read",
    version: "1.0.0",
    description: "test",
    permission: "read",
    inputSchema: { q: z.string() },
    handler: async ({ q }) => ({
      content: [{ type: "text", text: `got ${q}` }],
    }),
  };
}

describe("HookPipeline", () => {
  it("executes a successful tool and returns result with _meta", async () => {
    const pipeline = new HookPipeline({
      logger: new Logger({ test: true }),
      metrics: new ToolMetrics(),
      idempotencyCache: new IdempotencyCache(),
    });
    const result = await pipeline.execute(readTool(), { q: "hello" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("got hello");
    expect(result._meta).toMatchObject({
      version: "1.0.0",
      permission: "read",
    });
  });

  it("short-circuits with VALIDATION error on bad input", async () => {
    const pipeline = new HookPipeline();
    const result = await pipeline.execute(readTool(), { q: 123 });
    expect(result.isError).toBe(true);
    expect(result._meta?.code).toBe("VALIDATION");
  });

  it("wraps unknown errors as INTERNAL while preserving the message", async () => {
    const pipeline = new HookPipeline();
    const def: ToolDefinition = {
      ...readTool(),
      handler: async () => {
        throw new Error("boom in handler");
      },
    };
    const result = await pipeline.execute(def, { q: "x" });
    expect(result.isError).toBe(true);
    expect(result._meta?.code).toBe("INTERNAL");
    expect(result.content[0].text).toContain("boom in handler");
  });

  it("rejects destructive tool in read-only mode", async () => {
    const prev = process.env.BRAIN_PERMISSION_MODE;
    process.env.BRAIN_PERMISSION_MODE = "read-only";
    try {
      const pipeline = new HookPipeline();
      const destructive: ToolDefinition = {
        ...readTool(),
        permission: "destructive",
      };
      const result = await pipeline.execute(destructive, { q: "x" });
      expect(result.isError).toBe(true);
      expect(result._meta?.code).toBe("PERMISSION_DENIED");
    } finally {
      process.env.BRAIN_PERMISSION_MODE = prev;
    }
  });

  it("propagates ToolError codes from handlers (e.g. CONFLICT)", async () => {
    const pipeline = new HookPipeline();
    const def: ToolDefinition = {
      ...readTool(),
      handler: async () => {
        throw new ToolError("CONFLICT", "mtime mismatch");
      },
    };
    const result = await pipeline.execute(def, { q: "x" });
    expect(result.isError).toBe(true);
    expect(result._meta?.code).toBe("CONFLICT");
  });

  it("validateOutputHook rejects handler responses that violate outputSchema", async () => {
    const pipeline = new HookPipeline();
    const def: ToolDefinition = {
      ...readTool(),
      outputSchema: z.object({ value: z.number() }),
      handler: async () => ({
        content: [{ type: "text", text: "{}" }],
        structuredContent: { value: "not-a-number" as unknown as number },
      }),
    };
    const result = await pipeline.execute(def, { q: "x" });
    expect(result.isError).toBe(true);
    expect(result._meta?.code).toBe("INTERNAL");
  });

  it("validateOutputHook accepts a well-typed structuredContent", async () => {
    const pipeline = new HookPipeline();
    const def: ToolDefinition = {
      ...readTool(),
      outputSchema: z.object({ value: z.number() }),
      handler: async () => ({
        content: [{ type: "text", text: "{}" }],
        structuredContent: { value: 42 },
      }),
    };
    const result = await pipeline.execute(def, { q: "x" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ value: 42 });
  });
});
