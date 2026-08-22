import { createInMemoryPlanStore, type PlanStore } from "@/agent/plan/state"
import type { CliFeatureConfig } from "../cli-feature-config"

/** S3 plan-store wire — default-ON (see `parsePlanStoreEnv`: unset ⇒ enabled,
 *  so `/plan` + `/edit-plan` work out of the box; `QUANTA_PLAN_STORE=0/off/no`
 *  opts out). When enabled we mint an in-memory `PlanStore` and thread it
 *  through `SessionDeps` so the agent's plan tools mutate the SAME store the
 *  surface reads from — and so the focus-chain bridge (ADR-0219) can re-inject
 *  it. DO NOT flip this to default-OFF without re-checking the focus-chain
 *  wire: an absent planStore makes the todo re-injection inert. */
export const buildPlanStoreOrUndefined = (featureCfg: CliFeatureConfig): PlanStore | undefined => {
  if (!featureCfg.planStore.enabled) return undefined
  return createInMemoryPlanStore({ now: Date.now })
}
