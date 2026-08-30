/** No-throw decoder for the daemon-owned browser objective verification request. */
export interface GoalVerifyRequest {
  readonly requestId: string
  readonly expectedObjectiveRevision: number
}

const record = (raw: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export const peekGoalVerifyEnvelope = (raw: string): Record<string, unknown> | null => {
  const value = record(raw)
  return value?.kind === "goalVerify" ? value : null
}

export const peekGoalVerify = (raw: string): GoalVerifyRequest | null => {
  const value = peekGoalVerifyEnvelope(raw)
  if (value === null || typeof value.requestId !== "string" || value.requestId.length === 0) {
    return null
  }
  if (
    typeof value.expectedObjectiveRevision !== "number" ||
    !Number.isSafeInteger(value.expectedObjectiveRevision) ||
    value.expectedObjectiveRevision < 0
  ) {
    return null
  }
  return {
    requestId: value.requestId,
    expectedObjectiveRevision: value.expectedObjectiveRevision,
  }
}
