/**
 * T-202 / F6 — bench stream tap (SSOT). Teeth on the observation contract:
 *  - editTargetOf reads the MUTATING_TOOL_TABLE `write_filesystem` set (not a
 *    private re-list) and pulls the right path field per tool,
 *  - firstEditFile is captured ONCE (first edit wins, never overwritten),
 *  - editCount counts only file-mutating calls (bash/test_runner excluded),
 *  - turnsToFirstEdit snapshots the turn at the first edit,
 *  - relFromSandbox relativizes absolute sandbox paths to gold-comparable form,
 *  - the tap forwards every event unchanged (pure pass-through).
 */
import { describe, expect, test } from "bun:test"
import { BenchStreamTap, editTargetOf, relFromSandbox } from "@/runner/batch/eval/stream-tap"
import type { AgentEvent, StreamPort } from "@/stream"

class Capture implements StreamPort {
  events: AgentEvent[] = []
  emit(e: AgentEvent): void {
    this.events.push(e)
  }
}

const toolCall = (name: string, input: unknown): AgentEvent => ({
  type: "tool_call",
  id: `c-${name}`,
  name,
  input,
})

describe("editTargetOf", () => {
  test("edit/write expose file_path", () => {
    expect(editTargetOf("edit", { file_path: "/s/a.py" })).toBe("/s/a.py")
    expect(editTargetOf("write", { file_path: "/s/b.py" })).toBe("/s/b.py")
  })

  test("apply_patch pulls first path from the V4A body", () => {
    const patch = "*** Begin Patch\n*** Update File: django/core/x.py\n@@\n-a\n+b\n*** End Patch"
    expect(editTargetOf("apply_patch", { patch })).toBe("django/core/x.py")
  })

  test("non-mutating tools (read/bash/test_runner) return undefined", () => {
    expect(editTargetOf("read", { file_path: "/s/a.py" })).toBeUndefined()
    expect(editTargetOf("bash", { command: "rm -rf x" })).toBeUndefined()
    expect(editTargetOf("test_runner", {})).toBeUndefined()
  })

  test("garbage input never throws, returns undefined", () => {
    expect(editTargetOf("edit", null)).toBeUndefined()
    expect(editTargetOf("edit", { file_path: 123 })).toBeUndefined()
  })
})

describe("relFromSandbox", () => {
  test("relativizes an absolute path under the sandbox to repo-relative", () => {
    expect(relFromSandbox("/tmp/sbx", "/tmp/sbx/django/core/x.py")).toBe("django/core/x.py")
  })
  test("an already-relative path is returned as-is (normalised)", () => {
    expect(relFromSandbox("/tmp/sbx", "django/core/x.py")).toBe("django/core/x.py")
  })
  test("a path outside the sandbox is kept raw (not guessed)", () => {
    expect(relFromSandbox("/tmp/sbx", "/other/y.py")).toBe("/other/y.py")
  })
  test("undefined stays undefined", () => {
    expect(relFromSandbox("/tmp/sbx", undefined)).toBeUndefined()
  })
})

describe("BenchStreamTap", () => {
  test("first edit wins; editCount counts only mutating; turnsToFirstEdit snapshots", () => {
    const down = new Capture()
    const tap = new BenchStreamTap(down)
    tap.emit({ type: "turn_start", turn: 1 })
    tap.emit(toolCall("read", { file_path: "/s/look.py" })) // not counted
    tap.emit({ type: "turn_start", turn: 2 })
    tap.emit(toolCall("edit", { file_path: "/s/first.py" })) // FIRST edit @ turn 2
    tap.emit({ type: "turn_start", turn: 3 })
    tap.emit(toolCall("write", { file_path: "/s/second.py" })) // 2nd edit
    tap.emit(toolCall("bash", { command: "pytest" })) // not an edit
    tap.emit(toolResult("bash", true, "2 passed", "pytest"))

    expect(tap.firstEditFile).toBe("/s/first.py") // not overwritten by second.py
    expect(tap.turnsToFirstEdit).toBe(2)
    expect(tap.editCount).toBe(2)
    expect(tap.lastVerifyCmd).toBe("pytest")
  })

  test("actionTrace records EVERY tool_call as `<tool> <target>` in order, bounded to the recent window", () => {
    const tap = new BenchStreamTap(new Capture())
    tap.emit(toolCall("read", { file_path: "/s/look.py" }))
    tap.emit(toolCall("edit", { file_path: "/s/core.py" }))
    tap.emit(toolCall("bash", { command: "pytest tests/foo.py" }))
    // Records actions (incl. read/bash, unlike editCount) with their detail.
    expect(tap.actionTrace).toEqual([
      "read /s/look.py",
      "edit /s/core.py",
      "bash pytest tests/foo.py",
    ])
  })

  test("actionTrace is capped (most-recent window) — never grows unbounded", () => {
    const tap = new BenchStreamTap(new Capture())
    for (let i = 0; i < 100; i++) tap.emit(toolCall("bash", { command: `echo ${i}` }))
    expect(tap.actionTrace.length).toBeLessThanOrEqual(40) // ACTION_TRACE_CAP
    // keeps the LATEST actions (the convergence tail), not the first.
    expect(tap.actionTrace.at(-1)).toBe("bash echo 99")
    expect(tap.actionTrace).not.toContain("bash echo 0")
  })

  test("onAction fires ONCE per tool_call with (name, detail) and still forwards downstream", () => {
    // The live per-action run.log line ("· <instance> <tool> <detail>") the bench
    // drivers wire on the 4th arg. RCA jun-25: this was wired ONLY on the verify-
    // select phase, so the single-pass path (most presets) logged coarse-only —
    // the full-remote run.log never showed the agent's per-turn actions. This locks
    // the mechanism the wiring depends on. Red-on-injection: fire on tool_result
    // instead of tool_call, or fire twice, and the expected sequence breaks.
    const down = new Capture()
    const seen: Array<{ name: string; detail: string }> = []
    const tap = new BenchStreamTap(down, undefined, undefined, (name, detail) => {
      seen.push({ name, detail })
    })
    tap.emit(toolCall("bash", { command: "pytest -q tests/foo.py" }))
    tap.emit(toolCall("edit", { file_path: "/s/django/core/x.py" }))
    tap.emit(toolResult("edit", true, "ok"))
    // one onAction per tool_call (NOT per tool_result), detail = actionDetailOf
    expect(seen).toEqual([
      { name: "bash", detail: "pytest -q tests/foo.py" },
      { name: "edit", detail: "/s/django/core/x.py" },
    ])
    // pure pass-through preserved: downstream still receives EVERY event
    expect(down.events.map((e) => e.type)).toEqual(["tool_call", "tool_call", "tool_result"])
  })

  test("WITHOUT onAction the tap is unaffected (4th arg optional, still forwards)", () => {
    const down = new Capture()
    const tap = new BenchStreamTap(down)
    tap.emit(toolCall("bash", { command: "ls" }))
    expect(down.events).toHaveLength(1)
  })

  test("no edits ⇒ firstEditFile/turnsToFirstEdit undefined, editCount 0", () => {
    const tap = new BenchStreamTap(new Capture())
    tap.emit({ type: "turn_start", turn: 1 })
    tap.emit(toolCall("read", { file_path: "/s/a.py" }))
    expect(tap.firstEditFile).toBeUndefined()
    expect(tap.turnsToFirstEdit).toBeUndefined()
    expect(tap.editCount).toBe(0)
  })

  test("T5 — sourceEditCount counts SOURCE edits only; test edits raise editCount but NOT sourceEditCount", () => {
    const tap = new BenchStreamTap(new Capture())
    tap.emit({ type: "turn_start", turn: 1 })
    tap.emit(toolCall("edit", { file_path: "/s/django/db/models/query.py" })) // SOURCE
    tap.emit(toolCall("edit", { file_path: "/s/tests/test_query.py" })) // test — not source
    tap.emit(toolCall("write", { file_path: "/s/reproduce_issue.py" })) // repro scaffold — not source
    tap.emit(toolCall("write", { file_path: "/s/reproduce_issue.py.pytest-report.json" })) // repro sidecar — not source
    tap.emit(
      toolCall("write", {
        file_path: "/s/__repro_0_12fc3620-8ad1-4f8f-90f0-2413027f18f8.py.pytest-report.json",
      }),
    ) // repro sidecar — not source
    tap.emit(toolCall("edit", { file_path: "django/core/management.py" })) // SOURCE (relative)
    expect(tap.editCount).toBe(6)
    expect(tap.sourceEditCount).toBe(2)
  })

  test("MAJOR-A regression: an in-tree path containing a `tmp` segment STILL counts as source (no /tmp string arm)", () => {
    // sourceOnlyDiff has no /tmp rule; the count-predicate must not invent one or
    // it false-excludes in-tree files and (worse) collapses to 0 for a /tmp-rooted
    // sandbox, re-creating the laundered-infra confound.
    const tap = new BenchStreamTap(new Capture())
    tap.emit({ type: "turn_start", turn: 1 })
    tap.emit(toolCall("edit", { file_path: "astropy/io/tmp/reader.py" })) // in-tree 'tmp' dir
    tap.emit(toolCall("edit", { file_path: "/tmp/work/sbx-abc/django/db/models/query.py" })) // /tmp-rooted sandbox
    expect(tap.sourceEditCount).toBe(2)
  })

  test("T5 — a test-ONLY run has editCount>0 but sourceEditCount===0 (must NOT classify as lost-edits)", () => {
    const tap = new BenchStreamTap(new Capture())
    tap.emit({ type: "turn_start", turn: 1 })
    tap.emit(toolCall("edit", { file_path: "/s/tests/test_x.py" }))
    tap.emit(toolCall("edit", { file_path: "/s/pkg/tests/test_models.py" }))
    expect(tap.editCount).toBe(2)
    expect(tap.sourceEditCount).toBe(0)
  })

  test("T5 — failed/blocked edit attempts do NOT count as applied source edits", () => {
    const tap = new BenchStreamTap(new Capture())
    tap.emit({ type: "turn_start", turn: 1 })
    tap.emit(toolCall("edit", { file_path: "/s/django/db/models/query.py" }))
    tap.emit(toolResult("edit", false, "localize-phase-blocked"))
    expect(tap.editCount).toBe(1)
    expect(tap.sourceEditCount).toBe(1)
    expect(tap.appliedEditCount).toBe(0)
    expect(tap.sourceAppliedEditCount).toBe(0)
  })

  test("T5 — only successful source edit results drive sourceAppliedEditCount", () => {
    const tap = new BenchStreamTap(new Capture())
    tap.emit({ type: "turn_start", turn: 1 })
    tap.emit(toolCall("edit", { file_path: "/s/django/db/models/query.py" }))
    tap.emit(toolResult("edit", true, "applied"))
    tap.emit(toolCall("write", { file_path: "/s/tests/test_query.py" }))
    tap.emit(toolResult("write", true, "written"))
    expect(tap.editCount).toBe(2)
    expect(tap.sourceEditCount).toBe(1)
    expect(tap.appliedEditCount).toBe(2)
    expect(tap.sourceAppliedEditCount).toBe(1)
  })

  test("M3 — sourceEditCount AGREES with sourceOnlyDiff's keep rule (app/tests.py + .pyi count; repro scaffold does not)", () => {
    const tap = new BenchStreamTap(new Capture())
    tap.emit({ type: "turn_start", turn: 1 })
    tap.emit(toolCall("edit", { file_path: "/s/app/tests.py" })) // django: NOT /tests/, NOT test_* ⇒ source
    tap.emit(toolCall("edit", { file_path: "/s/pkg/stubs.pyi" })) // stub ⇒ source (survives the diff)
    tap.emit(toolCall("write", { file_path: "/s/reproduce_issue.py" })) // repro scaffold ⇒ NOT source
    tap.emit(toolCall("write", { file_path: "/s/reproduce_issue.py.pytest-report.json" })) // repro sidecar ⇒ NOT source
    tap.emit(toolCall("edit", { file_path: "/s/x/tests/test_y.py" })) // real test ⇒ NOT source
    expect(tap.editCount).toBe(5)
    expect(tap.sourceEditCount).toBe(2)
  })

  test("pure pass-through: every event reaches downstream unchanged", () => {
    const down = new Capture()
    const tap = new BenchStreamTap(down)
    const evs: AgentEvent[] = [
      { type: "turn_start", turn: 1 },
      toolCall("edit", { file_path: "/s/x.py" }),
      { type: "error", message: "boom" },
    ]
    for (const e of evs) tap.emit(e)
    expect(down.events).toEqual(evs)
    expect(tap.lastErrorMessage).toBe("boom")
  })

  test("test_runner command comes from tool_result evidence, not a sentinel tool name", () => {
    const tap = new BenchStreamTap(new Capture())
    tap.emit(toolCall("test_runner", {}))
    expect(tap.lastVerifyCmd).toBeUndefined()
    tap.emit(
      toolResult(
        "test_runner",
        false,
        "1 failed",
        "uvx --python 3.8 --with pytest pytest tests/test_x.py -k repro",
      ),
    )
    expect(tap.lastVerifyCmd).toBe("uvx --python 3.8 --with pytest pytest tests/test_x.py -k repro")
  })

  test("verify-shaped bash command comes from tool_result evidence, not tool_call text", () => {
    const tap = new BenchStreamTap(new Capture())
    tap.emit(toolCall("bash", { command: "python -m pytest tests/x.py" }))
    expect(tap.lastVerifyCmd).toBeUndefined()
    tap.emit(toolResult("bash", false, "1 failed", "python -m pytest tests/x.py"))
    expect(tap.lastVerifyCmd).toBe("python -m pytest tests/x.py")
  })

  test("bench-authoritative verifier command is captured even when it is not regex-test-like", () => {
    const cmd = `node -e "const {add}=require('./math.js'); if(add(2,3)!==5) process.exit(1)"`
    const tap = new BenchStreamTap(new Capture(), undefined, [cmd])
    tap.emit(toolCall("bash", { command: cmd }))
    tap.emit(toolResult("bash", false, "", cmd))
    expect(tap.lastVerifyCmd).toBe(cmd)
  })

  test("bash without executedCommand evidence does not become validator cmd", () => {
    const tap = new BenchStreamTap(new Capture())
    tap.emit(toolCall("bash", { command: "python -m pytest tests/x.py" }))
    tap.emit(toolResult("bash", false, "permission denied"))
    expect(tap.lastVerifyCmd).toBeUndefined()
  })

  test("non-verify bash never becomes validator cmd even if it executed", () => {
    const tap = new BenchStreamTap(new Capture())
    tap.emit(toolCall("bash", { command: "ls -la" }))
    tap.emit(toolResult("bash", true, "ok", "ls -la"))
    expect(tap.lastVerifyCmd).toBeUndefined()
  })
})

// P0 — verify-pass detection (tentative-patch retention). The tap fires
// `onVerifyPass` exactly when a VERIFY tool_result comes back passing, so the
// driver can snapshot a verified-green candidate. Teeth: pass fires, fail/
// failing-output/non-verify do NOT, and absent callback is byte-identical.
const toolResult = (
  name: string,
  ok: boolean,
  preview = "",
  executedCommand?: string,
): AgentEvent => ({
  type: "tool_result",
  id: `c-${name}`,
  name,
  ok,
  preview,
  ...(executedCommand !== undefined ? { executedCommand } : {}),
})

describe("BenchStreamTap verify-pass (P0)", () => {
  const run = (events: AgentEvent[]): { fired: number; forwarded: number } => {
    const cap = new Capture()
    let fired = 0
    const tap = new BenchStreamTap(cap, () => {
      fired += 1
    })
    for (const e of events) tap.emit(e)
    return { fired, forwarded: cap.events.length }
  }

  test("test_runner PASS → fires once", () => {
    expect(
      run([
        toolCall("test_runner", {}),
        toolResult(
          "test_runner",
          true,
          "2 passed",
          "uvx --python 3.8 --with pytest pytest tests/test_x.py -k repro",
        ),
      ]).fired,
    ).toBe(1)
  })

  test("test_runner FAIL (ok:false) → does NOT fire", () => {
    expect(run([toolCall("test_runner", {}), toolResult("test_runner", false)]).fired).toBe(0)
  })

  test("test_runner ok:true but FAILING OUTPUT → does NOT fire", () => {
    expect(
      run([toolCall("test_runner", {}), toolResult("test_runner", true, "1 failed, 3 passed")])
        .fired,
    ).toBe(0)
  })

  test("test_runner ok:true but plural error summary → does NOT fire", () => {
    expect(
      run([
        toolCall("test_runner", {}),
        toolResult("test_runner", true, "1 passed, 2 errors", "pytest tests/x.py"),
      ]).fired,
    ).toBe(0)
  })

  test("test_runner ok:true but ANSI-colored FAIL output → does NOT fire", () => {
    expect(
      run([
        toolCall("test_runner", {}),
        toolResult(
          "test_runner",
          true,
          "\u001b[31mFAIL\u001b[0m  tests/x.test.ts",
          "vitest run tests/x.test.ts",
        ),
      ]).fired,
    ).toBe(0)
  })

  test("bash test-like command (pytest) PASS → fires", () => {
    expect(
      run([
        toolCall("bash", { command: "python -m pytest tests/x.py" }),
        toolResult("bash", true, "2 passed", "python -m pytest tests/x.py"),
      ]).fired,
    ).toBe(1)
  })

  test("test_runner PASS without executedCommand evidence → does NOT fire", () => {
    expect(
      run([toolCall("test_runner", {}), toolResult("test_runner", true, "2 passed")]).fired,
    ).toBe(0)
  })

  test("bash background placeholder (ok:true, still running) → does NOT fire", () => {
    expect(
      run([
        toolCall("bash", {
          command: "python -m pytest tests/x.py",
          timeout_behavior: "background",
        }),
        toolResult(
          "bash",
          true,
          "[bash background] shellId=sh-1 status=running\n(deadline 100ms elapsed)",
        ),
      ]).fired,
    ).toBe(0)
  })

  test("bash NON-test command PASS → does NOT fire", () => {
    expect(run([toolCall("bash", { command: "ls -la" }), toolResult("bash", true)]).fired).toBe(0)
  })

  test("an edit tool result → does NOT fire (only verifies count)", () => {
    expect(run([toolCall("edit", { file_path: "/s/a.py" }), toolResult("edit", true)]).fired).toBe(
      0,
    )
  })

  test("multiple verifies → fires once each (seq advances)", () => {
    expect(
      run([
        toolCall("test_runner", {}),
        toolResult("test_runner", true, "2 passed", "pytest tests/a.py"),
        toolCall("test_runner", {}),
        toolResult("test_runner", true, "2 passed", "pytest tests/b.py"),
      ]).fired,
    ).toBe(2)
  })

  test("RED-on-injection: NO callback → never fires, forwards EVERY event unchanged (byte-identical)", () => {
    const cap = new Capture()
    const tap = new BenchStreamTap(cap) // no onVerifyPass
    const events = [toolCall("test_runner", {}), toolResult("test_runner", true)]
    for (const e of events) tap.emit(e)
    expect(cap.events).toEqual(events) // pure pass-through, no crash
  })
})
