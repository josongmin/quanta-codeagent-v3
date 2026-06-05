/**
 * C6 (RFC `jun-6-deny-reason-surfacing`) — the structured "why was this denied"
 * value record + its sanitized-by-construction builder.
 *
 * Why this module exists
 * ----------------------
 * Today a permission denial reaches the model as a free-form prose string
 * (`"Permission denied: <prose>"`) and the typed `ToolFailure.permission_denied`
 * envelope carries only `{mode, isReadonly}` — NO machine-classifiable signal
 * for *which policy layer* or *which security pillar* refused the action. The
 * model must string-match English to classify a deny, which is the retry-thrash
 * failure mode. C6 surfaces a typed {@link StructuredDenyReason} so the model
 * (and a human debugging a deny) can branch on the deciding `layer` / `pillar`.
 *
 * THE NO-LEAK BOUNDARY (the core design constraint)
 * -------------------------------------------------
 * The structured reason carries NOTHING the OTel/recorder path doesn't already
 * expose. This is enforced *by construction*, not by hope:
 *
 *   - {@link StructuredDenyReason.safeReason} is NOT a new string composed from
 *     raw input. The builder takes the SAME sanitized one-liner the caller
 *     already passes to `emitGateDecision({reason})` (the recorder), which the
 *     contract (`recorder.ts:98-125`, `policy.ts:84-98`,
 *     `admissibility-gate.ts:255-258`) guarantees is scrubbed of regex sources,
 *     `action.input`, file/env values, and matched HARD_DENY rule names. The
 *     structured surface therefore can never exceed the already-safe OTel
 *     surface.
 *   - The HARD_DENY case is the one subtlety: the model-facing prose `content`
 *     MAY echo the agent's OWN command back (`"Blocked dangerous command:
 *     <cmd>"`) — acceptable, the agent authored it — but the LOGGED/structured
 *     `safeReason` MUST be the categorical form so the debug log never persists
 *     the raw command. {@link hardDenySafeReason} produces that categorical
 *     form; callers MUST use it (never the raw `hardDenyReason()` string) for
 *     the structured field.
 *
 * Slice rules: pure value module. Imports ONLY slice-local enums from this
 * package (`./recorder` for `PermissionStackSource`, `./permission-profile` for
 * the pillar axis). No IO, no state, no `Date.now`/`Math.random`/`process.env`.
 *
 * Related: RFC §4.1/§4.4, ADR-0135 (4-pillar taxonomy), ADR-0046 (stack axis).
 */

import type { PermissionStackSource } from "./recorder"

/**
 * Which subsystem refused the action — maps 1:1 from the deny SITE (each
 * `deny(...)` call in `admissibility-gate.ts` knows its own layer). Unlike
 * {@link DenyPillar}, `layer` is ALWAYS unambiguous — it is the deny site, not
 * an inference — so it is the reliable signal the model can branch on.
 *
 *   - `hard-deny`     — HARD_DENY denylist hit (dangerous command). Terminal.
 *   - `stack`         — the per-thread / per-host / global-default policy stack
 *                       (`evaluateStack`).
 *   - `reviewer`      — guardian / user reviewer refusal (guardian_denied,
 *                       user_denied, user_aborted).
 *   - `hook`          — a `pre_tool_use` hook returned a deny.
 *   - `tool-profile`  — the active tool-profile (ADR-0213) refused / failed to
 *                       resolve the tool.
 *   - `mode`          — an agent mode (plan / readonly) structurally blocked the
 *                       mutating tool.
 *   - `broker`        — the team-coordination broker SOFT-denied (capability B).
 */
export type DenyLayer =
  | "hard-deny"
  | "stack"
  | "reviewer"
  | "hook"
  | "tool-profile"
  | "mode"
  | "broker"

/** All {@link DenyLayer} values as a runtime tuple — exhaustive enumeration in
 *  tests / mapping code without re-declaring the union. */
export const DENY_LAYERS = [
  "hard-deny",
  "stack",
  "reviewer",
  "hook",
  "tool-profile",
  "mode",
  "broker",
] as const satisfies ReadonlyArray<DenyLayer>

/**
 * The 4-pillar security axis (ADR-0135 / `permission-profile.ts`) the deny
 * implicates, when derivable. Best-effort: OMITTED (never `undefined`-set, see
 * exactOptionalPropertyTypes) when inference is ambiguous — a WRONG pillar is
 * worse than no pillar (it could mislead the model). The four profile pillars
 * are approval / network / sandbox / control; `fileSystem` is the
 * file-system-sandbox layer (`permission-profile.ts:2`, the AND-conditioned
 * first layer) surfaced alongside them.
 */
export type DenyPillar = "fileSystem" | "network" | "sandbox" | "control" | "approval"

/** All {@link DenyPillar} values as a runtime tuple. */
export const DENY_PILLARS = [
  "fileSystem",
  "network",
  "sandbox",
  "control",
  "approval",
] as const satisfies ReadonlyArray<DenyPillar>

/**
 * The structured "why was this denied" value record. Value-only (no functions,
 * no live refs) so it is safe to log, attach to the `ToolFailure` envelope,
 * serialize for trajectory replay, and compare structurally.
 *
 * `safeReason` is the SANITIZED one-liner — the SAME value the caller passes to
 * the recorder. The builder ({@link structuredDenyReason}) is the only intended
 * construction path; it forces the caller to pass that already-safe string.
 */
export interface StructuredDenyReason {
  /** Always `"deny"` — this record exists only for refusals. */
  readonly verdict: "deny"
  /** Which subsystem refused (the deny SITE). Always present, unambiguous. */
  readonly layer: DenyLayer
  /** The 4-pillar axis when derivable; OMITTED (exactOptional) when ambiguous. */
  readonly pillar?: DenyPillar
  /** The recorder's stack-axis enum, reused verbatim, when the deny came from
   *  the policy stack; OMITTED otherwise. */
  readonly stackSource?: PermissionStackSource
  /** The SAME sanitized one-liner the recorder receives. NEVER raw input /
   *  command text / regex source — sanitized by the producing site, surfaced
   *  here verbatim. */
  readonly safeReason: string
}

/** Builder input. `pillar` / `stackSource` are optional; passing `undefined`
 *  (or omitting) yields a record with the key OMITTED, never set to
 *  `undefined` — matching the snapshot/exactOptional discipline elsewhere in
 *  the slice. */
export interface StructuredDenyReasonInput {
  readonly layer: DenyLayer
  /** The already-sanitized one-liner (the recorder's `reason`). The builder
   *  surfaces this verbatim — it composes NO new string from raw input. */
  readonly safeReason: string
  readonly pillar?: DenyPillar | undefined
  readonly stackSource?: PermissionStackSource | undefined
}

/**
 * Build a {@link StructuredDenyReason}. The ONLY intended construction path.
 *
 * No-leak guarantee: `safeReason` is taken verbatim from the caller, which the
 * deny-site contract requires to be the SAME value passed to the recorder
 * (already scrubbed). The builder NEVER reads `action.input`, a command string,
 * or a regex source — it has no access to them. Optional fields are OMITTED
 * (not `undefined`-set) when absent, so a `toEqual({verdict, layer, safeReason})`
 * passes for a pillar-less deny.
 */
export const structuredDenyReason = (input: StructuredDenyReasonInput): StructuredDenyReason => ({
  verdict: "deny",
  layer: input.layer,
  safeReason: input.safeReason,
  ...(input.pillar !== undefined ? { pillar: input.pillar } : {}),
  ...(input.stackSource !== undefined ? { stackSource: input.stackSource } : {}),
})

/**
 * The CATEGORICAL safe-reason for a HARD_DENY hit — used for the
 * structured/LOGGED `safeReason` so the raw command is NEVER persisted.
 *
 * The model-facing prose `content` may still echo the agent's own command (it
 * authored it; `policy.ts:66` `"Blocked dangerous command: <cmd>"`); but the
 * structured field that flows to the log / `DecisionEvent` / OTel surface uses
 * THIS categorical form. This split is the §4.4 subtlety and is asserted by
 * hellgate.
 *
 * It takes NO command argument by design — there is nothing to leak.
 */
export const hardDenySafeReason = (): string => "blocked dangerous command (pattern hit)"

/**
 * Render the compact, knob-gated model-facing tag prefixed onto the deny
 * `content` when the feature is on (RFC §4.3). Purely additive — the caller
 * prepends this to the existing prose, never replaces it. Derived ONLY from the
 * categorical `layer` / `pillar` fields (no `safeReason`, no raw text), so the
 * prefix itself can carry no sensitive content.
 *
 *   `[denied · layer=stack · pillar=network] `
 *   `[denied · layer=reviewer] `   (pillar omitted)
 *
 * Trailing space so the caller writes `denyContentPrefix(r) + prose`.
 */
export const denyContentPrefix = (reason: StructuredDenyReason): string => {
  const pillar = reason.pillar !== undefined ? ` · pillar=${reason.pillar}` : ""
  return `[denied · layer=${reason.layer}${pillar}] `
}
