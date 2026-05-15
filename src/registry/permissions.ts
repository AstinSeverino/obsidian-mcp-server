import { ToolError } from "./errors.js";

/**
 * Permission scoping for tools.
 *
 * - read         → safe, idempotent, no side-effects (search, graph queries)
 * - write        → mutates state but reversible (create/update notes)
 * - destructive  → irreversible or escalated risk (delete, archive)
 *
 * Server boundary check honors BRAIN_PERMISSION_MODE env:
 *   "all" (default) — allow everything
 *   "read-only"     — block write + destructive
 *   "no-destructive"— allow read + write, block destructive
 */

export type Permission = "read" | "write" | "destructive";

const RANK: Record<Permission, number> = {
  read: 0,
  write: 1,
  destructive: 2,
};

export type PermissionMode = "all" | "read-only" | "no-destructive";

export function getCurrentMode(): PermissionMode {
  const raw = (process.env.BRAIN_PERMISSION_MODE ?? "all").toLowerCase();
  if (raw === "read-only" || raw === "no-destructive" || raw === "all") {
    return raw;
  }
  return "all";
}

export function maxAllowed(mode: PermissionMode): number {
  switch (mode) {
    case "read-only":
      return RANK.read;
    case "no-destructive":
      return RANK.write;
    case "all":
    default:
      return RANK.destructive;
  }
}

export function assertPermission(
  required: Permission,
  mode: PermissionMode = getCurrentMode()
): void {
  if (RANK[required] > maxAllowed(mode)) {
    throw new ToolError(
      "PERMISSION_DENIED",
      `Tool requires '${required}' but server is in '${mode}' mode`
    );
  }
}
