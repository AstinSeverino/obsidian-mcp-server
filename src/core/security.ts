import path from "node:path";
import fs from "node:fs";

const ALLOWED_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".canvas"]);

const DANGEROUS_FRONTMATTER_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
]);

export function validatePath(filePath: string, vaultRoot: string): string {
  const resolved = path.resolve(vaultRoot, filePath);

  if (!isWithinVault(resolved, vaultRoot)) {
    throw new Error(
      `Path traversal blocked: "${filePath}" resolves outside vault`
    );
  }

  return resolved;
}

export function isWithinVault(resolvedPath: string, vaultRoot: string): boolean {
  const normalizedVault = path.resolve(vaultRoot) + path.sep;
  const normalizedPath = path.resolve(resolvedPath);

  if (
    normalizedPath !== path.resolve(vaultRoot) &&
    !normalizedPath.startsWith(normalizedVault)
  ) {
    return false;
  }

  try {
    const realPath = fs.realpathSync(resolvedPath);
    const realVault = fs.realpathSync(vaultRoot);

    if (realPath === realVault) return true;

    if (!realPath.startsWith(realVault + path.sep)) {
      const symlinkTargets = getAllowedSymlinkTargets(vaultRoot);
      return symlinkTargets.some(
        (target) =>
          realPath === target || realPath.startsWith(target + path.sep)
      );
    }

    return true;
  } catch {
    return normalizedPath.startsWith(normalizedVault);
  }
}

function getAllowedSymlinkTargets(vaultRoot: string): string[] {
  const projectsDir = path.join(vaultRoot, "Projects");
  const targets: string[] = [];

  try {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        const linkPath = path.join(projectsDir, entry.name);
        try {
          targets.push(fs.realpathSync(linkPath));
        } catch {
          // broken symlink
        }
      }
    }
  } catch {
    // Projects dir doesn't exist yet
  }

  return targets;
}

export function validateExtension(filePath: string): void {
  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Extension "${ext}" not allowed. Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}`
    );
  }
}

export function sanitizeFrontmatter(
  data: Record<string, unknown>
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (DANGEROUS_FRONTMATTER_KEYS.has(key)) {
      continue;
    }
    if (typeof value === "function") {
      continue;
    }
    clean[key] = value;
  }

  return clean;
}
