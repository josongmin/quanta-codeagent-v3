export const BASE_SEED = 0x9e3779b9
export const GIT_CASES = 60
export const CANARY_INDICES = [0, 7, 13, 21, 34, 59] as const
const CANARY_SET = new Set<number>(CANARY_INDICES)
export const NIGHTLY_INDICES: readonly number[] = Array.from(
  { length: GIT_CASES },
  (_, index) => index,
).filter((index) => !CANARY_SET.has(index))

export const gitFuzzCaseId = (index: number): string => `git-fuzz-${index}`

export const gitFuzzUniverseIds = (): readonly string[] =>
  Array.from({ length: GIT_CASES }, (_, index) => gitFuzzCaseId(index))

export const gitFuzzCanaryIds = (): readonly string[] =>
  CANARY_INDICES.map((index) => gitFuzzCaseId(index))

export const gitFuzzNightlyIds = (): readonly string[] =>
  NIGHTLY_INDICES.map((index) => gitFuzzCaseId(index))
