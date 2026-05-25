import { createInMemoryPlanStore, type PlanStore } from "@/agent/plan/state"
import type { CliFeatureConfig } from "../cli-feature-config"

/** S3 plan-store wire — default-OFF. The `/plan` slash command prints
 *  "not wired" unless `QUANTA_PLAN_STORE=1` is set (opt-in). When opt-in,
 *  we mint an in-memory `PlanStore` and thread it through `SessionDeps` so
 *  the agent's plan tools mutate the SAME store the surface reads from. */
export const buildPlanStoreOrUndefined = (featureCfg: CliFeatureConfig): PlanStore | undefined => {
  if (!featureCfg.planStore.enabled) return undefined
  return createInMemoryPlanStore({ now: Date.now })
}
