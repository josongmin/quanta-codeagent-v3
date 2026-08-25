/** Public opt-in preset. Explicit internal overrides always win. */
export const applyGoalPreset = (env: NodeJS.ProcessEnv): void => {
  if (env.QUANTA_GOAL !== "1") return
  for (const key of [
    "QUANTA_OBJECTIVE_TOOLS",
    "QUANTA_GOAL_ENFORCE",
    "QUANTA_OBJECTIVE_BUDGET_ENFORCE",
  ] as const) {
    if (env[key] === undefined) env[key] = "1"
  }
}
