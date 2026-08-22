/**
 * §4.4 — TYPED agent kind: `SubagentType` SSOT + boundary classification.
 *
 * The subagent's `agentType` was a FREE STRING (`subagent/types.ts`). The audit
 * (§4.4) and the Claude-Code corpus both want a closed set of WELL-KNOWN kinds
 * plus a NORMALIZING boundary validator that classifies a requested type as
 * `well-known | custom | empty` — the SOTA mechanism behind CC's
 * `tengu_subagent_type_normalized` / `…_miss` telemetry (a requested type is
 * lower-cased + trimmed, matched against the available set, and only on a true
 * miss does the spawn fail). We keep BACK-COMPAT via a typed-or-string union:
 * an unrecognised string is STILL a valid `agentType` (a custom/named-agent),
 * so the gate-OFF path is byte-identical and the gate-ON path only REJECTS a
 * type that is neither well-known NOR a registered custom name.
 *
 * PURE LEAF: no imports, no IO, no clock — a deterministic classifier the
 * boundary (agent-tool) consults. Slice isolation preserved (`@/subagent` may
 * only reach `@/tool`/`@/shared`; this file reaches neither).
 */

/** Single source of truth for the well-known subagent kinds. The
 *  {@link SubagentType} union is DERIVED from this, so any consumer that needs
 *  the runtime values reuses THIS list — no second hand-maintained copy.
 *
 *  - `general`: the default fork (no specialised persona) — the value the
 *    legacy ABSENT `agentType` conceptually maps to.
 *  - `explore` / `plan` / `review` / `edit`: the coarse role personas the
 *    named-agent registry + `taskKind` derivation already lean on. */
export const SUBAGENT_KINDS = ["general", "explore", "plan", "review", "edit"] as const

/** The closed set of well-known kinds. */
export type SubagentType = (typeof SUBAGENT_KINDS)[number]

/** Typed-or-string union — a WELL-KNOWN kind OR any custom (named-agent) name.
 *  The `string & {}` arm keeps editor autocompletion for the well-known kinds
 *  while still accepting an arbitrary string (back-compat: a `.quanta/agents`
 *  custom name is not in {@link SUBAGENT_KINDS} yet is a valid `agentType`). */
export type SubagentAgentType = SubagentType | (string & {})

/** Classification of a requested agent type at the boundary. */
export type AgentTypeClass =
  /** Empty/whitespace/absent — conceptually the `general` fork. */
  | { readonly kind: "empty" }
  /** A normalised match to a well-known {@link SubagentType}. `canonical` is the
   *  lower-cased SSOT member; `requested` is the raw input (for telemetry). */
  | { readonly kind: "well-known"; readonly canonical: SubagentType; readonly requested: string }
  /** Not a well-known kind. `requested` is the raw input; `normalized` is the
   *  trimmed/lower-cased form a custom-name registry should be matched against. */
  | { readonly kind: "custom"; readonly requested: string; readonly normalized: string }

const WELL_KNOWN_SET: ReadonlySet<string> = new Set(SUBAGENT_KINDS)

/** Type guard — is `s` exactly a well-known {@link SubagentType}? (no
 *  normalisation; for callers that already hold a canonical value). */
export const isSubagentType = (s: string): s is SubagentType => WELL_KNOWN_SET.has(s)

/**
 * Normalise + classify a requested `agentType`. NO-THROW, total over all input.
 *
 *   - `undefined`/empty/whitespace ⇒ `{ kind: "empty" }`.
 *   - trimmed+lower-cased value that is a well-known kind ⇒ `well-known`
 *     (mirrors CC's `tengu_subagent_type_normalized`: a `"Plan"` request maps
 *     to canonical `"plan"`).
 *   - otherwise ⇒ `custom` (a possibly-registered named-agent — NOT a miss yet;
 *     the boundary decides whether a custom name is allowed).
 */
export const classifyAgentType = (raw: string | undefined): AgentTypeClass => {
  if (raw === undefined) return { kind: "empty" }
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { kind: "empty" }
  const normalized = trimmed.toLowerCase()
  if (WELL_KNOWN_SET.has(normalized)) {
    return { kind: "well-known", canonical: normalized as SubagentType, requested: raw }
  }
  return { kind: "custom", requested: raw, normalized }
}

/** Boundary-validation outcome. `accepted` carries the value the spawn should
 *  USE (the canonical well-known form, or the raw custom string); `rejected`
 *  carries a one-line reason for a typed error at the boundary. */
export type AgentTypeValidation =
  | {
      readonly ok: true
      readonly value: string | undefined
      readonly classification: AgentTypeClass
    }
  | { readonly ok: false; readonly reason: string; readonly classification: AgentTypeClass }

export interface ValidateAgentTypeOpts {
  /** When false (DEFAULT-OFF / gate absent), validation NEVER rejects — every
   *  input is accepted as-is, byte-identical to the legacy free-string path. */
  readonly enforce?: boolean
  /** The set of registered CUSTOM agent-type names (e.g. the named-agent
   *  registry's keys), against which a `custom` classification is checked when
   *  `enforce` is on. Compared case-INSENSITIVELY (normalised). Absent/empty ⇒
   *  no custom names are known, so under enforcement a non-well-known type is a
   *  MISS. */
  readonly knownCustom?: readonly string[]
}

/**
 * Validate a requested `agentType` at the spawn boundary.
 *
 * DEFAULT-OFF byte-identity: with `enforce` falsy (gate absent), the result is
 * ALWAYS `{ ok: true, value: raw }` — the field flows exactly as the legacy
 * free string (no normalisation applied to the carried value, no rejection).
 *
 * ENFORCED (`enforce: true`): a well-known kind is accepted (and CANONICALISED
 * to its SSOT spelling); a `custom` kind is accepted iff it matches a
 * `knownCustom` name (case-insensitively) — otherwise it is REJECTED with a
 * `subagent_type_not_found`-style reason (CC's `…_miss`). `empty` is always
 * accepted (⇒ the general fork; carried value is `undefined`).
 */
export const validateAgentType = (
  raw: string | undefined,
  opts: ValidateAgentTypeOpts = {},
): AgentTypeValidation => {
  const classification = classifyAgentType(raw)
  if (opts.enforce !== true) {
    // Default-OFF: carry the raw value untouched (byte-identical legacy path).
    return { ok: true, value: raw, classification }
  }
  if (classification.kind === "empty") {
    return { ok: true, value: undefined, classification }
  }
  if (classification.kind === "well-known") {
    // Canonicalise to the SSOT spelling (CC `…_normalized`).
    return { ok: true, value: classification.canonical, classification }
  }
  // custom — accept only if registered.
  const known = new Set((opts.knownCustom ?? []).map((n) => n.trim().toLowerCase()))
  if (known.has(classification.normalized)) {
    return { ok: true, value: classification.requested, classification }
  }
  const wellKnownList = SUBAGENT_KINDS.join(", ")
  return {
    ok: false,
    reason: `unknown agent_type '${classification.requested}': not a well-known kind (${wellKnownList}) and no matching custom agent is registered`,
    classification,
  }
}
