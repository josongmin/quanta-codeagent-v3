/**
 * ADR-0081 L4 surface coverage — `composeShellObservers` fan-out semantics
 * + the CLI's `buildShellStreamPainter` + observability's
 * `buildShellOtelObserver`. The three modules together let CLI / OTel
 * exporter / future IDE share a single shell-event stream without re-buffering.
 */
import { describe, expect, test } from "bun:test"
import { buildShellOtelObserver, Metrics } from "@/observability"
import { composeShellObservers, type ShellExecEvent, type ShellExecObserver } from "@/tool"
import { buildShellStreamPainter } from "../../src/apps/cli/shell-stream-painter"

const enc = new TextEncoder()
const startEv: ShellExecEvent = {
  kind: "start",
  pid: 42,
  command: "echo hi",
  cwd: "/tmp",
  startedAt: 0,
}
const stdoutEv = (s: string, offset = 0): ShellExecEvent => ({
  kind: "stdout",
  chunk: enc.encode(s),
  offset,
})
const stderrEv = (s: string, offset = 0): ShellExecEvent => ({
  kind: "stderr",
  chunk: enc.encode(s),
  offset,
})
const exitEv = (code: number | null = 0): ShellExecEvent => ({
  kind: "exit",
  code,
  signal: null,
  exitedAt: 1,
})
const abortEv = (reason: "user_abort" | "timeout"): ShellExecEvent => ({
  kind: "aborted",
  reason,
  abortedAt: 1,
})

// =====================================================================
// composeShellObservers — fan-out + tolerant-of-throws contract.
// =====================================================================
describe("composeShellObservers", () => {
  test("fans every event to every observer in argument order", () => {
    const calls: string[] = []
    const a: ShellExecObserver = (e) => calls.push(`a:${e.kind}`)
    const b: ShellExecObserver = (e) => calls.push(`b:${e.kind}`)
    const composed = composeShellObservers(a, b)
    composed(startEv)
    composed(exitEv())
    expect(calls).toEqual(["a:start", "b:start", "a:exit", "b:exit"])
  })

  test("throws in one observer are swallowed; later observers still fire", () => {
    const calls: string[] = []
    const boom: ShellExecObserver = () => {
      throw new Error("boom")
    }
    const ok: ShellExecObserver = (e) => calls.push(`ok:${e.kind}`)
    const composed = composeShellObservers(boom, ok)
    expect(() => composed(startEv)).not.toThrow()
    expect(calls).toEqual(["ok:start"])
  })

  test("undefined entries are dropped — no NPE in the loop", () => {
    const calls: string[] = []
    const ok: ShellExecObserver = (e) => calls.push(e.kind)
    const composed = composeShellObservers(undefined, ok, undefined)
    composed(startEv)
    expect(calls).toEqual(["start"])
  })

  test("zero observers produces a callable no-op (legal value)", () => {
    const composed = composeShellObservers()
    expect(() => composed(startEv)).not.toThrow()
  })
})

// =====================================================================
// buildShellOtelObserver — counter vocabulary + per-event semantics.
// =====================================================================
describe("buildShellOtelObserver", () => {
  test("start increments `shell.exec.runs`; stdout/stderr add chunks + bytes", () => {
    const m = new Metrics()
    const obs = buildShellOtelObserver(m)
    obs(startEv)
    obs(stdoutEv("hello"))
    obs(stdoutEv(" world"))
    obs(stderrEv("err"))
    const snap = m.snapshot()
    expect(snap.counters["shell.exec.runs"]).toBe(1)
    expect(snap.counters["shell.exec.stdout.chunks"]).toBe(2)
    expect(snap.counters["shell.exec.stdout.bytes"]).toBe(11) // "hello" + " world"
    expect(snap.counters["shell.exec.stderr.chunks"]).toBe(1)
    expect(snap.counters["shell.exec.stderr.bytes"]).toBe(3)
  })

  test("exit code tallies under `shell.exec.exits.<code>` (or `null`)", () => {
    const m = new Metrics()
    const obs = buildShellOtelObserver(m)
    obs(exitEv(0))
    obs(exitEv(1))
    obs(exitEv(0))
    obs(exitEv(null))
    const snap = m.snapshot()
    expect(snap.counters["shell.exec.exits.0"]).toBe(2)
    expect(snap.counters["shell.exec.exits.1"]).toBe(1)
    expect(snap.counters["shell.exec.exits.null"]).toBe(1)
  })

  test("aborts tally under `shell.exec.aborts.<reason>`", () => {
    const m = new Metrics()
    const obs = buildShellOtelObserver(m)
    obs(abortEv("user_abort"))
    obs(abortEv("timeout"))
    obs(abortEv("user_abort"))
    const snap = m.snapshot()
    expect(snap.counters["shell.exec.aborts.user_abort"]).toBe(2)
    expect(snap.counters["shell.exec.aborts.timeout"]).toBe(1)
  })
})

// =====================================================================
// buildShellStreamPainter — CLI surface formatting.
// =====================================================================
describe("buildShellStreamPainter", () => {
  const buildWith = (color: boolean): { lines: string[]; obs: ShellExecObserver } => {
    const lines: string[] = []
    const obs = buildShellStreamPainter({ write: (s: string) => lines.push(s), color })
    return { lines, obs }
  }

  test("start writes a `[shell] $ <command>` boundary line", () => {
    const { lines, obs } = buildWith(false)
    obs(startEv)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe("[shell] $ echo hi\n")
  })

  test("stdout chunks decode UTF-8 and pass through verbatim (no extra newline)", () => {
    const { lines, obs } = buildWith(false)
    obs(stdoutEv("hello "))
    obs(stdoutEv("world"))
    expect(lines.join("")).toBe("hello world")
  })

  test("stderr chunks are written (red+dim when color on, plain when off)", () => {
    const { lines, obs } = buildWith(false)
    obs(stderrEv("oops"))
    expect(lines.join("")).toBe("oops")
    const { lines: colored, obs: cobs } = buildWith(true)
    cobs(stderrEv("oops"))
    expect(colored.join("")).toContain("\x1b[31m")
    expect(colored.join("")).toContain("\x1b[2m")
    expect(colored.join("")).toContain("oops")
  })

  test("split-multibyte UTF-8 across chunks decodes cleanly (stream:true semantics)", () => {
    const { lines, obs } = buildWith(false)
    const full = enc.encode("한글")
    const split = 2
    obs({ kind: "stdout", chunk: full.slice(0, split), offset: 0 })
    obs({ kind: "stdout", chunk: full.slice(split), offset: split })
    expect(lines.join("")).toBe("한글")
  })

  test("exit writes `[shell] exit code=N` (and signal when set)", () => {
    const { lines, obs } = buildWith(false)
    obs(exitEv(0))
    expect(lines.at(-1)).toBe("[shell] exit code=0\n")
    const { lines: l2, obs: o2 } = buildWith(false)
    o2({ kind: "exit", code: null, signal: "SIGTERM", exitedAt: 1 })
    expect(l2.at(-1)).toBe("[shell] exit code=null signal=SIGTERM\n")
  })

  test("aborted writes `[shell] aborted (reason)`", () => {
    const { lines, obs } = buildWith(false)
    obs(abortEv("timeout"))
    expect(lines.at(-1)).toBe("[shell] aborted (timeout)\n")
  })

  test("label prefix is injected into boundary lines (not stdout/stderr chunks)", () => {
    const lines: string[] = []
    const labeled = buildShellStreamPainter({
      write: (s: string) => lines.push(s),
      color: false,
      label: "scenario-04",
    })
    labeled(startEv)
    labeled(stdoutEv("raw"))
    labeled(exitEv(0))
    expect(lines).toEqual([
      "[scenario-04] [shell] $ echo hi\n",
      "raw",
      "[scenario-04] [shell] exit code=0\n",
    ])
  })
})

// =====================================================================
// Integration — paint + OTel composed.
// =====================================================================
describe("composed painter + otel", () => {
  test("a real run fans into both consumers without one breaking the other", () => {
    const lines: string[] = []
    const painter = buildShellStreamPainter({
      write: (s: string) => lines.push(s),
      color: false,
    })
    const m = new Metrics()
    const otel = buildShellOtelObserver(m)
    const composed = composeShellObservers(painter, otel)
    composed(startEv)
    composed(stdoutEv("ok\n"))
    composed(exitEv(0))
    expect(lines).toEqual(["[shell] $ echo hi\n", "ok\n", "[shell] exit code=0\n"])
    const snap = m.snapshot()
    expect(snap.counters["shell.exec.runs"]).toBe(1)
    expect(snap.counters["shell.exec.stdout.chunks"]).toBe(1)
    expect(snap.counters["shell.exec.exits.0"]).toBe(1)
  })
})
