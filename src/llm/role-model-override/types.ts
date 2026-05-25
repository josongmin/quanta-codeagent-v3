/**
 * Role-based model override types (ADR-0256).
 *
 * Roo Code orchestrator's per-role model selector. Adds a sub-task /
 * "dispatched-role" axis orthogonal to ADR-0212's workflow-phase
 * (mode → modelId) axis. The two compose at the composition root:
 *
 *   stickyId = await stickyResolver.resolve({ mode, globalDefault })
 *   modelId  = roleResolver.resolve(role, stickyId)
 *
 * Role is a CLOSED union — adding a new role is a compile-failure that
 * forces every host's exhaustiveness switch to update. ModelId is a
 * narrow string alias (kept loose because the LLM provider list grows
 * faster than a hard-coded enum can keep up).
 */

import { QuantaError } from "@/shared"

/** The closed enumeration of orchestrator dispatch roles. Modeled after
 *  Roo Code's orchestrator role labels:
 *    - `plan-writer` — deep-reasoning model picks the plan
 *    - `executor`    — fast minimal-diff model carries out edits
 *    - `reviewer`    — checks the executor's work (often a different
 *                      provider for adversarial coverage)
 *    - `explorer`    — read-only repo navigation / retrieval
 *    - `default`     — the fallback role when none of the above fit */
export type Role = "plan-writer" | "executor" | "reviewer" | "explorer" | "default"

/** Provider model identifier. Intentionally a string alias — LLM
 *  provider catalogs grow faster than a hard-coded enum can keep up,
 *  and the resolver does not validate the identifier (that is the
 *  adapter's job). The ONLY validation is the non-empty check in
 *  {@link RoleModelResolver.setOverride}. */
export type ModelId = string

/** Result of {@link RoleModelResolver.setOverride}. Symmetric with
 *  ADR-0212's `StickyModelSetResult` shape — `ok` discriminates success
 *  vs. a recorded typed error. The error is a {@link QuantaError}
 *  subclass so the caller's typed-error union holds. */
export type SetOverrideResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: OverrideError }

/** Override rejection — currently a single code (`empty-model`) but
 *  modeled as a QuantaError subclass so future codes (e.g.
 *  `invalid-role`, `model-not-allowlisted`) can be added without a
 *  breaking shape change. The constructor is inherited from
 *  {@link QuantaError} verbatim (`(code, message, options?)`); a
 *  delegating override would trigger `noUselessConstructor`. */
export class OverrideError extends QuantaError {}
