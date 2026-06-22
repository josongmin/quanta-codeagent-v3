import type { RepairReproOutcome } from "./types"

export const MARKER_REPRODUCED = "Issue reproduced"
export const MARKER_RESOLVED = "Issue resolved"
export const MARKER_OTHER = "Other issues"

export const classifyReproOutcome = (stdout: string, code: number): RepairReproOutcome => {
  const s = typeof stdout === "string" ? stdout : ""
  const iReproduced = s.lastIndexOf(MARKER_REPRODUCED)
  const iResolved = s.lastIndexOf(MARKER_RESOLVED)
  const iOther = s.lastIndexOf(MARKER_OTHER)
  const max = Math.max(iReproduced, iResolved, iOther)
  if (max < 0) return code !== 0 ? "exec_failed" : "unknown"
  if (max === iResolved) return "resolved"
  if (max === iReproduced) return "reproduced"
  return "other"
}
