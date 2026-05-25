/**
 * Default delegation-runner port (ADR-0283).
 *
 * The {@link TypedDelegationRunner} port is the host's bridge to the actual
 * child-agent execution path. The default impl (`default-runner.ts`) spawns
 * a real child agent instance and returns a {@link BoomerangResult}; the
 * headless stub (`headless-stub.ts`) returns a deterministic result without
 * spawning anything.
 *
 * Plane-clean: imports only `@/agent/subagent-typed` (for the boomerang
 * shape). No `@/agent/loop`, no `@/agent/dispatch`, no `@/llm`, no `@/tool`.
 *
 * Default-OFF: the loop never constructs a runner; surfaces (apps / future
 * `/delegate` slash) opt in by wiring one through `AgentConfig.delegation`.
 *
 * Contracts (5):
 *   1. NO-THROW on the public surface for operational failures — every
 *      failure surfaces as `BoomerangResult { ok:false, errorKind:... }`
 *      via the typed-delegation boomerang shape. The runner builds a
 *      success or a failure boomerang; it never throws across the port.
 *   2. DEPTH ENFORCEMENT — `spec.depth ≥ MAX_DEPTH` ⇒ immediate failure
 *      boomerang with `errorKind:"runner-error"` and message containing
 *      `depth-exceeded`. NO spawn.
 *   3. SPEC VALIDATION — empty prompt / non-finite budget / negative budget
 *      ⇒ immediate failure boomerang with `errorKind:"runner-error"` +
 *      message containing `spec-invalid`. NO spawn.
 *   4. CANCELLATION — `spec.signal.aborted === true` at call ⇒ immediate
 *      failure boomerang with `errorKind:"cancelled"`. Mid-run abort ⇒
 *      same after the child unwinds.
 *   5. exactOptionalPropertyTypes — every optional field is OMITTED when
 *      absent.
 */

import type { BoomerangResult } from "@/agent/subagent-typed"
import type { DelegateSpec } from "./types"

/** Closed port — single method. The host injects ONE function (or the
 *  full `DelegationRunnerPort` object when it wants explicit naming);
 *  the loop never reads from this slice directly. */
export interface DelegationRunnerPort {
  /** Run a child agent under `spec` and return the typed boomerang. NEVER
   *  throws for operational failures — every error surfaces in the result. */
  delegate(spec: DelegateSpec): Promise<BoomerangResult>
}
