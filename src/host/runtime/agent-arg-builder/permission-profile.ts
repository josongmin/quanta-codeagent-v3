/**
 * `host/runtime/agent-arg-builder/permission-profile.ts` — extracted from
 * `agent-arg-builder.ts` (god-module split). The composition-root permission-
 * profile resolution cluster: env/flag → `PermissionMode` override (GAP2) +
 * per-thread `TwoLayerManager` (Track A2 + ADR-0438 inheritance) + the
 * `QUANTA_PERMISSION_PROFILES_JSON` definition registry (ADR-0438) + the layered
 * `policy-merge` slots. Pure projection of the composition-root env view; the
 * public surface is re-exported from `agent-arg-builder.ts` byte-compatibly.
 */

import {
  buildDefinition,
  createTwoLayerManager,
  isNamedProfileName,
  type MergeStrategy,
  mergeProfileLayers,
  NAMED_PROFILE_NAMES,
  type PermissionMode,
  type PermissionProfile,
  type ProfileDefinition,
  type ProfileDefinitionRegistry,
  type ProfileLayerSlots,
  ProfileValidationError,
  permissionModeFromProfile,
  resolveProfileByName,
  resolveProfileInheritance,
  type TwoLayerManager,
} from "@/permission"
import { errMessage } from "@/shared"

/** Layered-profile merge strategy from the `policy-merge` knob. ABSENT / typo /
 *  empty ⇒ `"source-precedence"` — the pre-existing precedence (most-
 *  authoritative present source wins each field). Selecting it preserves
 *  current behavior byte-identically; `"most-restrictive"` is the only
 *  behavior-changing value. */
export const resolvePolicyMergeStrategy = (env: NodeJS.ProcessEnv): MergeStrategy =>
  env.QUANTA_POLICY_MERGE_STRATEGY === "most-restrictive" ? "most-restrictive" : "source-precedence"

/** Resolve the optional layered named-profile slots from the composition-root
 *  env view: `QUANTA_PERMISSION_PROFILE_PER_USER` / `_PER_REPO` / `_TEAM_ADMIN`.
 *  Each is an OPTIONAL named-profile token resolved through the same fail-closed
 *  registry as `QUANTA_PERMISSION_PROFILE` (a typo / `custom` THROWS). Returns
 *  `undefined` when NO layered var is set ⇒ the caller falls back to the legacy
 *  single-profile GAP2 wire (byte-identical). */
export const resolveLayeredProfileSlots = (
  env: NodeJS.ProcessEnv,
): ProfileLayerSlots | undefined => {
  const slotFor = (raw: string | undefined): PermissionProfile | undefined => {
    if (raw === undefined || raw === "") return undefined
    // FAIL-CLOSED — same posture as the single-profile resolver.
    return resolveProfileByName(raw)
  }
  const perUser = slotFor(env.QUANTA_PERMISSION_PROFILE_PER_USER)
  const perRepo = slotFor(env.QUANTA_PERMISSION_PROFILE_PER_REPO)
  const teamAdmin = slotFor(env.QUANTA_PERMISSION_PROFILE_TEAM_ADMIN)
  if (perUser === undefined && perRepo === undefined && teamAdmin === undefined) {
    return undefined
  }
  return {
    ...(perUser !== undefined ? { perUser } : {}),
    ...(perRepo !== undefined ? { perRepo } : {}),
    ...(teamAdmin !== undefined ? { teamAdmin } : {}),
  }
}

/** ADR-0438 wire — build the {@link ProfileDefinitionRegistry} of USER-authored
 *  `extends` definitions from the composition-root env view.
 *
 *  Source: a single JSON-object env knob `QUANTA_PERMISSION_PROFILES_JSON`
 *  mapping `<name> → ProfileDefinition` (every pillar partial + optional
 *  `extends`/`tag`). Chosen over a disk dir because (a) it is synchronous at the
 *  composition root (no async file IO on the startup path the A2 wire already
 *  runs sync), (b) it matches the existing `QUANTA_*` single-env idiom the
 *  sibling profile knobs use, and (c) the disk dir (`QUANTA_PROFILES_DIR`) is
 *  already owned by `selectPermissionProfile` for COMPLETE structs — definitions
 *  are a distinct, partial shape, so a distinct knob avoids overloading it.
 *
 *  Fail-closed (the env READ is the ONLY IO; the resolver stays pure):
 *   - absent / empty ⇒ `{}` (default-OFF — the A2 path is byte-identical).
 *   - not valid JSON / not an object ⇒ THROW (startup rejects loudly).
 *   - any per-definition parse error ⇒ THROW (a malformed user definition must
 *     not be silently dropped — see {@link buildDefinition}).
 *   - a definition whose KEY collides with a built-in name ⇒ THROW (a built-in
 *     name is authoritative; a user file must not shadow `trusted`/`default`/
 *     `restricted`, mirroring `profile-list-select.ts` built-in precedence).
 *
 *  The returned registry composes WITH the built-ins: `resolveProfileInheritance`
 *  falls back to `NAMED_PROFILES` for any name (base or top-level) absent here,
 *  so a definition may `extends: "trusted"` and a built-in name still resolves
 *  byte-identically. */
export const buildProfileDefinitionRegistry = (
  env: NodeJS.ProcessEnv,
): ProfileDefinitionRegistry => {
  const raw = env.QUANTA_PERMISSION_PROFILES_JSON
  if (raw === undefined || raw.trim() === "") return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new ProfileValidationError(
      "QUANTA_PERMISSION_PROFILES_JSON",
      `not valid JSON: ${errMessage(e)}`,
    )
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProfileValidationError(
      "QUANTA_PERMISSION_PROFILES_JSON",
      "must be a JSON object mapping <name> -> ProfileDefinition",
    )
  }
  const registry: Record<string, ProfileDefinition> = {}
  for (const [name, def] of Object.entries(parsed as Record<string, unknown>)) {
    if ((NAMED_PROFILE_NAMES as ReadonlyArray<string>).includes(name)) {
      throw new ProfileValidationError(
        `QUANTA_PERMISSION_PROFILES_JSON.${name}`,
        `name '${name}' collides with a built-in profile (built-ins are authoritative)`,
      )
    }
    // buildDefinition is fail-closed: unknown key / bad enum / malformed ⇒ throw.
    registry[name] = buildDefinition(`QUANTA_PERMISSION_PROFILES_JSON.${name}`, def)
  }
  return registry
}

/** True when the selected `name` should resolve through the inheritance graph
 *  rather than the legacy by-name built-in path. The inheritance path is taken
 *  whenever ANY user definition exists (the selected name may be a user def, or a
 *  built-in extended by a user def in its chain). With an EMPTY registry the
 *  legacy path is kept so the three built-ins stay byte-identical (reference
 *  identity) and the A2 wire is unchanged. */
const hasUserDefinitions = (registry: ProfileDefinitionRegistry): boolean =>
  Object.keys(registry).length > 0

/** GAP2 + layered-policy-merge — resolve the live `PermissionContext.mode`
 *  override from the permission profile(s) selected at the composition root.
 *
 *  Two paths, in precedence order:
 *   1. LAYERED — when ≥1 of `QUANTA_PERMISSION_PROFILE_{PER_USER,PER_REPO,
 *      TEAM_ADMIN}` is set, the slots are merged via `mergeProfileLayers` under
 *      the `policy-merge` strategy (`QUANTA_POLICY_MERGE_STRATEGY`), and the
 *      mode is derived from the MERGED profile's approval pillar. The strategy
 *      deterministically changes the winner: under `source-precedence` the
 *      most-authoritative layer's approval wins; under `most-restrictive` the
 *      SAFER approval wins regardless of source.
 *   2. SINGLE (legacy GAP2) — otherwise the single `QUANTA_PERMISSION_PROFILE`
 *      (or `--permission-profile` flag, which WINS) is resolved and its
 *      approval pillar derived.
 *
 *  FAIL-CLOSED throughout: an unknown / `custom` name THROWS (a typo'd profile
 *  must not silently fall back to a permissive mode).
 *
 *  Returns `undefined` when NO profile (single or layered) is selected ⇒ the
 *  caller leaves `base.permission` untouched ⇒ byte-identical legacy (RFC §1.2).
 *  We DERIVE the existing single permission context rather than publishing a
 *  second profile manager: the network axis is already enforced by the A1
 *  dispatch-guard and the file-system axis is not dispatch-time-enforceable, so
 *  the only non-duplicating wire is the approval→context-mode derive. */
export const resolvePermissionModeFromProfile = (
  flag: import("@/host/runtime/agent-args").PermissionProfileToken | undefined,
  env: NodeJS.ProcessEnv,
  registry: ProfileDefinitionRegistry = {},
): PermissionMode | undefined => {
  // Layered path takes precedence when any layered var is present.
  const layered = resolveLayeredProfileSlots(env)
  if (layered !== undefined) {
    const strategy = resolvePolicyMergeStrategy(env)
    const { merged } = mergeProfileLayers(layered, strategy)
    return permissionModeFromProfile(merged)
  }
  // Legacy single-profile GAP2 path. Precedence MUST match
  // resolvePermissionProfileManager: an explicit `--permission-profile` flag
  // WINS over QUANTA_PERMISSION_PROFILE, so the derived mode and the published
  // manager always describe the SAME profile.
  const name = flag ?? env.QUANTA_PERMISSION_PROFILE
  if (name === undefined || name === "") return undefined
  // FAIL-CLOSED: throws on an unknown name (incl. `custom`, an undefined base, a
  // cycle, or a managed-widen) — the surface entry surfaces it rather than
  // guessing a mode.
  return permissionModeFromProfile(resolveSelectedProfile(name, registry))
}

/** ADR-0438 — resolve the SELECTED profile name to a concrete
 *  {@link PermissionProfile}, routing through the inheritance graph when any user
 *  definition exists, else the legacy by-name built-in path (byte-identical
 *  reference identity for the 3 built-ins). The SAME resolution feeds BOTH the
 *  mode derive and the manager registration, so they always describe one profile.
 *
 *  Fail-closed: `resolveProfileInheritance` throws a typed
 *  {@link ProfileInheritanceError} for an unknown name / undefined base / cycle /
 *  self-extend / managed-widen (under `onManagedWiden:"throw"`); the legacy
 *  `resolveProfileByName` throws on an unknown / `custom` name. Neither ever
 *  returns a permissive fallback. */
const resolveSelectedProfile = (
  name: string,
  registry: ProfileDefinitionRegistry,
): PermissionProfile =>
  hasUserDefinitions(registry)
    ? resolveProfileInheritance(name, registry)
    : resolveProfileByName(name)

/** Track A2 — the composition-root session thread key the named permission
 *  profile is registered under. The unified-agent surface starts ONE logical
 *  session per process; a single stable key is the right granularity for the
 *  startup profile (the per-thread `TwoLayerManager` API still lets a future
 *  multi-thread host register additional profiles under their own keys). */
export const PERMISSION_PROFILE_SESSION_THREAD = "session" as const

/**
 * Track A2 + ADR-0438 — resolve the named permission profile from the
 * composition-root env/flag view and apply it through the EXISTING
 * `TwoLayerManager` write path.
 *
 * Precedence: an explicit `--permission-profile <name>` flag (already validated
 * by the parser) WINS over the `QUANTA_PERMISSION_PROFILE` env knob. When
 * neither is present, returns `undefined` so the slot is OMITTED and behavior
 * is byte-identical to today (no manager constructed, no allocation).
 *
 * Two resolution paths, gated by whether ANY user definition exists in
 * `registry` (built from `QUANTA_PERMISSION_PROFILES_JSON`):
 *   - NO user defs (default-OFF) — legacy A2: `name` MUST be a built-in
 *     ({@link isNamedProfileName}); registered via `setPermissionProfileByName`.
 *     Byte-identical to before this ADR.
 *   - user defs present (ADR-0438) — `name` may be a built-in OR a user-def key;
 *     registered via `setPermissionProfileFromRegistry`, which resolves the
 *     `extends` graph (`resolveProfileInheritance`) so a profile declaring
 *     `extends` actually folds base → derived (monotone-narrowing + Managed
 *     ceiling) before the merged struct reaches the per-thread slot. A built-in
 *     name with no user-def chain still resolves byte-identically.
 *
 * Fail-closed throughout: the legacy path throws on a non-built-in name; the
 * inheritance path throws a typed `ProfileInheritanceError` (unknown base /
 * cycle / self-extend / managed-widen). Neither silently falls back to a
 * permissive default. (The flag path cannot reach the legacy throw — the parser
 * already rejected an invalid flag value with exit 64 — but we re-validate
 * defensively so the single resolver owns the invariant.)
 */
export const resolvePermissionProfileManager = (
  flag: import("@/host/runtime/agent-args").PermissionProfileToken | undefined,
  env: NodeJS.ProcessEnv,
  registry: ProfileDefinitionRegistry = {},
): TwoLayerManager | undefined => {
  const name = flag ?? env.QUANTA_PERMISSION_PROFILE
  if (name === undefined || name === "") return undefined
  const manager = createTwoLayerManager()
  if (hasUserDefinitions(registry)) {
    // ADR-0438 — resolve through the `extends` graph (fail-closed throws on
    // cycle / unknown base / self-extend / managed-widen). A built-in name with
    // no chain folds to the byte-identical built-in via the `builtins` fallback.
    manager.setPermissionProfileFromRegistry(PERMISSION_PROFILE_SESSION_THREAD, name, registry)
    return manager
  }
  // Legacy A2 path — built-in names only, byte-identical.
  if (!isNamedProfileName(name)) {
    throw new Error(
      `QUANTA_PERMISSION_PROFILE='${name}' is not a resolvable named permission ` +
        `profile (one of default|restricted|trusted). Fix the value or unset it; ` +
        `a bespoke 'custom' profile is supplied as a struct, not by name.`,
    )
  }
  manager.setPermissionProfileByName(PERMISSION_PROFILE_SESSION_THREAD, name)
  return manager
}

/** Resolve BOTH composition-root permission-profile wirings from one place so
 *  `buildBaseFromArgs` carries a single call (keeps it under biome's
 *  cognitive-complexity cap). The `manager` is the per-thread slot (A2 +
 *  ADR-0438 inheritance); the `mode` is the behavior-LIVE PermissionContext
 *  override derived from the SAME resolved profile's approval pillar (GAP2). Both
 *  honor the same flag-wins precedence, the same `QUANTA_PERMISSION_PROFILES_JSON`
 *  registry, and the same fail-closed throw, so they always describe one profile.
 *  Absent profile ⇒ `{}` (both undefined ⇒ byte-identical legacy). */
export const resolvePermissionProfileWiring = (
  flag: import("@/host/runtime/agent-args").PermissionProfileToken | undefined,
  env: NodeJS.ProcessEnv,
): {
  /** Spread-ready slot (`{}` when absent) so the `base` literal carries no
   *  conditional branch for it (keeps `buildBaseFromArgs` under the complexity cap). */
  managerSlot: { permissionProfileManager?: TwoLayerManager }
  mode: PermissionMode | undefined
} => {
  // Build the inheritance registry ONCE (fail-closed) so the manager + the mode
  // derive resolve against the identical definitions. Empty ⇒ byte-identical A2.
  const registry = buildProfileDefinitionRegistry(env)
  const manager = resolvePermissionProfileManager(flag, env, registry)
  return {
    managerSlot: manager !== undefined ? { permissionProfileManager: manager } : {},
    mode: resolvePermissionModeFromProfile(flag, env, registry),
  }
}
