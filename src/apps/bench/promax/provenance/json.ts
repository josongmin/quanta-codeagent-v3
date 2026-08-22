/** PMX-00 internal helpers — value shape description and bounded failure lists. */
import type { ProMaxFailure, ProMaxFailureCode } from "./types"

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * Describe a rejected value WITHOUT echoing it. Row values may be gold-bearing
 * (`patch`, `test_patch`, `eval_script`), so a refusal reports the TYPE and,
 * for short scalars only, the value — never a corpus blob.
 */
export const describeValue = (v: unknown): string => {
  if (v === undefined) return "absent"
  if (v === null) return "null"
  if (Array.isArray(v)) return `array(${v.length})`
  if (typeof v === "string")
    return v.length <= 40 ? `string ${JSON.stringify(v)}` : `string(${v.length} chars)`
  if (typeof v === "object") return "object"
  return `${typeof v} ${JSON.stringify(v)}`
}

/**
 * A failure sink that keeps refusals readable: at most {@link PER_CODE_LIMIT}
 * detailed failures per code, then ONE summary per code counting the rest.
 * Capping is per-code precisely so a flood of one defect can never hide a
 * different defect's code from the verdict.
 */
export const PER_CODE_LIMIT = 8

export interface FailureSink {
  add(code: ProMaxFailureCode, message: string): void
  drain(): readonly ProMaxFailure[]
}

export const createFailureSink = (): FailureSink => {
  const kept: ProMaxFailure[] = []
  const total = new Map<ProMaxFailureCode, number>()
  return {
    add(code, message) {
      const seen = total.get(code) ?? 0
      total.set(code, seen + 1)
      if (seen < PER_CODE_LIMIT) kept.push({ code, message })
    },
    drain() {
      const overflow: ProMaxFailure[] = []
      for (const [code, count] of total) {
        if (count > PER_CODE_LIMIT) {
          overflow.push({
            code,
            message: `...and ${count - PER_CODE_LIMIT} further \`${code}\` defect(s) (${count} total)`,
          })
        }
      }
      return [...kept, ...overflow]
    },
  }
}
