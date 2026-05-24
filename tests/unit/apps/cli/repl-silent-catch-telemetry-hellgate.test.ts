/**
 * `swallowAndLog` hellgate — failure-isolation + telemetry contract.
 *
 * Pre-cleanup, three REPL call sites used bare `catch {}` to swallow
 * failures (indicator port / skills callback / rule inventory). The fix
 * keeps the swallow but emits a `slog.warn` so a broken pill or scan no
 * longer disappears silently from the observability stream.
 *
 * Pinned invariants:
 *   1. With slog present, exactly one `warn(event, { error: <msg> })` is emitted.
 *   2. With slog undefined, the helper is a no-op (does NOT throw).
 *   3. A throwing sink does NOT propagate (the swallow contract still holds).
 *   4. Stack traces are NOT included in the structured fields.
 *   5. The 3 canonical event keys are honored verbatim — a future drift breaks
 *      this test before it reaches production.
 */

import { describe, expect, test } from "bun:test"
import { StructuredLogger } from "@/observability"
import { swallowAndLog } from "../../../../src/apps/cli/repl-silent-catch"

interface CapturedRecord {
  level: string
  event: string
  fields: Record<string, unknown>
}

const captureLogger = (): {
  slog: StructuredLogger
  records: CapturedRecord[]
} => {
  const records: CapturedRecord[] = []
  const slog = new StructuredLogger({
    level: "debug",
    sink: (line) => {
      const parsed = JSON.parse(line)
      records.push({ level: parsed.level, event: parsed.event, fields: parsed.fields })
    },
  })
  return { slog, records }
}

describe("swallowAndLog — emits structured warn with error message", () => {
  test("indicator failure emits repl.indicator_failure event", () => {
    const { slog, records } = captureLogger()
    swallowAndLog(slog, "repl.indicator_failure", new Error("boom"))
    expect(records).toHaveLength(1)
    expect(records[0]?.level).toBe("warn")
    expect(records[0]?.event).toBe("repl.indicator_failure")
    expect(records[0]?.fields.error).toBe("boom")
  })

  test("skills callback failure emits repl.skills_callback_failure", () => {
    const { slog, records } = captureLogger()
    swallowAndLog(slog, "repl.skills_callback_failure", new Error("disk err"))
    expect(records).toHaveLength(1)
    expect(records[0]?.event).toBe("repl.skills_callback_failure")
    expect(records[0]?.fields.error).toBe("disk err")
  })

  test("rule inventory failure emits repl.rule_inventory_failure", () => {
    const { slog, records } = captureLogger()
    swallowAndLog(slog, "repl.rule_inventory_failure", new Error("perm denied"))
    expect(records).toHaveLength(1)
    expect(records[0]?.event).toBe("repl.rule_inventory_failure")
    expect(records[0]?.fields.error).toBe("perm denied")
  })

  test("non-Error rejection (string) stringified safely", () => {
    const { slog, records } = captureLogger()
    swallowAndLog(slog, "repl.indicator_failure", "raw string err")
    expect(records[0]?.fields.error).toBe("raw string err")
  })

  test("non-Error rejection (null) does not throw", () => {
    const { slog, records } = captureLogger()
    expect(() => swallowAndLog(slog, "repl.indicator_failure", null)).not.toThrow()
    expect(records).toHaveLength(1)
  })

  test("no stack traces leak into structured fields", () => {
    const { slog, records } = captureLogger()
    const e = new Error("with stack")
    swallowAndLog(slog, "repl.indicator_failure", e)
    expect(records[0]?.fields.error).toBe("with stack")
    expect("stack" in (records[0]?.fields ?? {})).toBe(false)
  })
})

describe("swallowAndLog — failure isolation", () => {
  test("undefined slog is a no-op (does not throw)", () => {
    expect(() => swallowAndLog(undefined, "repl.indicator_failure", new Error("boom"))).not.toThrow()
  })

  test("throwing sink swallowed — outer catch contract preserved", () => {
    const slog = new StructuredLogger({
      level: "debug",
      sink: () => {
        throw new Error("sink exploded")
      },
    })
    expect(() => swallowAndLog(slog, "repl.indicator_failure", new Error("boom"))).not.toThrow()
  })
})
