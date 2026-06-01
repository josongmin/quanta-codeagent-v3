/**
 * ADR-0434 — PermissionProfile List + Select + user-defined profiles from disk.
 *
 * Codex `PermissionProfile{List/Select/Apply/Resolve}` absorption. The existing
 * `named-profiles.ts` registry already provides:
 *   - Resolve — `resolveProfileByName(name)` (built-in name → frozen struct)
 *   - Apply   — `TwoLayerManager.setPermissionProfileByName(threadId, name)`
 *
 * This leaf adds the two missing verbs PLUS user-defined named profiles:
 *   - List   — {@link listPermissionProfiles}: enumerate built-ins + any
 *              user-defined profiles discovered under a profiles dir.
 *   - Select — {@link selectPermissionProfile}: resolve a name (built-in OR
 *              user) → a concrete {@link PermissionProfile}, composing the
 *              registry Resolve with disk loading.
 *
 * User-defined profiles
 * ---------------------
 * Discovered as `<name>.json` files under a profiles dir (default:
 * `QUANTA_PROFILES_DIR`). Each file is validated by a STRICT structural
 * validator ({@link parseUserProfile}) — malformed JSON / a missing pillar /
 * a bogus enum value is REJECTED (never partially applied, never crashes).
 *
 * Safety ceiling
 * --------------
 * A user profile may NOT be more permissive than the most-permissive BUILT-IN
 * (`trusted`) on any security-relevant axis (network egress, OS sandbox / FS
 * write exposure, prompt suppression, audit relaxation). Such a profile is
 * rejected with a {@link ProfileValidationError} UNLESS the caller passes
 * `allowWiden: true` (an explicit operator opt-in). See {@link exceedsCeiling}.
 *
 * Built-in precedence
 * -------------------
 * A built-in name is authoritative: a user file named `trusted.json` CANNOT
 * shadow the `trusted` built-in. List de-dupes in favor of the built-in.
 *
 * Default-OFF
 * -----------
 * Absent `profilesDir` (and absent `QUANTA_PROFILES_DIR`) ⇒ only built-ins are
 * returned, byte-identical to a bare {@link NAMED_PROFILES} enumeration. No
 * disk IO is attempted.
 *
 * Slice rules: leaf-ish — depends on the pure permission types + the
 * `named-profiles` registry + `node:fs/promises` (disk loading only). No
 * permission-store / gate coupling.
 */

import { readdir, readFile } from "node:fs/promises"
import { extname, join } from "node:path"
import {
  isNamedProfileName,
  NAMED_PROFILE_NAMES,
  NAMED_PROFILES,
  resolveProfileByName,
} from "./named-profiles"
import type {
  ApprovalMode,
  ControlManagedBy,
  FileSystemAccess,
  FileSystemEntry,
  FileSystemPath,
  FileSystemPolicyType,
  NetworkMode,
  OsSandboxKind,
  PermissionProfile,
  SpecialPathKind,
} from "./permission-profile"
import { isSpecialPathKind } from "./permission-profile"

/* ------------------------------------------------------------------------- */
/* Typed errors                                                               */
/* ------------------------------------------------------------------------- */

/** Thrown by {@link selectPermissionProfile} when a name resolves to neither a
 *  built-in nor a (valid, in-ceiling) user profile. Carries the name so the
 *  caller can surface a precise message — NOT a permissive fallback. */
export class ProfileSelectError extends Error {
  override readonly name = "ProfileSelectError"
  constructor(
    readonly profileName: string,
    readonly available: ReadonlyArray<string>,
  ) {
    super(
      `unknown permission profile '${profileName}'. ` +
        `available: ${available.join(", ") || "(none)"}.`,
    )
  }
}

/** Thrown when a user profile file is malformed (bad JSON / wrong shape / bad
 *  enum) OR exceeds the safety ceiling without `allowWiden`. Distinct from
 *  {@link ProfileSelectError} so callers can tell "no such name" from "the
 *  file exists but is not admissible". */
export class ProfileValidationError extends Error {
  override readonly name = "ProfileValidationError"
  constructor(
    readonly file: string,
    readonly detail: string,
  ) {
    super(`invalid user permission profile '${file}': ${detail}`)
  }
}

/* ------------------------------------------------------------------------- */
/* Public surface                                                             */
/* ------------------------------------------------------------------------- */

/** One row of the {@link listPermissionProfiles} enumeration. */
export interface ProfileListEntry {
  /** The selectable name (the built-in name, or the user file basename). */
  readonly name: string
  /** Provenance — `builtin` always wins a name collision with `user`. */
  readonly source: "builtin" | "user"
  /** One-line human summary (network / approval / sandbox posture). */
  readonly summary: string
}

/** Behavior when a user profile file fails to load / validate during a List.
 *  - `skip`  (default) — drop the offending file; valid siblings + built-ins
 *                        still return. Resilient enumeration.
 *  - `throw`           — surface a {@link ProfileValidationError} on the first
 *                        bad file. Used by callers that want strict loading. */
export type ProfileLoadErrorMode = "skip" | "throw"

export interface ListProfilesOptions {
  /** Directory of `<name>.json` user profiles. Absent ⇒ env
   *  `QUANTA_PROFILES_DIR`; absent there too ⇒ built-ins only (no disk IO). */
  readonly profilesDir?: string
  /** Per-file error handling. Default `skip`. */
  readonly onError?: ProfileLoadErrorMode
  /** Admit user profiles wider than the `trusted` built-in. Default `false`
   *  (in-ceiling only). See {@link exceedsCeiling}. */
  readonly allowWiden?: boolean
  /** Test/DI seam — env source. Defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>
}

export interface SelectProfileOptions {
  readonly profilesDir?: string
  readonly allowWiden?: boolean
  readonly env?: Record<string, string | undefined>
}

/** Resolve the effective profiles dir: explicit option wins, else
 *  `QUANTA_PROFILES_DIR`, else `undefined` (built-ins only — default-OFF). */
const resolveProfilesDir = (
  explicit: string | undefined,
  env: Record<string, string | undefined>,
): string | undefined => {
  if (explicit !== undefined && explicit.length > 0) return explicit
  const fromEnv = env.QUANTA_PROFILES_DIR
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return undefined
}

/** One-line posture summary for a profile (List `summary` column). */
const summarize = (p: PermissionProfile): string =>
  `net=${p.network.mode} approval=${p.approval.mode} ` +
  `fs=${p.fileSystem.type}(${p.fileSystem.entries.length}) ` +
  `sandbox=${p.sandbox.osSandbox}/${p.sandbox.readOnly ? "ro" : "rw"}` +
  `${p.sandbox.workspaceWrite ? "+wsw" : ""}`

const BUILTIN_ENTRIES: ReadonlyArray<ProfileListEntry> = NAMED_PROFILE_NAMES.map((name) => ({
  name,
  source: "builtin" as const,
  summary: summarize(NAMED_PROFILES[name]),
}))

/**
 * List — enumerate built-in profiles + (optionally) user-defined profiles.
 *
 * Built-ins are always present and authoritative. User profiles are loaded
 * from `profilesDir` (or `QUANTA_PROFILES_DIR`); a user file whose basename
 * collides with a built-in is DROPPED (the built-in wins). A user profile that
 * fails to load / validate is handled per `onError` (default `skip`). A user
 * profile wider than the ceiling is dropped unless `allowWiden`.
 */
export const listPermissionProfiles = async (
  opts: ListProfilesOptions = {},
): Promise<ReadonlyArray<ProfileListEntry>> => {
  const env = opts.env ?? process.env
  const dir = resolveProfilesDir(opts.profilesDir, env)
  if (dir === undefined) return BUILTIN_ENTRIES

  const onError = opts.onError ?? "skip"
  const allowWiden = opts.allowWiden ?? false
  const userEntries: ProfileListEntry[] = []

  for (const { name, file } of await listUserProfileFiles(dir)) {
    // A built-in name is authoritative — never let a user file shadow it.
    if (isNamedProfileName(name)) {
      if (onError === "throw") {
        throw new ProfileValidationError(file, `name '${name}' collides with a built-in profile`)
      }
      continue
    }
    let profile: PermissionProfile
    try {
      profile = await loadAndValidate(file, allowWiden)
    } catch (err) {
      if (onError === "throw") throw err
      continue
    }
    userEntries.push({ name, source: "user", summary: summarize(profile) })
  }

  return [...BUILTIN_ENTRIES, ...userEntries]
}

/**
 * Select — resolve a name → a concrete {@link PermissionProfile}.
 *
 *   - a built-in name ⇒ the frozen registry struct (byte-identical; no disk IO).
 *   - a user name     ⇒ the validated, in-ceiling struct from `<name>.json`.
 *   - unknown name    ⇒ {@link ProfileSelectError}.
 *   - bad/over-ceiling user file ⇒ {@link ProfileValidationError}.
 *
 * Composes the registry Resolve (`resolveProfileByName`) with disk loading.
 */
export const selectPermissionProfile = async (
  name: string,
  opts: SelectProfileOptions = {},
): Promise<PermissionProfile> => {
  // Built-in wins — authoritative, no disk IO, byte-identical struct.
  if (isNamedProfileName(name)) return resolveProfileByName(name)

  const env = opts.env ?? process.env
  const dir = resolveProfilesDir(opts.profilesDir, env)
  if (dir !== undefined) {
    const match = (await listUserProfileFiles(dir)).find((f) => f.name === name)
    if (match !== undefined) {
      return loadAndValidate(match.file, opts.allowWiden ?? false)
    }
  }

  const listOpts: ListProfilesOptions = {
    env,
    onError: "skip",
    ...(dir !== undefined ? { profilesDir: dir } : {}),
    ...(opts.allowWiden !== undefined ? { allowWiden: opts.allowWiden } : {}),
  }
  const available = (await listPermissionProfiles(listOpts)).map((e) => e.name)
  throw new ProfileSelectError(name, available)
}

/* ------------------------------------------------------------------------- */
/* Disk loading                                                               */
/* ------------------------------------------------------------------------- */

interface UserProfileFile {
  readonly name: string
  readonly file: string
}

/** Enumerate `<name>.json` files in `dir`, sorted by name for determinism. A
 *  missing dir yields `[]` (default-OFF / robust). */
const listUserProfileFiles = async (dir: string): Promise<ReadonlyArray<UserProfileFile>> => {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    // Missing / unreadable dir ⇒ no user profiles (built-ins still apply).
    return []
  }
  return names
    .filter((n) => extname(n).toLowerCase() === ".json")
    .map((n) => ({ name: n.slice(0, -".json".length), file: join(dir, n) }))
    .filter((f) => f.name.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Read + validate + ceiling-check one user profile file. Throws
 *  {@link ProfileValidationError} on any failure. */
const loadAndValidate = async (file: string, allowWiden: boolean): Promise<PermissionProfile> => {
  let raw: string
  try {
    raw = await readFile(file, "utf8")
  } catch (err) {
    throw new ProfileValidationError(file, `unreadable: ${(err as Error).message}`)
  }
  const profile = parseUserProfile(file, raw)
  if (!allowWiden) {
    const breach = exceedsCeiling(profile)
    if (breach !== undefined) {
      throw new ProfileValidationError(
        file,
        `exceeds safety ceiling (${breach}); pass allowWiden to admit it`,
      )
    }
  }
  return profile
}

/* ------------------------------------------------------------------------- */
/* Strict structural validator                                                */
/* ------------------------------------------------------------------------- */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const APPROVAL_MODES: ReadonlyArray<ApprovalMode> = ["auto", "once", "session", "always"]
const NETWORK_MODES: ReadonlyArray<NetworkMode> = ["deny-all", "allow-list", "allow-all"]
const OS_SANDBOX_KINDS: ReadonlyArray<OsSandboxKind> = [
  "seatbelt",
  "landlock",
  "windows-sandbox",
  "none",
]
const FS_POLICY_TYPES: ReadonlyArray<FileSystemPolicyType> = ["restricted", "managed"]
const MANAGED_BY: ReadonlyArray<ControlManagedBy> = ["user", "team", "admin"]
const FS_ACCESS: ReadonlyArray<FileSystemAccess> = ["read", "write"]

/**
 * Parse JSON text into a {@link PermissionProfile}, rejecting anything that is
 * not a structurally-complete, enum-valid profile. Throws
 * {@link ProfileValidationError} (never returns a partial object, never lets a
 * JSON.parse SyntaxError escape un-typed).
 *
 * The returned struct is rebuilt field-by-field from validated primitives, so
 * NO extra/unknown keys leak through and every field is the canonical type.
 */
export const parseUserProfile = (file: string, raw: string): PermissionProfile => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new ProfileValidationError(file, `not valid JSON: ${(err as Error).message}`)
  }
  if (!isObj(parsed)) {
    throw new ProfileValidationError(file, "top-level value must be a JSON object")
  }

  const fail = (detail: string): never => {
    throw new ProfileValidationError(file, detail)
  }

  const fileSystem = parseFileSystem(parsed.fileSystem, fail)
  const approval = parseApproval(parsed.approval, fail)
  const network = parseNetwork(parsed.network, fail)
  const sandbox = parseSandbox(parsed.sandbox, fail)
  const control = parseControl(parsed.control, fail)

  return { fileSystem, approval, network, sandbox, control }
}

type Fail = (detail: string) => never

const parseFileSystem = (v: unknown, fail: Fail): PermissionProfile["fileSystem"] => {
  if (!isObj(v)) return fail("fileSystem must be an object")
  if (typeof v.type !== "string" || !FS_POLICY_TYPES.includes(v.type as FileSystemPolicyType)) {
    return fail(`fileSystem.type must be one of ${FS_POLICY_TYPES.join(", ")}`)
  }
  if (!Array.isArray(v.entries)) return fail("fileSystem.entries must be an array")
  const entries = v.entries.map((e, i) => parseEntry(e, i, fail))
  return { type: v.type as FileSystemPolicyType, entries }
}

const parseEntry = (v: unknown, i: number, fail: Fail): FileSystemEntry => {
  if (!isObj(v)) return fail(`fileSystem.entries[${i}] must be an object`)
  if (typeof v.access !== "string" || !FS_ACCESS.includes(v.access as FileSystemAccess)) {
    return fail(`fileSystem.entries[${i}].access must be 'read' or 'write'`)
  }
  return { path: parsePath(v.path, i, fail), access: v.access as FileSystemAccess }
}

const parsePath = (v: unknown, i: number, fail: Fail): FileSystemPath => {
  if (!isObj(v)) return fail(`fileSystem.entries[${i}].path must be an object`)
  if (v.type === "special") {
    if (typeof v.kind !== "string" || !isSpecialPathKind(v.kind)) {
      return fail(`fileSystem.entries[${i}].path.kind is not a valid special path`)
    }
    return { type: "special", kind: v.kind as SpecialPathKind }
  }
  if (v.type === "path") {
    if (typeof v.value !== "string" || v.value.length === 0) {
      return fail(`fileSystem.entries[${i}].path.value must be a non-empty string`)
    }
    return { type: "path", value: v.value }
  }
  return fail(`fileSystem.entries[${i}].path.type must be 'special' or 'path'`)
}

const parseApproval = (v: unknown, fail: Fail): PermissionProfile["approval"] => {
  if (!isObj(v)) return fail("approval must be an object")
  if (typeof v.mode !== "string" || !APPROVAL_MODES.includes(v.mode as ApprovalMode)) {
    return fail(`approval.mode must be one of ${APPROVAL_MODES.join(", ")}`)
  }
  if (typeof v.promptUser !== "boolean") return fail("approval.promptUser must be a boolean")
  return { mode: v.mode as ApprovalMode, promptUser: v.promptUser }
}

const parseNetwork = (v: unknown, fail: Fail): PermissionProfile["network"] => {
  if (!isObj(v)) return fail("network must be an object")
  if (typeof v.mode !== "string" || !NETWORK_MODES.includes(v.mode as NetworkMode)) {
    return fail(`network.mode must be one of ${NETWORK_MODES.join(", ")}`)
  }
  const out: { mode: NetworkMode; allowHosts?: string[]; perRequestApproval?: boolean } = {
    mode: v.mode as NetworkMode,
  }
  if (v.allowHosts !== undefined) {
    if (!Array.isArray(v.allowHosts) || v.allowHosts.some((h) => typeof h !== "string")) {
      return fail("network.allowHosts must be an array of strings")
    }
    out.allowHosts = v.allowHosts as string[]
  }
  if (v.perRequestApproval !== undefined) {
    if (typeof v.perRequestApproval !== "boolean") {
      return fail("network.perRequestApproval must be a boolean")
    }
    out.perRequestApproval = v.perRequestApproval
  }
  return out
}

const parseSandbox = (v: unknown, fail: Fail): PermissionProfile["sandbox"] => {
  if (!isObj(v)) return fail("sandbox must be an object")
  if (typeof v.osSandbox !== "string" || !OS_SANDBOX_KINDS.includes(v.osSandbox as OsSandboxKind)) {
    return fail(`sandbox.osSandbox must be one of ${OS_SANDBOX_KINDS.join(", ")}`)
  }
  for (const k of ["readOnly", "workspaceWrite", "networkIsolated"] as const) {
    if (typeof v[k] !== "boolean") return fail(`sandbox.${k} must be a boolean`)
  }
  return {
    osSandbox: v.osSandbox as OsSandboxKind,
    readOnly: v.readOnly as boolean,
    workspaceWrite: v.workspaceWrite as boolean,
    networkIsolated: v.networkIsolated as boolean,
  }
}

const parseControl = (v: unknown, fail: Fail): PermissionProfile["control"] => {
  if (!isObj(v)) return fail("control must be an object")
  if (typeof v.auditRequired !== "boolean") return fail("control.auditRequired must be a boolean")
  const out: { managedBy?: ControlManagedBy; auditRequired: boolean } = {
    auditRequired: v.auditRequired,
  }
  if (v.managedBy !== undefined) {
    if (typeof v.managedBy !== "string" || !MANAGED_BY.includes(v.managedBy as ControlManagedBy)) {
      return fail(`control.managedBy must be one of ${MANAGED_BY.join(", ")}`)
    }
    out.managedBy = v.managedBy as ControlManagedBy
  }
  return out
}

/* ------------------------------------------------------------------------- */
/* Safety ceiling                                                             */
/* ------------------------------------------------------------------------- */

const NETWORK_RANK: Record<NetworkMode, number> = {
  "deny-all": 0,
  "allow-list": 1,
  "allow-all": 2,
}

/**
 * Returns a human reason string if `p` is MORE permissive than the safety
 * ceiling on any security-relevant axis, else `undefined`. Any single
 * over-reach trips it (conservative — fail toward rejection).
 *
 * The ceiling is the LOCKED-DOWN `default` built-in, NOT `trusted`. Rationale:
 * a user-authored, disk-loaded profile is the lowest-trust source of policy in
 * the system (anyone who can drop a `.json` in `QUANTA_PROFILES_DIR`), so by
 * default it may be at most as permissive as the canonical safe baseline. The
 * permissive `trusted` posture (network allow-all + workspace write + no
 * prompt) must be opted into EXPLICITLY via `allowWiden:true` — it is not
 * something a stray on-disk file can grant itself.
 *
 * Axes (each must be no wider than `default`):
 *   - network egress  (rank deny-all < allow-list < allow-all)
 *   - workspace write / readOnly exposure
 *   - network isolation removal
 *   - prompt suppression (promptUser=false) — `default` prompts the user
 *   - audit relaxation is NOT a widening axis (auditRequired=false is the
 *     default posture; forcing audit ON is a tightening, never trips).
 */
export const exceedsCeiling = (p: PermissionProfile): string | undefined => {
  const ceiling = NAMED_PROFILES.default

  if (NETWORK_RANK[p.network.mode] > NETWORK_RANK[ceiling.network.mode]) {
    return `network '${p.network.mode}' wider than ceiling '${ceiling.network.mode}'`
  }
  if (!p.sandbox.readOnly && ceiling.sandbox.readOnly) {
    return "sandbox.readOnly=false wider than read-only ceiling"
  }
  if (p.sandbox.workspaceWrite && !ceiling.sandbox.workspaceWrite) {
    return "sandbox.workspaceWrite=true wider than ceiling"
  }
  if (!p.sandbox.networkIsolated && ceiling.sandbox.networkIsolated) {
    return "sandbox.networkIsolated=false wider than ceiling"
  }
  if (!p.approval.promptUser && ceiling.approval.promptUser) {
    return "approval.promptUser=false suppresses prompting beyond ceiling"
  }
  return undefined
}
