/**
 * OTel-bound `PatchTracePort` adapter (ADR-0028 vocabulary).
 *
 * Maps each categorical `PatchObservation` from the pure `@/patch` applier onto
 * the canonical `quanta.patch.*` keys and records them through the active span
 * sink via `recordAttrs`. This is the SINGLE runtime binding between the patch
 * applier and `@/observability`; injecting it (closed-port DI) is what lets
 * `@/patch` stay a pure leaf with NO `@/observability` value import.
 *
 * Default-OFF byte-identity: `recordAttrs` short-circuits to a zero-allocation
 * no-op when no span sink is registered, so wiring this port with no sink
 * active is observationally identical to passing no port at all.
 *
 * Security invariant: ONLY the categorical op + fuzzy tier scalars are emitted
 * — NEVER patch text, anchor strings, hunk content, or file paths. The
 * `PatchObservation` contract (in `@/patch`) carries nothing else.
 */

import { attrs } from "../attrs"
import { recordAttrs, SPAN_NAMES } from "../spans"
import { QUANTA_ATTRS } from "../vocabulary"

/**
 * Structural mirror of `@/patch`'s `PatchObservation` — the categorical per-op
 * event the applier surfaces. Re-declared locally (NOT imported) so this slice
 * has ZERO dependency on `@/patch`: the dependency direction is strictly
 * `@/tool/apply-patch → { @/patch, @/observability/patch-trace }`, never the
 * reverse. The shapes are duck-compatible; the `apply_patch` composition root
 * binds this adapter to the real `PatchTracePort` parameter at the call site,
 * where the structural identity is checked by `tsc`. If `@/patch`'s observation
 * shape ever drifts, that call site fails to type-check — the contract is
 * defended there, not by a cross-slice import here. */
type PatchObservation =
  | { readonly op: "add" | "delete" | "update" | "move" }
  | {
      readonly op: "update" | "move"
      readonly fuzzyMatchTier: "exact" | "whitespace" | "fuzzy"
    }

/** Structural mirror of `@/patch`'s `PatchTracePort` (see note above). */
interface PatchTracePort {
  recordPatchOp(event: PatchObservation): void
}

/**
 * Build the production `PatchTracePort`. Pass this to `applyPatch(patch, fs,
 * observer, trace)` at the composition root (the `apply_patch` tool) so the
 * `quanta.patch.*` vocabulary is activated. Stateless — a single shared
 * instance is sufficient.
 */
export const otelPatchTracePort = (): PatchTracePort => ({
  recordPatchOp(event: PatchObservation): void {
    if ("fuzzyMatchTier" in event) {
      recordAttrs(
        SPAN_NAMES.handleToolCall,
        attrs({
          [QUANTA_ATTRS.patch.op]: event.op,
          [QUANTA_ATTRS.patch.fuzzyMatchTier]: event.fuzzyMatchTier,
          [QUANTA_ATTRS.patch.fuzzyMatched]: event.fuzzyMatchTier !== "exact",
        }),
      )
      return
    }
    recordAttrs(SPAN_NAMES.handleToolCall, attrs({ [QUANTA_ATTRS.patch.op]: event.op }))
  },
})
