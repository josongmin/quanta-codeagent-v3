/**
 * Admin org-policy loader (ADR-0134 §3) — closed-port enterprise enforcement.
 *
 * `<orgConfigDir>/org-policy.json` is the SSOT for admin-level skill policy:
 *   - `requiredSkills`: names the admin force-installs (users cannot disable)
 *   - `bannedSkills`: names users cannot register
 *   - `auditRequired`: when true, every admin install/remove + every blocked
 *     user attempt is appended to `<repo>/.quanta/audit/skill-install.log`
 *
 * Schema is strict (extra fields rejected) so a typo in the manifest never
 * silently weakens the policy. Absent org-policy.json ⇒ no admin policy
 * (admin scope is effectively disabled) — see ADR §3 "org policy 없으면
 * admin scope 비활성".
 *
 * Closed-port (P1 cleanup): this module is PURE — it takes a `readPolicyFile`
 * callback for the one side-effect (fs read). The default node:fs/promises
 * reader lives in {@link ./admin-policy-loader-fs} (`defaultAdminPolicyReader`)
 * and is lazy-imported so this domain module has NO direct dependency on
 * `node:fs/promises`. Unit tests inject a reader directly; production callers
 * omit it and `loadAdminPolicy` resolves the default via the adapter file.
 * Core logic ({@link parseAdminPolicy}, {@link validateAdminPolicy}) is pure.
 */

import { join } from "node:path"
import { z } from "zod"
import type { AdminPolicyReader } from "./admin-policy-loader-fs"

// Re-export the port type so callers can construct a typed reader without
// reaching into the adapter file directly (one canonical import surface).
export type { AdminPolicyReader } from "./admin-policy-loader-fs"

/** ADR-0134 §3 — admin org-policy.json schema. Strict mode (no extras). */
export const AdminPolicySchema = z
  .object({
    /** Skill names the admin force-installs (users cannot disable). */
    requiredSkills: z.array(z.string().min(1)).default([]),
    /** Skill names users cannot register under any scope. */
    bannedSkills: z.array(z.string().min(1)).default([]),
    /** When true, every admin event + blocked-user-attempt is audited. */
    auditRequired: z.boolean().default(false),
    /** Optional org identifier; surfaces in {@link Skill.adminInstalledBy}. */
    org: z.string().min(1).optional(),
  })
  .strict()
export type AdminPolicy = z.infer<typeof AdminPolicySchema>

/** Loaded policy + the source file path (or null if absent). */
export interface LoadedAdminPolicy {
  readonly policy: AdminPolicy | null
  readonly sourcePath: string | null
}

/**
 * Parse a raw policy JSON string. Returns a discriminated result so callers
 * can surface the parse error verbatim without try/catch noise.
 */
export const parseAdminPolicy = (
  raw: string,
): { ok: true; value: AdminPolicy } | { ok: false; error: string } => {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: `org-policy.json: invalid JSON (${(e as Error).message})` }
  }
  const parsed = AdminPolicySchema.safeParse(json)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const path = first?.path.join(".") || "<root>"
    return { ok: false, error: `org-policy.json: field '${path}': ${first?.message ?? "invalid"}` }
  }
  return { ok: true, value: parsed.data }
}

/** Cross-field invariant guard: a name cannot be both required AND banned. */
export const validateAdminPolicy = (
  p: AdminPolicy,
): { ok: true } | { ok: false; error: string } => {
  const req = new Set(p.requiredSkills)
  for (const b of p.bannedSkills) {
    if (req.has(b)) {
      return { ok: false, error: `skill '${b}' is in both requiredSkills and bannedSkills` }
    }
  }
  return { ok: true }
}

/**
 * Read + parse + validate the admin policy at `<orgConfigDir>/org-policy.json`.
 * Returns `policy: null` when the file is absent (admin scope effectively
 * disabled). Throws on JSON / schema / cross-field errors — a malformed
 * policy MUST fail loudly (silently degrading to "no policy" would weaken
 * enterprise guarantees the ADR explicitly designs against).
 */
export const loadAdminPolicy = async (opts: {
  orgConfigDir: string | null | undefined
  /**
   * Closed-port reader. Default resolves via `./admin-policy-loader-fs` (lazy-
   * imported so this domain module has no static node:fs/promises dependency).
   * Unit tests inject directly; production callers omit and get the fs adapter.
   */
  readPolicyFile?: AdminPolicyReader
}): Promise<LoadedAdminPolicy> => {
  if (opts.orgConfigDir === null || opts.orgConfigDir === undefined) {
    return { policy: null, sourcePath: null }
  }
  const path = join(opts.orgConfigDir, "org-policy.json")
  // Lazy-import the fs adapter ONLY when no reader was injected — keeps this
  // domain module's static graph free of node:fs/promises. The dynamic import
  // is cached by the module system after the first call, so subsequent loads
  // pay no additional cost (single Map lookup).
  const reader: AdminPolicyReader =
    opts.readPolicyFile ?? (await import("./admin-policy-loader-fs")).defaultAdminPolicyReader
  const raw = await reader(path)
  if (raw === null) return { policy: null, sourcePath: null }
  const parsed = parseAdminPolicy(raw)
  if (!parsed.ok) throw new Error(parsed.error)
  const checked = validateAdminPolicy(parsed.value)
  if (!checked.ok) throw new Error(`org-policy.json: ${checked.error}`)
  return { policy: parsed.value, sourcePath: path }
}
