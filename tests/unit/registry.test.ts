import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../../src/registry/registry.js";
import type { ToolDefinition } from "../../src/types.js";

function fakeTool(name: string): ToolDefinition {
  return {
    name,
    version: "1.0.0",
    description: `fake tool ${name}`,
    permission: "read",
    inputSchema: { x: z.string() },
    handler: async () => ({
      content: [{ type: "text", text: "ok" }],
    }),
  };
}

describe("ToolRegistry", () => {
  it("throws on duplicate registration", () => {
    const reg = new ToolRegistry();
    reg.register(fakeTool("brain.test.a"));
    expect(() => reg.register(fakeTool("brain.test.a"))).toThrow(
      /already registered/
    );
  });

  it("list() returns every registered tool", () => {
    const reg = new ToolRegistry();
    reg.registerMany([
      fakeTool("brain.test.a"),
      fakeTool("brain.test.b"),
      fakeTool("brain.test.c"),
    ]);
    expect(reg.count()).toBe(3);
    const names = reg.list().map((t) => t.name).sort();
    expect(names).toEqual(["brain.test.a", "brain.test.b", "brain.test.c"]);
  });
});
