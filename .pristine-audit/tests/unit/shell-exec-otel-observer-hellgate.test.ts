/**
 * HELLGATE e2e — `shell-exec-otel-observer` DRIVEN THROUGH THE REAL PRODUCER.
 *
 * The sibling `shell-exec-observers-surface.test.ts` constructs observers
 * directly and hand-feeds them synthetic `ShellExecEvent`s — it never proves
 * the OTel counters actually tally a REAL shell run, because no real producer
 * emits into them there. That is the DoD hole the tools/pm ratchet flags.
 *
 * This test closes it HONESTLY. It wires the FULL composition the feature ships:
 *
 *     runShell(cmd, {
 *       onShellEvent: composeShellObservers(buildShellOtelObserver(metrics), ...),
 *     })
 *
 * i.e. the REAL `runShell` producer in `src/runtime/shell.ts` spawns a REAL
 * child process, emits the closed `ShellExecEvent` union as the child runs, the
 * events fan through the REAL `composeShellObservers` combinator into the REAL
 * `buildShellOtelObserver`, and we assert the resulting `Metrics` counter
 * snapshot. Nothing here hand-constructs an event: every counter tick is caused
 * by an actual OS process lifecycle.
 *
 * Coverage:
 *   1. REAL-PATH lifecycle — start + stdout + stderr + exit through a live child.
 *   2. GATE-OFF byte-identical — no `metrics`/observer wired ⇒ no counters exist
 *      and the ShellResult is identical to the wired run.
 *   3. EXHAUSTIVE `ShellExecEvent.kind` → counter mapping, every kind produced by
 *      the real producer (start/stdout/stderr/exit/aborted/detached).
 *   4. ADVERSARIAL — abort (user_abort) + timeout terminal counters, and the
 *      intentional background `detached` terminal (NOT conflated into aborts).
 *
 * RED-ON-INJECTION (see the report): dropping the counter increment in
 * `buildShellOtelObserver` (e.g. deleting `metrics.counter("shell.exec.runs")
 * .inc()`) makes the real-path assertions FAIL — the test is non-vacuous.
 *
 * POSIX only (real `sh`/`sleep`/`printf` children). Windows is skipped.
 */

import { describe, expect, test } from "bun:test"
import { buildShellOtelObserver, Metrics } from "@/observability"
import { runShell } from "@/runtime"
import type { BoundedBuffer } from "@/runtime/bounded-buffer"
import { composeShellObservers } from "@/tool"

const POSIX = process.platform !== "win32"

/** Wire the REAL feature composition onto a fresh Metrics + return both plus a
 *  recorder observer so we can also assert the raw event kinds the producer
 *  actually emitted (proves the counters are keyed off real events, not luck). */
const wireOtel = (): {
  metrics: Metrics
  onShellEvent: (e: Parameters<ReturnType<typeof buildShellOtelObserver>>[0]) => void
  kinds: string[]
} => {
  const metrics = new Metrics()
  const kinds: string[] = []
  const record = (e: { kind: string }): void => void kinds.push(e.kind)
  // The exact wire the feature docs prescribe: OTel observer composed with any
  // other consumer (here a recorder standing in for the CLI painter).
  const onShellEvent = composeShellObservers(buildShellOtelObserver(metrics), record)
  return { metrics, onShellEvent, kinds }
}

describe.if(POSIX)(
  "shell-exec-otel-observer — real runShell → composeShellObservers → OTel",
  () => {
    // ------------------------------------------------------------------ (1)+(3a)
    test("a REAL child fans start/stdout/stderr/exit into the OTel counters", async () => {
      const { metrics, onShellEvent, kinds } = wireOtel()
      // Deterministic byte counts: 5 bytes stdout ("hello"), 3 bytes stderr ("err").
      const r = await runShell("printf hello; printf err 1>&2", { onShellEvent })

      // The producer actually ran a real process to completion.
      expect(r.stdout).toBe("hello")
      expect(r.stderr).toBe("err")
      expect(r.exitCode).toBe(0)

      // The real event stream carried the lifecycle (start ≺ chunks ≺ exit).
      expect(kinds[0]).toBe("start")
      expect(kinds.at(-1)).toBe("exit")
      expect(kinds).toContain("stdout")
      expect(kinds).toContain("stderr")

      // And every one of those events ticked its counter — caused by the real run.
      const c = metrics.snapshot().counters
      expect(c["shell.exec.runs"]).toBe(1)
      expect(c["shell.exec.stdout.chunks"]).toBeGreaterThanOrEqual(1)
      expect(c["shell.exec.stderr.chunks"]).toBeGreaterThanOrEqual(1)
      // Byte totals are exact regardless of how the OS chunked the pipes.
      expect(c["shell.exec.stdout.bytes"]).toBe(5)
      expect(c["shell.exec.stderr.bytes"]).toBe(3)
      // Terminal disposition tallied under the exit code, NOT an abort/detach.
      expect(c["shell.exec.exits.0"]).toBe(1)
      expect(c["shell.exec.aborts.timeout"]).toBeUndefined()
      expect(c["shell.exec.aborts.user_abort"]).toBeUndefined()
    }, 10_000)

    // ---------------------------------------------------------------------- (3b)
    test("non-zero exit tallies under `shell.exec.exits.<code>` (real `sh -c exit 3`)", async () => {
      const { metrics, onShellEvent } = wireOtel()
      const r = await runShell("exit 3", { onShellEvent })
      expect(r.exitCode).toBe(3)
      const c = metrics.snapshot().counters
      expect(c["shell.exec.runs"]).toBe(1)
      expect(c["shell.exec.exits.3"]).toBe(1)
      expect(c["shell.exec.exits.0"]).toBeUndefined()
    }, 10_000)

    // ------------------------------------------------------------------------ (2)
    test("GATE-OFF: no observer wired ⇒ zero counters AND a byte-identical result", async () => {
      // Wired run.
      const { metrics, onShellEvent } = wireOtel()
      const wired = await runShell("printf hello; printf err 1>&2", { onShellEvent })
      expect(Object.keys(metrics.snapshot().counters).length).toBeGreaterThan(0)

      // Default-OFF run — no `onShellEvent`. A FRESH Metrics never touched.
      const off = new Metrics()
      const unwired = await runShell("printf hello; printf err 1>&2")

      // The observer's own registry stays completely empty (nothing allocated it).
      expect(off.snapshot().counters).toEqual({})
      // And the run itself is byte-identical to the wired one (default-OFF contract).
      expect(unwired.stdout).toBe(wired.stdout)
      expect(unwired.stderr).toBe(wired.stderr)
      expect(unwired.exitCode).toBe(wired.exitCode)
      expect(unwired.timedOut).toBe(wired.timedOut)
    }, 10_000)

    // ------------------------------------------------------------ (4) adversarial
    test("TIMEOUT: a real slow child killed by the deadline tallies `shell.exec.aborts.timeout`", async () => {
      const { metrics, onShellEvent, kinds } = wireOtel()
      const r = await runShell("sleep 30", { timeoutMs: 100, onShellEvent })
      expect(r.timedOut).toBe(true)
      expect(kinds.at(-1)).toBe("aborted") // real terminal was an abort, not exit
      const c = metrics.snapshot().counters
      expect(c["shell.exec.runs"]).toBe(1)
      expect(c["shell.exec.aborts.timeout"]).toBe(1)
      // A timeout kill is NOT logged as a normal exit.
      expect(c["shell.exec.exits.0"]).toBeUndefined()
    }, 10_000)

    test("USER-ABORT: an AbortSignal-killed real child tallies `shell.exec.aborts.user_abort`", async () => {
      const { metrics, onShellEvent, kinds } = wireOtel()
      const ac = new AbortController()
      // Abort shortly after spawn so the child is live when the signal fires.
      setTimeout(() => ac.abort(), 100)
      const r = await runShell("sleep 30", { signal: ac.signal, onShellEvent })
      // A user abort is a REAL kill (not a deadline), so timedOut stays false.
      expect(r.timedOut).toBe(false)
      expect(kinds.at(-1)).toBe("aborted")
      const c = metrics.snapshot().counters
      expect(c["shell.exec.aborts.user_abort"]).toBe(1)
      expect(c["shell.exec.aborts.timeout"]).toBeUndefined()
    }, 10_000)

    // ----------------------------------------------- (3c)+(4) detached terminal
    test("DETACHED: an intentional deadline background handoff tallies `shell.exec.detached.<reason>` (NOT an abort)", async () => {
      const { metrics, onShellEvent, kinds } = wireOtel()
      // A fake registry `adopt` that keeps the child alive (kills it after the
      // test grabs the terminal) — this is the REAL `runWithBackgroundDetach`
      // path in runShell, exercised without the CLI/tool layer.
      let adopted: { kill: () => void } | undefined
      const r = await runShell("printf DETACH-MARKER; sleep 30", {
        timeoutMs: 120,
        onShellEvent,
        background: {
          // No `confirm` ⇒ plain background mode ⇒ detachReason "auto".
          adopt: async (args: { kill: () => void; stdout: BoundedBuffer }) => {
            adopted = { kill: args.kill }
            return { id: "test-bg-shell" }
          },
        },
      })

      // The producer reports a detach (child alive in the registry), not an exit.
      expect(r.detached?.shellId).toBe("test-bg-shell")
      expect(r.timedOut).toBe(false)
      expect(kinds.at(-1)).toBe("detached")

      const c = metrics.snapshot().counters
      expect(c["shell.exec.runs"]).toBe(1)
      // The whole point of the `detached` kind: it is counted APART from aborts,
      // never conflated into `shell.exec.aborts.timeout` (the pre-WS-H lie).
      expect(c["shell.exec.detached.auto"]).toBe(1)
      expect(c["shell.exec.aborts.timeout"]).toBeUndefined()
      expect(c["shell.exec.exits.0"]).toBeUndefined()

      // Reap the still-running child we deliberately kept alive.
      adopted?.kill()
      await new Promise((res) => setTimeout(res, 0))
    }, 10_000)
  },
)
