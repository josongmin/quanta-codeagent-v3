/**
 * Admin org-policy filesystem loader (ADR-0134 §3) — node:fs/promises adapter
 * for {@link AdminPolicyLoaderPort}.
 *
 * Closed-port separation (P1 cleanup): `admin-policy.ts` is the PURE decision
 * module (parse + validate + load orchestration) and MUST NOT import
 * `node:fs/promises` directly — DIP would have a domain module depending on a
 * concrete I/O substrate. The fs reader lives here; the domain module accepts
 * a port and the host wires the default via {@link createFsAdminPolicyLoader}.
 *
 * Mirrors the {@link nodeAuditWriter} pattern in `audit-log.ts`: the I/O
 * surface is the single side-effect seam, the domain stays pure-by-state.
 *
 * Backward compat: `loadAdminPolicy({ orgConfigDir })` (no `readPolicyFile`)
 * still works — `admin-policy.ts` falls back to {@link defaultAdminPolicyReader}
 * exported from this file. Tests continue to inject `readPolicyFile` directly;
 * production callers continue to omit it.
 */

import { readFile } from "node:fs/promises"

/**
 * One side-effect: read a file or return `null` on ENOENT. Other I/O errors
 * propagate so a host can surface (e.g. EACCES) rather than silently degrade
 * to "no policy".
 */
export type AdminPolicyReader = (path: string) => Promise<string | null>

/**
 * The default fs reader. Returns `null` on ENOENT (absent policy ⇒ admin scope
 * disabled), rethrows on other errors (EACCES / EIO must NOT silently degrade
 * — see ADR-0134 §3 "fail loudly").
 */
export const defaultAdminPolicyReader: AdminPolicyReader = async (path) => {
  try {
    return await readFile(path, "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
    throw e
  }
}

/**
 * Factory returning the production reader. Exists so a host that wires a
 * different fs adapter (e.g. an in-memory FS for desktop browser surface)
 * can substitute one and `admin-policy.ts` remains substrate-agnostic.
 *
 * The current implementation simply returns {@link defaultAdminPolicyReader}
 * — the factory shape is forward-compat for a future port that wants to
 * carry options (concurrency cap, signal, etc.).
 */
export const createFsAdminPolicyReader = (): AdminPolicyReader => defaultAdminPolicyReader
