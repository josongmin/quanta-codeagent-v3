/** Default-ON public preset. Explicit public opt-out and internal overrides win. */
export const applyGoalPreset = (
  env: Record<string, string | undefined>,
  enabled: boolean,
): void => {
  if (!enabled) return
  for (const key of [
    "QUANTA_OBJECTIVE_TOOLS",
    "QUANTA_GOAL_ENFORCE",
    "QUANTA_OBJECTIVE_BUDGET_ENFORCE",
  ] as const) {
    if (env[key] === undefined) env[key] = "1"
  }
}
