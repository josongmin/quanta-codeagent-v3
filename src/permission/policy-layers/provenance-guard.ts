/**
 * ADR-0470 — Config-provenance gate. SECURITY (🔴).
 *
 * WHAT. A PURE pre-merge filter for {@link ConfigLayer} lists that DROPS any
 * REPO-CONTROLLABLE layer contribution (`per-repo` / agent-`frontmatter`) which
 * would WIDEN a "grant-capable" security axis (auto-mode, approval-mode
 * loosening, network egress / allow-list widening, sandbox loosening). It runs
 * BEFORE {@link mergeLayered} so the merge engine never even sees an
 * untrusted-source widen on a granting field.
 *
 * WHY this slice exists. `policy-layers/index.ts` ranks sources
 * `team-admin > per-repo > per-user > default` and, under `source-precedence`,
 * the most-authoritative source that SETS a field wins it. That ranking is
 * correct for ADMIN policy (an org admin SHOULD out-rank a user) but it is a
 * PRIVILEGE-ESCALATION / SUPPLY-CHAIN hole for REPO-controllable sources: a
 * checked-in malicious `.quanta` policy (or an agent frontmatter block in an
 * untrusted repo) is `per-repo`, which out-ranks the USER's own `per-user`
 * config on a grant-capable field — so a clone of a hostile repo could silently
 * grant itself `approval.mode:"auto"` (AFK auto-approve), widen the network
 * allow-list, or strip the OS sandbox. A repo's config may make the posture
 * MORE restrictive (defense-in-depth is always safe) but must NEVER WIDEN it.
 *
 * The asymmetry mirrors {@link exceedsCeiling} (profile-list-select.ts): a
 * low-trust on-disk source may only narrow, never widen, the safe baseline.
 *
 * POLARITY REUSE. The "what counts as a widen" per axis is NOT re-invented — it
 * reuses the SAME ordering the rest of the permission layer already declares:
 *   - {@link NETWORK_RANK}  (deny-all < allow-list < allow-all; HIGHER = wider)
 *   - {@link APPROVAL_RANK} (auto < once < session < always; LOWER = wider, and
 *                            `auto` is the AFK auto-approve mode)
 *   - osSandbox presence    (any concrete sandbox stronger than `none`)
 * imported type/value-only from the sibling `profile-list-select.ts`, which is
 * the single source of truth for these polarities (no magic literal here).
 *
 * SECURITY DEFAULTS ON (NOT env-gated). Unlike a feature seam this guard is ON
 * by default — a security control that ships OFF protects nobody. The ONLY way
 * to disable it is an EXPLICIT, typed `acknowledgedRisk:true` opt-out (mirrors
 * the ADR-0078 redaction opt-out posture: a deliberate operator override, never
 * an env var a hostile repo could also set). With the guard ON and no
 * repo-source widens present, the output layer list is REFERENTIALLY identical
 * to the input — so {@link mergeLayered} produces a byte-identical result and
 * the existing default path is untouched.
 *
 * SLICE RULES — pure, leaf. NO IO, NO state, NO side effects, NO throw. Depends
 * only on SIBLING files inside `@/permission` (the `LayerSource` type from
 * `./index`, the `PermissionProfile` pillar types, and the SSOT `NETWORK_RANK` /
 * `APPROVAL_RANK` polarities from `profile-list-select`). Same inputs always
 * yield a deeply-equal output. Telemetry is RETURNED (a record array), never
 * emitted — the caller owns the sink (port inversion).
 */

import type {
  ApprovalMode,
  NetworkMode,
  OsSandboxKind,
  PermissionProfile,
} from "../permission-profile"
import { APPROVAL_RANK, NETWORK_RANK } from "../profile-list-select"
import type { LayerSource } from "./index"

/* ------------------------------------------------------------------------- */
/* Repo-controllable provenance                                              */
/* ------------------------------------------------------------------------- */

/**
 * A {@link ConfigLayer}, optionally tagged with its REPO-controllable origin.
 * `index.ts`'s {@link ConfigLayer} carries a coarse {@link LayerSource}; this
 * guard needs to distinguish the TWO repo-controllable provenances that share
 * the `per-repo` authority rank so telemetry can name the precise origin:
 *   - `per-repo`    — a checked-in `.quanta` / `.cursor` policy file.
 *   - `frontmatter` — an agent/skill frontmatter block inside the repo.
 * Both are attacker-controllable by anyone who can push to the repo, so both
 * are treated identically by the guard (only telemetry distinguishes them).
 */
export type ProvenanceSource = LayerSource | "frontmatter"

/**
 * The CLOSED set of provenances that are REPO-CONTROLLABLE (low-trust): a widen
 * on a grant-capable field from any of these is dropped. `per-user`,
 * `team-admin`, and `default` are NOT here — a user's own config and an org
 * admin's policy are trusted to grant, and `default` is the shipped baseline.
 *
 * This is the security crux: membership here = "may only narrow, never widen".
 */
export const REPO_CONTROLLABLE_SOURCES = ["per-repo", "frontmatter"] as const

/** Is this provenance repo-controllable (untrusted to GRANT)? */
export const isRepoControllable = (s: ProvenanceSource): boolean =>
  (REPO_CONTROLLABLE_SOURCES as ReadonlyArray<ProvenanceSource>).includes(s)

/** One config layer the guard operates over: a partial {@link PermissionProfile}
 *  plus its precise {@link ProvenanceSource}. Mirrors `index.ts` `ConfigLayer`
 *  but with the finer-grained source so frontmatter is distinguishable. */
export interface ProvenancedLayer {
  readonly source: ProvenanceSource
  readonly value: Partial<PermissionProfile>
}

/* ------------------------------------------------------------------------- */
/* Grant-capable fields + polarity                                           */
/* ------------------------------------------------------------------------- */

/**
 * The CLOSED set of grant-capable top-level pillars the guard polices. A pillar
 * NOT here (e.g. `fileSystem`, `control`) is passed through unchanged by this
 * guard (fileSystem widening is governed by the entry-coverage ceiling in
 * profile-list-select.ts; control/audit is not a GRANT axis). Adding a pillar
 * here is the only way to extend the policed surface — the polarity table below
 * is exhaustively keyed off this set so the two can never drift.
 */
export const GRANT_CAPABLE_FIELDS = ["approval", "network", "sandbox"] as const

export type GrantCapableField = (typeof GRANT_CAPABLE_FIELDS)[number]

/** Type guard — is a pillar key one the guard polices? */
export const isGrantCapableField = (k: string): k is GrantCapableField =>
  (GRANT_CAPABLE_FIELDS as ReadonlyArray<string>).includes(k)

/**
 * Permissiveness rank of a SINGLE grant-capable pillar value: HIGHER = WIDER
 * (more permissive). A candidate WIDENS a baseline iff its rank is strictly
 * greater. Each axis reuses the SSOT polarity from profile-list-select.ts:
 *
 *   - approval — `auto` is the AFK auto-approve (widest); the ladder
 *     `auto<once<session<always` ranks STRICTNESS, so widening = LOWER strictness.
 *     We invert it (negate) so HIGHER = wider, uniform with the others. A
 *     `promptUser:false` (prompt suppression) is an INDEPENDENT widen captured
 *     as a small bonus rank so it can never be masked by an equal mode.
 *   - network — {@link NETWORK_RANK} is already HIGHER = wider. The allow-LIST
 *     contents are a SEPARATE widen axis (a per-repo layer adding a host to the
 *     allow-set) handled by {@link allowListWidens}, since a set is not a scalar.
 *   - sandbox — strength of the protection; widening = REDUCING any protective
 *     bit (readOnly off, workspaceWrite on, networkIsolated off, osSandbox→none).
 *     Encoded as a count of REMOVED protections (HIGHER = wider).
 *
 * NOTE this is a SCALAR projection used only for the per-axis monotone compare;
 * the allow-list set widen is checked separately (sets have no total scalar order).
 */
const APPROVAL_PROMPT_SUPPRESS_BONUS = 1
const approvalWidenRank = (v: PermissionProfile["approval"]): number => {
  // Negate strictness so HIGHER = wider; add a bonus when prompting is
  // suppressed (an independent loosening even at the same mode).
  const strictness = APPROVAL_RANK[v.mode as ApprovalMode]
  const promptBonus = v.promptUser ? 0 : APPROVAL_PROMPT_SUPPRESS_BONUS
  return -strictness + promptBonus
}

const networkWidenRank = (v: PermissionProfile["network"]): number =>
  NETWORK_RANK[v.mode as NetworkMode]

/** osSandbox presence strength — concrete sandbox (1) stronger than `none` (0).
 *  Mirrors profile-list-select.ts `osSandboxRank` (same single polarity). */
const osSandboxStrength = (k: OsSandboxKind): number => (k === "none" ? 0 : 1)

/** Count of protective bits REMOVED relative to a fully-locked sandbox; HIGHER =
 *  wider. readOnly off / workspaceWrite on / networkIsolated off / osSandbox none
 *  each contribute one removed protection. */
const sandboxWidenRank = (v: PermissionProfile["sandbox"]): number => {
  let removed = 0
  if (!v.readOnly) removed += 1
  if (v.workspaceWrite) removed += 1
  if (!v.networkIsolated) removed += 1
  if (osSandboxStrength(v.osSandbox) === 0) removed += 1
  return removed
}

/**
 * Scalar widen-rank of a grant-capable pillar value. Exhaustive over
 * {@link GrantCapableField}; the `never` default is the COMPILE-TIME anchor so a
 * new pillar in {@link GRANT_CAPABLE_FIELDS} forces a polarity here (cannot
 * silently default to "0 = never widens").
 */
const widenRankOf = (field: GrantCapableField, value: unknown): number => {
  switch (field) {
    case "approval":
      return approvalWidenRank(value as PermissionProfile["approval"])
    case "network":
      return networkWidenRank(value as PermissionProfile["network"])
    case "sandbox":
      return sandboxWidenRank(value as PermissionProfile["sandbox"])
    default: {
      const _exhaustive: never = field
      return _exhaustive
    }
  }
}

/**
 * Network allow-LIST widen (a SET axis the scalar mode rank can't see): does the
 * candidate's `allowHosts` add a host NOT present in the baseline's allow-set?
 * A repo layer that keeps `mode:"allow-list"` (same scalar rank) but APPENDS a
 * host is still widening egress reach — this catches it.
 */
const allowListWidens = (
  candidate: PermissionProfile["network"],
  baseline: PermissionProfile["network"] | undefined,
): boolean => {
  const baseHosts = new Set(baseline?.allowHosts ?? [])
  return (candidate.allowHosts ?? []).some((h) => !baseHosts.has(h))
}

/**
 * Per-AXIS sandbox widen (the multi-axis analogue of {@link allowListWidens}).
 * `sandbox` is a STRUCT with FOUR INDEPENDENT safety axes (readOnly /
 * workspaceWrite / networkIsolated / osSandbox presence). The scalar
 * {@link sandboxWidenRank} sum projection is UNSOUND for an inter-source compare:
 * a hostile repo can TRADE protections — turn ON readOnly + turn OFF
 * networkIsolated — keeping its SUM ≤ the baseline's while still loosening the
 * specific network-isolation bit the baseline had locked. Under `source-precedence`
 * the repo's whole struct then wins and the widen lands. This mirrors exactly the
 * "most-restrictive that isn't" / sum-of-bits leak documented on
 * `policy-layers/index.ts` {@link FieldCombiner}: structs must be compared PER
 * SUB-AXIS, never by a collapsed scalar.
 *
 * Returns true iff the candidate is STRICTLY less-safe than the baseline on ANY
 * single axis (so a per-axis trade can never sneak a widen past the sum). The
 * baseline is the WIDEST trusted sandbox; when no trusted peer set it the floor
 * is the fully-locked sandbox (every protection on) so a repo can only match it.
 */
const FULLY_LOCKED_SANDBOX: PermissionProfile["sandbox"] = {
  osSandbox: "seatbelt",
  readOnly: true,
  workspaceWrite: false,
  networkIsolated: true,
}
const sandboxAxisWidens = (
  candidate: PermissionProfile["sandbox"],
  baseline: PermissionProfile["sandbox"] | undefined,
): boolean => {
  const base = baseline ?? FULLY_LOCKED_SANDBOX
  // readOnly: true is SAFER → candidate widens if it turns it OFF while base had ON.
  if (base.readOnly && !candidate.readOnly) return true
  // workspaceWrite: false is SAFER → candidate widens if it turns it ON while base had OFF.
  if (!base.workspaceWrite && candidate.workspaceWrite) return true
  // networkIsolated: true is SAFER → candidate widens if it turns it OFF while base had ON.
  if (base.networkIsolated && !candidate.networkIsolated) return true
  // osSandbox presence: any concrete kind (strength 1) SAFER than `none` (0).
  if (osSandboxStrength(base.osSandbox) > osSandboxStrength(candidate.osSandbox)) return true
  return false
}

/* ------------------------------------------------------------------------- */
/* Telemetry                                                                  */
/* ------------------------------------------------------------------------- */

/** Why a contribution was dropped — closed reason set (telemetry/audit key). */
export type ProvenanceDropKind =
  | "scalar-widen" // pillar value strictly wider than the trusted baseline
  | "allow-list-widen" // network allow-list adds a host beyond the baseline set
  | "sandbox-axis-widen" // sandbox loosens ONE protective sub-axis (sum may still be ≤ baseline)

/**
 * One typed telemetry record per DROPPED repo-controllable contribution. The
 * guard RETURNS these (it never emits) — the composition root wires the sink
 * (port inversion). `field` is the grant-capable pillar; `source` the precise
 * provenance; `kind` the closed reason; `detail` a human one-liner.
 */
export interface ProvenanceDropRecord {
  readonly kind: ProvenanceDropKind
  readonly field: GrantCapableField
  readonly source: ProvenanceSource
  readonly detail: string
}

/* ------------------------------------------------------------------------- */
/* The guard                                                                  */
/* ------------------------------------------------------------------------- */

export interface GuardOptions {
  /**
   * Disable the guard. SECURITY OPT-OUT — requires an EXPLICIT `true`. Mirrors
   * the ADR-0078 redaction opt-out: a deliberate operator acknowledgement, NOT
   * an env var (a hostile repo could set an env var; it cannot set this typed
   * call-site flag). When `true` the input layers pass through UNCHANGED and the
   * `dropped` list is empty.
   */
  readonly acknowledgedRisk?: boolean
}

export interface GuardResult {
  /** The layer list with widening repo-controllable contributions removed.
   *  When nothing was dropped this is the SAME array reference as the input
   *  (so a downstream merge is byte-identical to today). */
  readonly layers: ReadonlyArray<ProvenancedLayer>
  /** One record per dropped contribution (empty when nothing dropped / opted
   *  out). The caller forwards these to its telemetry sink. */
  readonly dropped: ReadonlyArray<ProvenanceDropRecord>
}

/**
 * The TRUSTED baseline a repo-controllable contribution is compared AGAINST for
 * a given field: the WIDEST value any NON-repo-controllable layer
 * (`per-user` / `team-admin` / `default`) sets for that field. A repo layer may
 * match or narrow that baseline (kept); it may NOT exceed it (dropped).
 *
 * Rationale: the user's own config (or admin policy) is the legitimate grant
 * authority. If NO trusted layer sets the field, the baseline rank is the
 * NARROWEST possible value for that field ({@link narrowestRankOf}) — a repo may
 * keep/narrow toward that floor (defense-in-depth) but may not exceed it (a repo
 * cannot bootstrap a GRANT from nothing).
 */
const trustedBaselineFor = (
  layers: ReadonlyArray<ProvenancedLayer>,
  field: GrantCapableField,
): { value: unknown; rank: number } | undefined => {
  let best: { value: unknown; rank: number } | undefined
  for (const layer of layers) {
    if (isRepoControllable(layer.source)) continue
    if (!(field in layer.value)) continue
    const value = (layer.value as Record<string, unknown>)[field]
    const rank = widenRankOf(field, value)
    if (best === undefined || rank > best.rank) best = { value, rank }
  }
  return best
}

/**
 * The NARROWEST (most restrictive) widen-rank for a field — the implicit floor
 * when NO trusted layer sets it. Reuses the SSOT polarities so it cannot drift:
 *   - approval — strictest mode (`always`, the max {@link APPROVAL_RANK}) with
 *     prompting on ⇒ `-APPROVAL_RANK.always` (no prompt-suppress bonus).
 *   - network  — `deny-all` ⇒ `NETWORK_RANK["deny-all"]` (= 0).
 *   - sandbox  — every protection present ⇒ 0 removed.
 * A repo contribution is a widen ONLY when it exceeds this floor, so a repo may
 * still set the SAFEST value (e.g. `deny-all`, strict approval) with no trusted
 * peer present (kept), while any loosening above the floor is dropped.
 */
const narrowestRankOf = (field: GrantCapableField): number => {
  switch (field) {
    case "approval":
      return -APPROVAL_RANK.always
    case "network":
      return NETWORK_RANK["deny-all"]
    case "sandbox":
      return 0
    default: {
      const _exhaustive: never = field
      return _exhaustive
    }
  }
}

/**
 * Decide whether ONE grant-capable pillar contribution from a repo-controllable
 * layer must be dropped. Returns the {@link ProvenanceDropRecord} when it widens
 * past the trusted baseline (scalar widen) OR appends a host beyond the
 * baseline allow-set (allow-list widen), else `undefined` (kept). Pure per-field
 * helper — keeps {@link filterRepoLayer} flat (low complexity).
 */
const dropReasonForField = (
  source: ProvenanceSource,
  field: GrantCapableField,
  candidate: unknown,
  allLayers: ReadonlyArray<ProvenancedLayer>,
): ProvenanceDropRecord | undefined => {
  const baseline = trustedBaselineFor(allLayers, field)
  const baseRank = baseline?.rank ?? narrowestRankOf(field)
  const candRank = widenRankOf(field, candidate)

  if (candRank > baseRank) {
    return {
      kind: "scalar-widen",
      field,
      source,
      detail:
        `dropped ${source} ${field} contribution: widen-rank ${candRank} ` +
        `exceeds ${baseline === undefined ? "narrowest floor" : "trusted baseline"} ${baseRank}`,
    }
  }

  if (field === "network") {
    const baseNet = baseline?.value as PermissionProfile["network"] | undefined
    if (allowListWidens(candidate as PermissionProfile["network"], baseNet)) {
      return {
        kind: "allow-list-widen",
        field,
        source,
        detail: `dropped ${source} network contribution: allow-list adds a host beyond the trusted baseline`,
      }
    }
  }

  // Sandbox is a 4-axis struct: the scalar sum compare above can be fooled by a
  // protection TRADE (sum stays ≤ baseline while one axis loosens). Catch the
  // per-axis widen the sum can't see (mirrors the allow-list set axis).
  if (field === "sandbox") {
    const baseSandbox = baseline?.value as PermissionProfile["sandbox"] | undefined
    if (sandboxAxisWidens(candidate as PermissionProfile["sandbox"], baseSandbox)) {
      return {
        kind: "sandbox-axis-widen",
        field,
        source,
        detail: `dropped ${source} sandbox contribution: loosens a protective sub-axis below the trusted baseline`,
      }
    }
  }

  return undefined
}

/**
 * Filter a repo-controllable layer's grant-capable pillars: keep any pillar
 * that is no-wider than the trusted baseline; DROP (delete the key from a copy)
 * any pillar that widens, recording a {@link ProvenanceDropRecord}. Non-grant
 * pillars pass through untouched. Returns the (possibly rebuilt) layer + drops.
 */
const filterRepoLayer = (
  layer: ProvenancedLayer,
  allLayers: ReadonlyArray<ProvenancedLayer>,
): { layer: ProvenancedLayer; dropped: ProvenanceDropRecord[] } => {
  const dropped: ProvenanceDropRecord[] = []
  let nextValue: Record<string, unknown> | undefined

  for (const field of GRANT_CAPABLE_FIELDS) {
    if (!(field in layer.value)) continue
    const candidate = (layer.value as Record<string, unknown>)[field]
    const dropReason = dropReasonForField(layer.source, field, candidate, allLayers)
    if (dropReason === undefined) continue
    // Lazily copy the layer's value the first time we must remove a key, so a
    // layer with NO drops keeps its original reference (byte-identical path).
    if (nextValue === undefined) nextValue = { ...(layer.value as Record<string, unknown>) }
    delete nextValue[field]
    dropped.push(dropReason)
  }

  if (nextValue === undefined) return { layer, dropped }
  return {
    layer: { source: layer.source, value: nextValue as Partial<PermissionProfile> },
    dropped,
  }
}

/**
 * Drop every repo-controllable contribution that WIDENS a grant-capable field
 * relative to the trusted (`per-user`/`team-admin`/`default`) baseline. Repo
 * contributions that NARROW (or match) a field are KEPT — defense-in-depth from
 * a repo is always safe. NON-repo layers are passed through untouched.
 *
 * Determinism: output depends only on the (source, value) content of the input
 * layers + the opt-out flag. Same inputs ⇒ deeply-equal output. When nothing is
 * dropped the SAME array reference is returned.
 *
 * @param layers the full layer list (trusted + repo-controllable), in any order.
 * @param options `acknowledgedRisk:true` disables the guard (typed opt-out).
 */
export const guardProvenance = (
  layers: ReadonlyArray<ProvenancedLayer>,
  options: GuardOptions = {},
): GuardResult => {
  // EXPLICIT typed opt-out — pass through unchanged (no drops). This is the ONLY
  // disable path; absent the flag the guard is ON (security default).
  if (options.acknowledgedRisk === true) {
    return { layers, dropped: [] }
  }

  const allDropped: ProvenanceDropRecord[] = []
  let mutated = false
  const out: ProvenancedLayer[] = []

  for (const layer of layers) {
    if (!isRepoControllable(layer.source)) {
      out.push(layer)
      continue
    }
    const { layer: filtered, dropped } = filterRepoLayer(layer, layers)
    if (dropped.length > 0) {
      mutated = true
      allDropped.push(...dropped)
    }
    out.push(filtered)
  }

  // Reference-identical output when nothing changed ⇒ downstream merge is
  // byte-identical to today.
  if (!mutated) return { layers, dropped: [] }
  return { layers: out, dropped: allDropped }
}
