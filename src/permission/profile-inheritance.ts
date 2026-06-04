/**
 * ADR-0438 — Permission-profile INHERITANCE (`extends` + cycle detection +
 * monotone-narrowing merge + Managed ceiling tagging).
 *
 * This is a NEW, leaf, PURE resolver. It is DISTINCT from
 * `profile-layer-merge.ts` (which merges layered SOURCE-precedence slots —
 * per-user / per-repo / team-admin — into one effective profile). This file
 * resolves an `extends` GRAPH: a declarative {@link ProfileDefinition} names a
 * base profile (built-in or another definition), and the resolver folds
 * base → derived axis-by-axis with the strict rule:
 *
 *   MONOTONE-NARROWING — a derived profile may only ever NARROW (tighten) a
 *   base; it can NEVER widen it. So "trusted but with network locked down" is
 *   expressible (narrowing), but "restricted but with network opened" is NOT
 *   (the widen is silently dropped — base value kept).
 *
 * Competitor evidence (Codex `_codex-rs-0.135-symbols.txt`): `extends`,
 * "permissions profile inheritance cycle detected", "extends undefined
 * profile", `TaggedPermissionProfile::Managed/::External`. We absorb: (a) the
 * `extends` chain, (b) cycle = THROW (fail-closed), (c) base→derived merge into
 * a fresh struct, (d) Managed tag = a ceiling that External (user) derived
 * profiles cannot widen.
 *
 * Purity / totality / fail-closed:
 *   - NO IO, NO Date.now / Math.random, NO global mutable state. The `visiting`
 *     stack + `cache` are call-local. `registry`/`builtins` are arguments.
 *   - TOTAL: every input either returns a complete {@link PermissionProfile} or
 *     THROWS. No partial / undefined return.
 *   - FAIL-CLOSED: unknown base, cycle, and self-extend all THROW. Absent any
 *     base, resolution starts from the locked-down
 *     {@link DEFAULT_PERMISSION_PROFILE}, never a permissive struct.
 *
 * REUSE (cited):
 *   - {@link NETWORK_RANK} from `profile-list-select.ts` — the shared
 *     `deny-all < allow-list < allow-all` ordering (no duplicate literal).
 *   - {@link NAMED_PROFILES} from `named-profiles.ts` — the default built-in
 *     fallback registry (so built-in names resolve byte-identically).
 *   - {@link DEFAULT_PERMISSION_PROFILE} from `permission-profile.ts` — the
 *     locked-down base when a definition has no `extends`.
 *   - `containsPath`'s pure node:path containment IDEA — entries intersection
 *     uses a resolver-FREE structural/literal comparison (see §entries) to stay
 *     pure (the real `containsPath` needs the special-path resolver = IO).
 *
 * NOT reused / why no conflict with `profile-layer-merge.ts`:
 *   - `mergeProfileLayers` / `PROFILE_RESTRICTIVENESS` answer a DIFFERENT
 *     question (which SOURCE wins a field). Inheritance is base→derived
 *     monotone-narrowing per the §axis table below, NOT source precedence, and
 *     it must keep base FS `entries` (a table the layer-merge deliberately
 *     leaves to source-precedence). So this resolver implements its own
 *     per-axis fold; it does not call into the layer-merge engine. The two
 *     modules are orthogonal and additive.
 *
 * Slice rules: leaf — depends ONLY on the pure permission types
 * (`permission-profile.ts`), the named registry (`named-profiles.ts`), and the
 * shared `NETWORK_RANK` const (`profile-list-select.ts`). No store / gate / IO.
 */

import { NAMED_PROFILES } from "./named-profiles"
import type {
  ApprovalMode,
  ApprovalPolicy,
  ControlManagedBy,
  ControlPolicy,
  FileSystemAccess,
  FileSystemEntry,
  FileSystemPath,
  FileSystemPolicyType,
  NetworkPolicy,
  OsSandboxKind,
  PermissionProfile,
  SandboxPolicy,
} from "./permission-profile"
import { DEFAULT_PERMISSION_PROFILE } from "./permission-profile"
import { NETWORK_RANK } from "./profile-list-select"

/* ------------------------------------------------------------------------- */
/* Types                                                                      */
/* ------------------------------------------------------------------------- */

/** Provenance tag. `managed` (org / MDM policy) is STRONGER than `external`
 *  (user-authored): a managed base imposes a ceiling a derived external profile
 *  cannot widen. Absorbed from Codex `TaggedPermissionProfile::Managed/::External`.
 *  Unspecified ⇒ treated as `external` (lowest trust). */
export type ProfileTag = "managed" | "external"

/** A declarative profile: any pillar may be PARTIAL (the missing parts are
 *  inherited from the `extends` chain) and it may name base profile(s). Unlike
 *  the complete {@link PermissionProfile}, every pillar is optional. */
export interface ProfileDefinition {
  /** Base profile name(s), applied left→right (a later base narrows an earlier
   *  one); the definition's own fields apply LAST. A name may be a built-in
   *  ({@link NAMED_PROFILES}) or another definition in the registry. Absent ⇒
   *  no base (resolution starts from {@link DEFAULT_PERMISSION_PROFILE}). */
  readonly extends?: string | ReadonlyArray<string>
  /** Provenance. Unspecified ⇒ `external`. A `managed`-tagged definition (or
   *  any managed base in its chain) sets a ceiling derived cannot widen. */
  readonly tag?: ProfileTag
  readonly fileSystem?: {
    readonly type?: FileSystemPolicyType
    readonly entries?: ReadonlyArray<FileSystemEntry>
  }
  readonly approval?: Partial<ApprovalPolicy>
  readonly network?: Partial<NetworkPolicy>
  readonly sandbox?: Partial<SandboxPolicy>
  readonly control?: Partial<ControlPolicy>
}

/** name → definition view (built-in adapters + user-defined definitions). */
export type ProfileDefinitionRegistry = Readonly<Record<string, ProfileDefinition>>

export interface ResolveInheritanceOpts {
  /** Built-in fallback: a name absent from the registry is looked up here. A
   *  name in NEITHER throws (fail-closed). Default {@link NAMED_PROFILES}. */
  readonly builtins?: Readonly<Record<string, PermissionProfile>>
  /** Behavior when a derived profile tries to widen a Managed ceiling:
   *  `clamp` (default — fail-SAFE: silently narrow back to the ceiling) or
   *  `throw` (strict org mode — reject the widen). */
  readonly onManagedWiden?: "throw" | "clamp"
}

/** Thrown by {@link resolveProfileInheritance} for any unresolvable graph —
 *  cycle, self-extend, or an `extends` pointing at an undefined profile. Carries
 *  a machine-readable `kind` so callers distinguish the three (never a silent
 *  permissive fallback). */
export class ProfileInheritanceError extends Error {
  override readonly name = "ProfileInheritanceError"
  constructor(
    readonly kind: "cycle" | "self-extend" | "unknown-base" | "managed-widen",
    message: string,
  ) {
    super(message)
  }
}

/* ------------------------------------------------------------------------- */
/* Axis ranks (LOWER = narrower / safer everywhere — single polarity)         */
/* ------------------------------------------------------------------------- */

// network: reuse the shared NETWORK_RANK (deny-all=0 < allow-list=1 < allow-all=2).

/** Approval strictness ladder — HIGHER = stricter (asks more often). Narrowing
 *  = picking the stricter (higher) mode. */
const APPROVAL_RANK: Readonly<Record<ApprovalMode, number>> = Object.freeze({
  auto: 0,
  once: 1,
  session: 2,
  always: 3,
})

/** FS policy type strictness — `managed` (org-locked) is stricter than
 *  `restricted`. Narrowing = picking the stronger (higher). */
const FS_TYPE_RANK: Readonly<Record<FileSystemPolicyType, number>> = Object.freeze({
  restricted: 0,
  managed: 1,
})

/** control.managedBy lock strength — admin > team > user > (undefined). */
const MANAGED_BY_RANK: Readonly<Record<ControlManagedBy, number>> = Object.freeze({
  user: 1,
  team: 2,
  admin: 3,
})
const managedByRank = (m: ControlManagedBy | undefined): number =>
  m === undefined ? 0 : MANAGED_BY_RANK[m]

/** OS-sandbox presence strength — any concrete sandbox (1) is stronger than
 *  `none` (0). The three concrete kinds are equal (a host runs exactly one;
 *  cross-OS ordering is not meaningful — same decision as
 *  `profile-layer-merge.ts` OS_SANDBOX_SAFETY). */
const osSandboxRank = (k: OsSandboxKind): number => (k === "none" ? 0 : 1)

/* ------------------------------------------------------------------------- */
/* Per-axis merge — base ⊓ derived (result NEVER wider than base)             */
/* ------------------------------------------------------------------------- */

/** The host CONSTRAINT the BASE (a complete, resolved profile) imposes on an
 *  `allow-list` result:
 *    - base `allow-list` mode ⇒ the EXACT permitted set; an ABSENT/empty
 *      `allowHosts` means ZERO hosts (the empty set ∅ — an allow-list with no
 *      entries permits nothing), NOT "no constraint".
 *    - base `allow-all` ⇒ `undefined` = NO constraint on the host axis (every host
 *      permitted; the result became allow-list only because the derived narrowed).
 *  Returning ∅ (vs undefined) for a host-less allow-list base is the fix for the
 *  zero-host widen: the intersection is forced to ∅ so a derived can never
 *  INTRODUCE hosts the base did not already permit. (`deny-all` never reaches the
 *  host axis — the mode narrowing keeps the result `deny-all`.) */
const baseHostConstraint = (base: NetworkPolicy): ReadonlyArray<string> | undefined =>
  base.mode === "allow-list" ? (base.allowHosts ?? []) : undefined

/** allowHosts merge for a result that is `allow-list` — the INTERSECTION of the
 *  base's host constraint and the derived's EXPLICIT host list. A derived that
 *  OMITS `allowHosts` INHERITS the base (no new constraint, no narrowing); a
 *  derived that NAMES hosts may only narrow the base via intersection. Because a
 *  host-less `allow-list` base contributes the EMPTY set, a derived can NOT widen
 *  it — adding hosts to a zero-host base yields ∅, never the derived's list.
 *  Returns undefined only when the base is NOT allow-list and the derived names no
 *  hosts (no host axis on either side). */
const mergeAllowHosts = (
  base: NetworkPolicy,
  d: Partial<NetworkPolicy>,
): ReadonlyArray<string> | undefined => {
  const bh = baseHostConstraint(base)
  const dh = d.allowHosts // explicit-only: absent ⇒ inherit base, never narrow.
  if (bh !== undefined && dh !== undefined) {
    const ds = new Set(dh)
    return bh.filter((h) => ds.has(h))
  }
  return bh ?? dh
}

/** (a) network — MRW. mode = the NARROWER of base/derived. allowHosts =
 *  intersection (derived may only drop hosts, never add). perRequestApproval =
 *  OR (either side requiring per-call approval forces it). */
const mergeNetwork = (
  base: NetworkPolicy,
  d: Partial<NetworkPolicy> | undefined,
): NetworkPolicy => {
  if (d === undefined) return base
  // mode: pick narrower (lower NETWORK_RANK). A widen attempt keeps base; an
  // omitted derived mode inherits base.
  const mode =
    d.mode !== undefined && NETWORK_RANK[d.mode] < NETWORK_RANK[base.mode] ? d.mode : base.mode
  const out: {
    mode: NetworkPolicy["mode"]
    allowHosts?: ReadonlyArray<string>
    perRequestApproval?: boolean
  } = { mode }
  // allowHosts only meaningful on allow-list; intersection (narrowing only).
  if (mode === "allow-list") {
    const hosts = mergeAllowHosts(base, d)
    if (hosts !== undefined) out.allowHosts = hosts
  }
  if ((base.perRequestApproval ?? false) || (d.perRequestApproval ?? false)) {
    out.perRequestApproval = true
  }
  return out
}

/** (b) approval — MRW. mode = stricter (higher ladder). promptUser = OR
 *  (suppressing the prompt is a widen ⇒ base prompting forces a prompt). */
const mergeApproval = (
  base: ApprovalPolicy,
  d: Partial<ApprovalPolicy> | undefined,
): ApprovalPolicy => {
  if (d === undefined) return base
  const mode =
    d.mode !== undefined && APPROVAL_RANK[d.mode] > APPROVAL_RANK[base.mode] ? d.mode : base.mode
  const promptUser = base.promptUser || (d.promptUser ?? false)
  return { mode, promptUser }
}

/** True when `entry` (already a concrete entry) is COVERED BY `coverer` — i.e.
 *  picking `entry` does not widen beyond `coverer`. Resolver-FREE (pure): we do
 *  NOT expand special paths (that needs IO). Conservative rules:
 *    - special vs special: same `kind` ⇒ same location.
 *    - path vs path: literal string equality OR `coverer` is a path-prefix
 *      ancestor of `entry` (so a narrower sub-path is covered by a broader root).
 *    - special vs path (mixed): NOT covered (conservative — drop the derived
 *      entry; narrowing direction is always safe).
 *  AND the access must be covered (a `read` request is covered by `read`/`write`;
 *  a `write` request needs a `write` coverer). */
const fsPathStr = (p: FileSystemPath): string =>
  p.type === "special" ? `special:${p.kind}` : p.value

const accessCovered = (request: FileSystemAccess, by: FileSystemAccess): boolean =>
  by === "write" ? true : request === "read"

/** Literal-path ancestor test, pure (no resolver): `anc` covers `desc` when they
 *  are equal or `desc` is under `anc/`. Both must be absolute literals. */
const literalAncestor = (anc: string, desc: string): boolean => {
  if (anc === desc) return true
  const a = anc.endsWith("/") ? anc : `${anc}/`
  return desc.startsWith(a)
}

const entryCoveredBy = (entry: FileSystemEntry, coverer: FileSystemEntry): boolean => {
  if (!accessCovered(entry.access, coverer.access)) return false
  const ep = entry.path
  const cp = coverer.path
  if (ep.type === "special" && cp.type === "special") return ep.kind === cp.kind
  if (ep.type === "path" && cp.type === "path") {
    // Only literal absolute prefixes; relative paths are ambiguous ⇒ require equality.
    return cp.value.startsWith("/") && ep.value.startsWith("/")
      ? literalAncestor(cp.value, ep.value)
      : ep.value === cp.value
  }
  return false // mixed special/path ⇒ conservatively not covered (drop derived).
}

/** (c) fileSystem — type MRW (max strength), entries INTERSECTION. derived may
 *  only keep entries already covered by base (never add a broader grant);
 *  derived omitting `entries` inherits base.entries; derived `[]` denies all. */
const mergeFileSystem = (
  base: PermissionProfile["fileSystem"],
  d: ProfileDefinition["fileSystem"],
): PermissionProfile["fileSystem"] => {
  const type =
    d?.type !== undefined && FS_TYPE_RANK[d.type] > FS_TYPE_RANK[base.type] ? d.type : base.type
  if (d?.entries === undefined) return { type, entries: base.entries }
  // intersection: a derived entry survives only if some base entry covers it.
  const dedup = new Set<string>()
  const entries: FileSystemEntry[] = []
  for (const de of d.entries) {
    if (!base.entries.some((be) => entryCoveredBy(de, be))) continue
    const key = `${fsPathStr(de.path)}|${de.access}`
    if (dedup.has(key)) continue
    dedup.add(key)
    entries.push(de)
  }
  return { type, entries }
}

/** (d) sandbox — per-flag MRW. osSandbox: keep the stronger (none↛active);
 *  readOnly OR, workspaceWrite AND, networkIsolated OR. */
const mergeSandbox = (
  base: SandboxPolicy,
  d: Partial<SandboxPolicy> | undefined,
): SandboxPolicy => {
  if (d === undefined) return base
  const osSandbox =
    d.osSandbox !== undefined && osSandboxRank(d.osSandbox) > osSandboxRank(base.osSandbox)
      ? d.osSandbox
      : base.osSandbox
  return {
    osSandbox,
    readOnly: base.readOnly || (d.readOnly ?? false),
    workspaceWrite: base.workspaceWrite && (d.workspaceWrite ?? true),
    networkIsolated: base.networkIsolated || (d.networkIsolated ?? false),
  }
}

/** (e) control — MRW. managedBy max (admin↛user); auditRequired OR. */
const mergeControl = (
  base: ControlPolicy,
  d: Partial<ControlPolicy> | undefined,
): ControlPolicy => {
  if (d === undefined) return base
  const managedBy =
    d.managedBy !== undefined && managedByRank(d.managedBy) > managedByRank(base.managedBy)
      ? d.managedBy
      : base.managedBy
  const auditRequired = base.auditRequired || (d.auditRequired ?? false)
  const out: ControlPolicy =
    managedBy !== undefined ? { managedBy, auditRequired } : { auditRequired }
  return out
}

/** Fold a partial definition's OWN fields onto a complete base, narrowing only. */
const mergeProfile = (base: PermissionProfile, d: ProfileDefinition): PermissionProfile => ({
  fileSystem: mergeFileSystem(base.fileSystem, d.fileSystem),
  approval: mergeApproval(base.approval, d.approval),
  network: mergeNetwork(base.network, d.network),
  sandbox: mergeSandbox(base.sandbox, d.sandbox),
  control: mergeControl(base.control, d.control),
})

/** Adapt a complete built-in profile into a definition (all pillars present, no
 *  extends) so it can be folded uniformly. */
const asDefinition = (p: PermissionProfile): ProfileDefinition => ({
  fileSystem: { type: p.fileSystem.type, entries: p.fileSystem.entries },
  approval: p.approval,
  network: p.network,
  sandbox: p.sandbox,
  control: p.control,
})

/* ------------------------------------------------------------------------- */
/* Managed ceiling                                                            */
/* ------------------------------------------------------------------------- */

/** Per-axis "is `result` wider than `ceiling`?" — using the same ranks as the
 *  merge. Returns the first breached axis name, else undefined. */
const widerAxis = (result: PermissionProfile, ceiling: PermissionProfile): string | undefined => {
  if (NETWORK_RANK[result.network.mode] > NETWORK_RANK[ceiling.network.mode]) return "network.mode"
  // allowHosts widening: when the ceiling is an allow-list it permits EXACTLY its
  // host set (absent ⇒ ∅). A result that is allow-list with ANY host outside that
  // set widens the ceiling's egress — even at the SAME mode rank. (A ceiling that
  // is allow-all imposes no host constraint; a deny-all ceiling already tripped
  // the mode check above for any non-deny-all result.)
  if (ceiling.network.mode === "allow-list" && result.network.mode === "allow-list") {
    const permitted = new Set(ceiling.network.allowHosts ?? [])
    const resultHosts = result.network.allowHosts ?? []
    if (resultHosts.some((h) => !permitted.has(h))) return "network.allowHosts"
  }
  if (APPROVAL_RANK[result.approval.mode] < APPROVAL_RANK[ceiling.approval.mode])
    return "approval.mode"
  if (result.approval.promptUser === false && ceiling.approval.promptUser === true) {
    return "approval.promptUser"
  }
  if (FS_TYPE_RANK[result.fileSystem.type] < FS_TYPE_RANK[ceiling.fileSystem.type]) {
    return "fileSystem.type"
  }
  // fileSystem.entries widening: both `restricted` and `managed` FS types are
  // allow-lists — the ceiling permits EXACTLY the paths/access its entries cover
  // (absent ⇒ ∅). A result holding ANY entry NOT covered by SOME ceiling entry
  // grants FS reach the ceiling never permitted, even at the SAME type rank.
  // Reuse `entryCoveredBy` in the result-entry-must-be-covered direction (same
  // semantics the merge uses for base→derived intersection). This is the
  // sibling of the network.allowHosts check above; without it `throw` mode
  // leaks a wider FS grant and `clamp` mode silently skips clampTo.
  if (
    result.fileSystem.entries.some(
      (re) => !ceiling.fileSystem.entries.some((ce) => entryCoveredBy(re, ce)),
    )
  ) {
    return "fileSystem.entries"
  }
  if (osSandboxRank(result.sandbox.osSandbox) < osSandboxRank(ceiling.sandbox.osSandbox)) {
    return "sandbox.osSandbox"
  }
  if (result.sandbox.readOnly === false && ceiling.sandbox.readOnly === true) {
    return "sandbox.readOnly"
  }
  if (result.sandbox.workspaceWrite === true && ceiling.sandbox.workspaceWrite === false) {
    return "sandbox.workspaceWrite"
  }
  if (result.sandbox.networkIsolated === false && ceiling.sandbox.networkIsolated === true) {
    return "sandbox.networkIsolated"
  }
  if (managedByRank(result.control.managedBy) < managedByRank(ceiling.control.managedBy)) {
    return "control.managedBy"
  }
  if (result.control.auditRequired === false && ceiling.control.auditRequired === true) {
    return "control.auditRequired"
  }
  return undefined
}

/** Clamp `result` down to never exceed `ceiling` on any axis. Implemented as
 *  the SAME monotone-narrowing fold (ceiling re-applied as a definition), which
 *  by construction narrows every axis that was wider. */
const clampTo = (result: PermissionProfile, ceiling: PermissionProfile): PermissionProfile =>
  mergeProfile(result, asDefinition(ceiling))

/* ------------------------------------------------------------------------- */
/* Resolver                                                                   */
/* ------------------------------------------------------------------------- */

const normalizeExtends = (e: ProfileDefinition["extends"]): ReadonlyArray<string> =>
  e === undefined ? [] : typeof e === "string" ? [e] : e

/** Mutable resolution context threaded through the recursion — all call-local
 *  (purity preserved: nothing escapes a single `resolveProfileInheritance`). */
interface ResolveCtx {
  readonly registry: ProfileDefinitionRegistry
  readonly builtins: Readonly<Record<string, PermissionProfile>>
  readonly onWiden: "throw" | "clamp"
  readonly visiting: string[] // ordered path stack (cycle detection + message)
  readonly cache: Map<string, PermissionProfile>
  // strongest managed ceiling discovered along each resolved name's chain.
  readonly managedCeil: Map<string, PermissionProfile>
}

/** Is `n` a managed-tagged definition in the registry? (Built-ins are never
 *  managed — they carry no tag.) */
const isManaged = (n: string, registry: ProfileDefinitionRegistry): boolean =>
  registry[n]?.tag === "managed"

/** Result of folding the bases: the established accumulator + the strongest
 *  managed ceiling (if any) the chain imposes. */
interface FoldResult {
  readonly acc: PermissionProfile
  readonly ceiling: PermissionProfile | undefined
}

/** Fold the bases of a definition into an accumulator + ceiling. The FIRST
 *  non-managed base ESTABLISHES the accumulator (not a narrowing of DEFAULT);
 *  subsequent non-managed bases narrow it. Managed bases contribute only a
 *  ceiling (the meet of all managed ancestors). */
const foldBases = (bases: ReadonlyArray<string>, ctx: ResolveCtx): FoldResult => {
  let acc: PermissionProfile = DEFAULT_PERMISSION_PROFILE
  let ceiling: PermissionProfile | undefined
  let first = true
  for (const b of bases) {
    const resolvedBase = resolveNode(b, ctx)
    const inherited = ctx.managedCeil.get(b)
    if (inherited !== undefined) {
      ceiling = ceiling === undefined ? inherited : strongerCeiling(ceiling, inherited)
    }
    if (isManaged(b, ctx.registry)) {
      ceiling = ceiling === undefined ? resolvedBase : strongerCeiling(ceiling, resolvedBase)
      continue
    }
    acc = first ? resolvedBase : mergeProfile(acc, asDefinition(resolvedBase))
    first = false
  }
  return { acc, ceiling }
}

/** Combine the inherited managed ceiling with a self-tagged managed definition.
 *  A `managed`-tagged definition is itself part of the ceiling (so its own
 *  declared posture cannot later be widened by a child extending it). */
const combineSelfCeiling = (
  tag: ProfileTag | undefined,
  baseCeil: PermissionProfile | undefined,
  merged: PermissionProfile,
): PermissionProfile | undefined => {
  if (tag !== "managed") return baseCeil
  return baseCeil === undefined ? merged : strongerCeiling(baseCeil, merged)
}

/** Apply a managed ceiling to a result: record it, then clamp (default) or
 *  throw on a widen. */
const applyCeiling = (
  n: string,
  result: PermissionProfile,
  ceiling: PermissionProfile,
  ctx: ResolveCtx,
): PermissionProfile => {
  ctx.managedCeil.set(n, ceiling)
  const breach = widerAxis(result, ceiling)
  if (breach === undefined) return result
  if (ctx.onWiden === "throw") {
    throw new ProfileInheritanceError(
      "managed-widen",
      `permissions profile '${n}' widens managed ceiling on axis '${breach}'`,
    )
  }
  return clampTo(result, ceiling)
}

/** Resolve a leaf: a name absent from the registry must be a built-in, else
 *  fail-closed THROW. Returns the resolved built-in (cached). */
const resolveBuiltin = (n: string, ctx: ResolveCtx): PermissionProfile => {
  const builtin = ctx.builtins[n]
  if (builtin === undefined) {
    throw new ProfileInheritanceError(
      "unknown-base",
      `permissions profile extends undefined profile '${n}'`,
    )
  }
  ctx.cache.set(n, builtin)
  return builtin
}

/** Resolve one node of the inheritance graph (recursive). Cycle / self-extend /
 *  unknown-base all THROW. The `visiting` stack is balanced on every path. */
const resolveNode = (n: string, ctx: ResolveCtx): PermissionProfile => {
  const cached = ctx.cache.get(n)
  if (cached !== undefined) return cached
  if (ctx.visiting.includes(n)) {
    throw new ProfileInheritanceError(
      "cycle",
      `permissions profile inheritance cycle detected: ${[...ctx.visiting, n].join(" -> ")}`,
    )
  }
  ctx.visiting.push(n)
  try {
    const def = ctx.registry[n]
    if (def === undefined) return resolveBuiltin(n, ctx)

    const bases = normalizeExtends(def.extends)
    if (bases.includes(n)) {
      throw new ProfileInheritanceError(
        "self-extend",
        `permissions profile '${n}' cannot extend itself`,
      )
    }

    const { acc, ceiling: baseCeil } = foldBases(bases, ctx)
    const merged = mergeProfile(acc, def)
    // A self-tagged managed definition is itself part of the ceiling.
    const ceiling = combineSelfCeiling(def.tag, baseCeil, merged)
    const result = ceiling === undefined ? merged : applyCeiling(n, merged, ceiling, ctx)
    ctx.cache.set(n, result)
    return result
  } finally {
    ctx.visiting.pop()
  }
}

/**
 * Resolve `name` along its `extends` chain into a complete
 * {@link PermissionProfile}, folding base → derived with monotone-narrowing
 * (a derived profile can only NARROW its base, never widen it).
 *
 * Pure / total / fail-closed (see module doc). THROWS
 * {@link ProfileInheritanceError} on a cycle, self-extend, or an `extends`
 * pointing at a profile that is in neither the registry nor `builtins`.
 *
 * A definition (or any base in its chain) tagged `managed` imposes a ceiling:
 * the final result is checked against the strongest managed ancestor and, per
 * `onManagedWiden`, either clamped back (default) or rejected (`throw`).
 */
export const resolveProfileInheritance = (
  name: string,
  registry: ProfileDefinitionRegistry,
  opts: ResolveInheritanceOpts = {},
): PermissionProfile =>
  resolveNode(name, {
    registry,
    builtins: opts.builtins ?? NAMED_PROFILES,
    onWiden: opts.onManagedWiden ?? "clamp",
    visiting: [],
    cache: new Map(),
    managedCeil: new Map(),
  })

/** Pick the stronger (narrower) of two ceilings axis-by-axis (their meet). The
 *  meet is itself a valid ceiling no wider than either. */
const strongerCeiling = (a: PermissionProfile, b: PermissionProfile): PermissionProfile =>
  mergeProfile(a, asDefinition(b))
