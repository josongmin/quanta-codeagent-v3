/**
 * Track A2 — named permission-profile registry (ADR-0135 follow-up).
 *
 * The envelope carries a closed name enum
 * (`PermissionProfileSchema = "default" | "trusted" | "restricted" | "custom"`)
 * but there was NO registry mapping a name → concrete {@link PermissionProfile}
 * struct. This file is that single source of truth.
 *
 *   - `default`    — the canonical {@link DEFAULT_PERMISSION_PROFILE} (locked-
 *                    down: restricted FS, deny-all network, no OS sandbox,
 *                    read-only). The struct an unconfigured envelope decode
 *                    produces.
 *   - `restricted` — STRICTER than default: audit forced ON + always-confirm
 *                    approval (a profile an operator hands to an untrusted
 *                    context). Network stays deny-all.
 *   - `trusted`    — most permissive of the three NAMED profiles: workspace FS
 *                    write granted, network allow-all, approval auto (no
 *                    prompt). For a fully-trusted local operator session.
 *   - `custom`     — NOT in the registry: the caller supplies the struct
 *                    directly (the name is just a label on a bespoke struct).
 *
 * Escalation (least → most permission): `restricted` < `default` < `trusted`.
 *
 * Slice rules: leaf — depends ONLY on the pure types/consts in
 * `permission-profile.ts`. No IO, no state. Frozen literals (defense against
 * accidental mutation of a shared registry entry).
 */

import type { FileSystemEntry, PermissionProfile } from "./permission-profile"
import { DEFAULT_PERMISSION_PROFILE } from "./permission-profile"

/** The three names that resolve to a concrete registry struct. `custom` is
 *  intentionally EXCLUDED — it denotes a caller-supplied bespoke struct, not a
 *  registry entry. Mirror of the resolvable subset of
 *  `PermissionProfileSchema` (envelope). */
export type NamedProfileName = "default" | "trusted" | "restricted"

/** Runtime tuple of the resolvable names — used for exhaustive enumeration in
 *  tests + the `isNamedProfileName` guard without re-declaring the union. */
export const NAMED_PROFILE_NAMES = [
  "default",
  "trusted",
  "restricted",
] as const satisfies ReadonlyArray<NamedProfileName>

/** `restricted` — strictest named profile. Inherits the locked-down default
 *  FS / network / sandbox, then HARDENS the control + approval pillars:
 *  audit is forced and every borderline action is always confirmed. */
const RESTRICTED_PROFILE: PermissionProfile = Object.freeze({
  fileSystem: Object.freeze({
    type: "restricted" as const,
    entries: Object.freeze([] as ReadonlyArray<FileSystemEntry>),
  }),
  approval: Object.freeze({ mode: "always" as const, promptUser: true }),
  network: Object.freeze({ mode: "deny-all" as const }),
  sandbox: Object.freeze({
    osSandbox: "none" as const,
    readOnly: true,
    workspaceWrite: false,
    networkIsolated: true,
  }),
  control: Object.freeze({ managedBy: "admin" as const, auditRequired: true }),
}) as PermissionProfile

/** `trusted` — most permissive named profile. Workspace FS write, network
 *  allow-all, auto approval (no prompt). For a fully-trusted local session. */
const TRUSTED_PROFILE: PermissionProfile = Object.freeze({
  fileSystem: Object.freeze({
    type: "restricted" as const,
    entries: Object.freeze([
      { path: { type: "special" as const, kind: "project" as const }, access: "write" as const },
    ] as ReadonlyArray<FileSystemEntry>),
  }),
  approval: Object.freeze({ mode: "auto" as const, promptUser: false }),
  network: Object.freeze({ mode: "allow-all" as const }),
  sandbox: Object.freeze({
    osSandbox: "none" as const,
    readOnly: false,
    workspaceWrite: true,
    networkIsolated: false,
  }),
  control: Object.freeze({ managedBy: "user" as const, auditRequired: false }),
}) as PermissionProfile

/** Closed name → concrete struct registry. `custom` is not a key (it denotes a
 *  caller-supplied struct). Frozen so a consumer cannot mutate a shared entry. */
export const NAMED_PROFILES: Readonly<Record<NamedProfileName, PermissionProfile>> = Object.freeze({
  default: DEFAULT_PERMISSION_PROFILE,
  restricted: RESTRICTED_PROFILE,
  trusted: TRUSTED_PROFILE,
})

/** Type guard — narrows an arbitrary string to a resolvable
 *  {@link NamedProfileName}. Used at the JSON parse boundary (envelope decode)
 *  so an unknown / `custom` name is handled explicitly by the caller. */
export const isNamedProfileName = (s: string): s is NamedProfileName =>
  s === "default" || s === "restricted" || s === "trusted"

/** Resolve a NAMED profile to its concrete struct. THROWS on an unresolvable
 *  name (`custom` or any unknown string) — `custom` profiles are supplied as a
 *  struct, never resolved through the registry, so a name lookup for them is a
 *  programmer error the caller must handle before calling. */
export const resolveProfileByName = (name: string): PermissionProfile => {
  if (!isNamedProfileName(name)) {
    throw new Error(
      `unknown permission profile name '${name}'. ` +
        `resolvable names: ${NAMED_PROFILE_NAMES.join(", ")} ` +
        `(use a struct for 'custom').`,
    )
  }
  return NAMED_PROFILES[name]
}

/**
 * Track A2 — `default_permissions` decode bridge. The session envelope's
 * `permission_profile` field decodes to EITHER a name string (legacy enum
 * vocabulary) OR a concrete struct (v2 extended model). This collapses that
 * union to a concrete {@link PermissionProfile} the runtime gate consumes:
 *
 *   - a struct  ⇒ returned verbatim (the wire form IS the struct).
 *   - `"custom"` ⇒ {@link DEFAULT_PERMISSION_PROFILE} (a `custom` LABEL with no
 *                  struct on the wire has no bespoke definition to resolve, so
 *                  the safest concrete fallback is the locked-down default).
 *   - any other resolvable name ⇒ the registry struct.
 *   - an unknown name string ⇒ THROWS (fail-closed at the parse boundary —
 *                  a typo'd profile name must not silently fall back to a
 *                  permissive struct).
 *
 * Structural parameter (`string | PermissionProfile`) — NOT the envelope's
 * branded `PermissionProfileField` type — so this leaf keeps zero `@/session`
 * dependency (the decoder passes the already-decoded value).
 */
export const resolvePermissionProfileField = (
  field: string | PermissionProfile,
): PermissionProfile => {
  if (typeof field !== "string") return field
  if (field === "custom") return DEFAULT_PERMISSION_PROFILE
  return resolveProfileByName(field)
}
