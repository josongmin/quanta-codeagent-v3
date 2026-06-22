import { describe, expect, it } from "bun:test"
import {
  classifyReportText,
  collectRunDiagnostics,
} from "@/apps/bench/remote/box-session"

type SpawnResult = { code: number; stdout: string; stderr: string }
const ok = (stdout = ""): SpawnResult => ({ code: 0, stdout, stderr: "" })

// #9: a non-empty-but-corrupt report must be distinguishable from "no report".
describe("classifyReportText (#9)", () => {
  it("empty / whitespace ⇒ empty", () => {
    expect(classifyReportText("")).toBe("empty")
    expect(classifyReportText("   \n\t")).toBe("empty")
  })
  it("valid JSON ⇒ ok", () => {
    expect(classifyReportText('{"resolved":["a"]}')).toBe("ok")
  })
  it("non-empty but invalid JSON (truncated/half-flushed) ⇒ unparseable, NOT empty", () => {
    expect(classifyReportText('{"resolved":["a−trunca')).toBe("unparseable")
    expect(classifyReportText("not json at all")).toBe("unparseable")
  })
})

// #8: the throttle signal that drives ALL backoff must be detected even when the
// 429 storm scrolled out of the last 60 lines of the run log.
describe("collectRunDiagnostics full-log throttle scan (#8)", () => {
  const THROTTLE_LINE = "responses-stream: generation_error rate_limit (429) backing off"

  it("detects a throttle marker that is ONLY in the full-log grep, not the tail", async () => {
    // tail -60 returns clean grading output (the 429 happened earlier and
    // scrolled away); the full-log grep surfaces the buried throttle line.
    const ssh = async (cmd: string): Promise<SpawnResult> => {
      if (cmd.startsWith("tail -60")) return ok("instance 12/16 graded OK\ninstance 13/16 graded OK")
      if (cmd.includes("grep -aiE")) return ok(`${THROTTLE_LINE}\n`)
      return ok()
    }
    const diag = await collectRunDiagnostics({
      ssh,
      runLogPath: "~/run.log",
      latestLogLine: undefined,
      remoteRunCode: 0,
      emptyVerdicts: false,
      log: () => {},
    })
    expect(diag.rateLimited).toBe(true)
  })

  it("paired control: clean tail AND clean full-log grep ⇒ not rate-limited", async () => {
    const ssh = async (cmd: string): Promise<SpawnResult> => {
      if (cmd.startsWith("tail -60")) return ok("instance 16/16 graded OK\nall done")
      if (cmd.includes("grep -aiE")) return ok("") // grep found nothing in the whole log
      return ok()
    }
    const diag = await collectRunDiagnostics({
      ssh,
      runLogPath: "~/run.log",
      latestLogLine: undefined,
      remoteRunCode: 0,
      emptyVerdicts: false,
      log: () => {},
    })
    expect(diag.rateLimited).toBe(false)
  })
})
