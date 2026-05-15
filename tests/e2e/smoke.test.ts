import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let vaultRoot: string;
let server: ChildProcessWithoutNullStreams;
const responses: Record<number, unknown> = {};
let buffer = "";

function send(req: object): void {
  server.stdin.write(JSON.stringify(req) + "\n");
}

function waitForResponse(id: number, timeoutMs = 8000): Promise<unknown> {
  const start = Date.now();
  return new Promise((res, rej) => {
    const check = (): void => {
      if (responses[id] !== undefined) {
        res(responses[id]);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        rej(new Error(`Timeout waiting for response id=${id}`));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

beforeAll(async () => {
  vaultRoot = mkdtempSync(join(tmpdir(), "brain-e2e-"));
  mkdirSync(join(vaultRoot, "Notes"), { recursive: true });
  writeFileSync(
    join(vaultRoot, "Notes", "seed.md"),
    "# Seed\nFixture note.\n",
    "utf8"
  );

  const binary = resolve(__dirname, "..", "..", "build", "index.js");
  server = spawn("node", [binary], {
    env: { ...process.env, VAULT_PATH: vaultRoot, BRAIN_LOG_LEVEL: "warn" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  server.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let i;
    while ((i = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (typeof obj.id === "number") responses[obj.id] = obj;
      } catch {
        // ignore non-JSON lines
      }
    }
  });

  // Initialize MCP handshake
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest-smoke", version: "1.0.0" },
    },
  });
  await waitForResponse(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
});

afterAll(() => {
  if (server && !server.killed) server.kill("SIGTERM");
  rmSync(vaultRoot, { recursive: true, force: true });
});

describe("e2e: spawn server, list tools, call one", () => {
  it("lists 24 tools including namespaced and deprecated aliases", async () => {
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const resp = (await waitForResponse(2)) as {
      result: { tools: Array<{ name: string; _meta?: Record<string, unknown> }> };
    };
    expect(resp.result.tools).toHaveLength(24);

    const namespaced = resp.result.tools.filter((t) =>
      t.name.startsWith("brain.")
    );
    const legacy = resp.result.tools.filter((t) => !t.name.startsWith("brain."));
    expect(namespaced).toHaveLength(12);
    expect(legacy).toHaveLength(12);

    // Spot-check: read_note must be marked deprecated.
    const readNote = legacy.find((t) => t.name === "read_note");
    expect(readNote).toBeDefined();
    expect(
      (readNote!._meta as { deprecated?: unknown } | undefined)?.deprecated
    ).toBeDefined();
  });

  it("exposes a Resource (brain://stats) via resources/list", async () => {
    send({ jsonrpc: "2.0", id: 3, method: "resources/list" });
    const resp = (await waitForResponse(3)) as {
      result: { resources: Array<{ uri: string }> };
    };
    expect(resp.result.resources.map((r) => r.uri)).toContain("brain://stats");
  });

  it("exposes a Prompt (summarize-note-tree) via prompts/list", async () => {
    send({ jsonrpc: "2.0", id: 4, method: "prompts/list" });
    const resp = (await waitForResponse(4)) as {
      result: { prompts: Array<{ name: string }> };
    };
    expect(resp.result.prompts.map((p) => p.name)).toContain(
      "summarize-note-tree"
    );
  });
});
