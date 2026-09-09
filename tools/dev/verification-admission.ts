export type AdmissionDecision =
  | { readonly kind: "admitted"; readonly remainingMs: number }
  | { readonly kind: "deferred"; readonly reason: string; readonly remainingMs: number }
  | { readonly kind: "cancelled"; readonly remainingMs: number }

export interface AdmissionBudget {
  readonly deadlineMs: number
  readonly now: () => number
}

export const ADMISSION_DEADLINE_ENV = "QUANTA_ADMISSION_DEADLINE_MS"

export const admissionFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  now: () => number = () => Date.now(),
): AdmissionBudget | undefined => {
  const raw = env[ADMISSION_DEADLINE_ENV]
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined
  return { deadlineMs: Number.parseInt(raw, 10), now }
}

export const remainingBudgetMs = (budget: AdmissionBudget): number =>
  Math.max(0, budget.deadlineMs - budget.now())

export const consumeWait = (budget: AdmissionBudget, requestedMs: number): AdmissionDecision => {
  const remaining = remainingBudgetMs(budget)
  if (remaining <= 0) return { kind: "deferred", reason: "budget-exhausted", remainingMs: 0 }
  return { kind: "admitted", remainingMs: Math.min(remaining, requestedMs) }
}
