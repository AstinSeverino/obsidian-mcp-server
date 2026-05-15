import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validatePath,
  validateExtension,
  sanitizeFrontmatter,
} from "../../src/core/security.js";

let vaultRoot: string;

beforeAll(() => {
  vaultRoot = mkdtempSync(join(tmpdir(), "brain-sec-"));
  mkdirSync(join(vaultRoot, "Notes"), { recursive: true });
  writeFileSync(join(vaultRoot, "Notes", "ok.md"), "# ok\n", "utf8");
});

afterAll(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

describe("validatePath", () => {
  it("blocks path traversal with ../../etc/passwd", () => {
    expect(() => validatePath("../../../etc/passwd", vaultRoot)).toThrow(
      /Path traversal blocked/
    );
  });

  it("blocks absolute path outside the vault", () => {
    expect(() => validatePath("/etc/passwd", vaultRoot)).toThrow(
      /Path traversal blocked/
    );
  });

  it("allows a valid nested path inside the vault", () => {
    expect(() => validatePath("Notes/ok.md", vaultRoot)).not.toThrow();
  });
});

describe("validateExtension", () => {
  it("blocks .exe files", () => {
    expect(() => validateExtension("evil.exe")).toThrow(/not allowed/);
  });

  it("blocks .sh files", () => {
    expect(() => validateExtension("payload.sh")).toThrow(/not allowed/);
  });

  it("allows .md files", () => {
    expect(() => validateExtension("note.md")).not.toThrow();
  });
});

describe("sanitizeFrontmatter", () => {
  it("strips __proto__ pollution attempts", () => {
    // Use a raw object built with Object.defineProperty so __proto__ is
    // an own enumerable key (matching what a malicious YAML parser would emit).
    const dirty = Object.create(null) as Record<string, unknown>;
    dirty.title = "ok";
    Object.defineProperty(dirty, "__proto__", {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
    });
    const clean = sanitizeFrontmatter(dirty);
    expect(Object.prototype.hasOwnProperty.call(clean, "__proto__")).toBe(false);
    expect(clean.title).toBe("ok");
  });

  it("strips function values", () => {
    const clean = sanitizeFrontmatter({
      title: "ok",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: (() => "evil") as any,
    });
    expect("handler" in clean).toBe(false);
  });
});
