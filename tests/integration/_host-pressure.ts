/**
 * Keep internal integration-test deadlines aligned with the authoritative
 * shard runner's bounded host-pressure multiplier. Invalid or out-of-contract
 * values fail closed to the normal 1x budget.
 */
export const hostPressureTimeoutScale = (): number => {
  const parsed = Number(process.env.QUANTA_TEST_TIMEOUT_SCALE ?? "1")
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 5 ? parsed : 1
}

export const pressureScaledTimeoutMs = (baseMs: number): number =>
  baseMs * hostPressureTimeoutScale()
