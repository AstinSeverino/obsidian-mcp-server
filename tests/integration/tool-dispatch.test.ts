import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../../src/core/vault.js";
import { createCrudTools } from "../../src/tools/crud.js";
import { createDeprecatedAliases } from "../../src/tools/deprecated.js";
import { ToolRegistry } from "../../src/registry/registry.js";
import { HookPipeline } from "../../src/registry/pipeline.js";

let vaultRoot: string;
let registry: ToolRegistry;
let pipeline: HookPipeline;

beforeAll(() => {
  vaultRoot = mkdtempSync(join(tmpdir(), "brain-int-"));
  mkdirSync(join(vaultRoot, "Notes"), { recursive: true });
  writeFileSync(
    join(vaultRoot, "Notes", "alpha.md"),
    "---\ntitle: Alpha\n---\n\n# Alpha\nThis is a test note linking to [[beta]].\n",
    "utf8"
  );

  const vault = new Vault(vaultRoot);
  registry = new ToolRegistry();
  const tools = createCrudTools(vault);
  registry.registerMany(tools);
  registry.registerMany(createDeprecatedAliases(tools));
  pipeline = new HookPipeline();
});

afterAll(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

describe("Registry + pipeline end-to-end", () => {
  it("dispatches brain.notes.read and returns parsed frontmatter + links", async () => {
    const def = registry.get("brain.notes.read");
    expect(def).toBeDefined();
    const result = await pipeline.execute(def!, { path: "Notes/alpha.md" });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.title).toBe("Alpha");
    expect(body.links).toContain("beta");
    expect(result._meta?.version).toBe("1.0.0");
  });

  it("legacy alias read_note returns the same payload + _meta.deprecated", async () => {
    const def = registry.get("read_note");
    expect(def).toBeDefined();
    const result = await pipeline.execute(def!, { path: "Notes/alpha.md" });
    expect(result.isError).toBeFalsy();
    expect(result._meta?.deprecated).toMatchObject({
      since: "1.1.0",
      replacement: "brain.notes.read",
    });
  });

  it("registers exactly 10 tools (5 namespaced + 5 legacy aliases for CRUD)", () => {
    expect(registry.count()).toBe(10);
  });
});
