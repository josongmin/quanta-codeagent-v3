import { describe, expect, it } from "vitest"
import type { TaskRecord } from "@/subagent"
import { toAgentFleetRow } from "./slash-surface"

/**
 * hellaudit HIGH (2026-07-15): the CLI `/agents` panel reads RAW `TaskRecord`s
 * from `TaskRegistry.list()` — a DIFFERENT path from the redacted event stream
 * the web panel consumes. A subagent that echoes a secret into its description /
 * final response / error would print it verbatim. `toAgentFleetRow` is the SoT
 * seam where records become CLI rows, so it MUST scrub. These pins are the
 * red-on-injection witness: revert the `scrubAgentText` calls and each fails.
 */
const SECRET = "sk-ant-api03-LEAKLEAKLEAKLEAKLEAKLEAKLEAKLEAKLEAKLEAK"

const rec = (over: Partial<TaskRecord>): TaskRecord => ({
  id: "t-1",
  description: "benign task",
  status: "completed",
  startedAt: 0,
  depth: 0,
  ...over,
})

describe("toAgentFleetRow — secret redaction (CLI /agents no-leak)", () => {
  it("scrubs a secret in the description", () => {
    const row = toAgentFleetRow(rec({ description: `investigate ${SECRET} now` }))
    expect(row.description).not.toContain(SECRET)
  })

  it("scrubs a secret in the final response text", () => {
    const row = toAgentFleetRow(
      rec({ result: { ok: true, finalText: `found key ${SECRET}`, turns: 3 } }),
    )
    expect(row.result?.finalText).not.toContain(SECRET)
  })

  it("scrubs a secret in the error message", () => {
    const row = toAgentFleetRow(rec({ status: "failed", error: `boom ${SECRET}` }))
    expect(row.error).not.toContain(SECRET)
  })

  it("leaves benign text untouched (non-vacuous — not scrubbing everything)", () => {
    const row = toAgentFleetRow(rec({ description: "refactor the parser module" }))
    expect(row.description).toBe("refactor the parser module")
  })
})
