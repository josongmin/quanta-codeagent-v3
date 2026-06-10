/**
 * E-spawner silent-failure hellgate (audit jun-10 finding #10) — the stdout
 * pump's settlement promise was DISCARDED at the spawn site, so a dead pump
 * with a LIVE child wedged every consumer permanently: `exitPromise` never
 * settled, every `PluginHost.call` burned its full timeout, and the root
 * cause was visible only at debug level.
 *
 * Real-effect assertions: a REAL child (/bin/sh) that closes its stdout and
 * keeps living; the wedge window raced far below the call timeout proves
 * fail-fast; `exitPromise` settlement proves the owner observes the death.
 * Both pump-death arms (thrown stream error / clean early end) are injected
 * directly against the exported pump.
 */
import { describe, expect, spyOn, test } from "bun:test"
import { createBunSpawner, PluginHost, PluginHostError } from "@/plugin-isolation"
import { createMessagePump } from "@/plugin-isolation/bun-spawner"
import { logger } from "@/shared"

/** Fail-fast bound: far under the 10s call timeout the old code burned. */
const WEDGE_WINDOW_MS = 3_000
const CALL_TIMEOUT_MS = 10_000
/** Single event-loop settle hop for fan-outs that must have already fired. */
const SETTLE_TICK_MS = 50

const SH = "/bin/sh"
/** Emits the ready sentinel, closes its OWN stdout, then keeps living. */
const CLOSE_STDOUT_LIVE_CHILD = `echo '{"ready":true}'; exec 1>&-; sleep 30`

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe("bun-spawner — stdout pump death while the child process lives (#10)", () => {
  test("(b) child closes stdout but LIVES → pending call fails fast with process-exited and exitPromise settles", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      const spawner = createBunSpawner()
      const handle = await spawner.spawn({
        entry: SH,
        args: ["-c", CLOSE_STDOUT_LIVE_CHILD],
        serviceName: "pump-death",
      })
      try {
        const host = new PluginHost(handle, { defaultCallTimeoutMs: CALL_TIMEOUT_MS })
        const pending = host.call("ping", {})
        const outcome = await Promise.race([
          pending.then(
            () => "resolved" as const,
            (e: unknown) =>
              e instanceof PluginHostError ? `rejected:${e.kind}` : `rejected:${String(e)}`,
          ),
          sleep(WEDGE_WINDOW_MS).then(() => "wedged" as const),
        ])
        // Old code: "wedged" — the call only dies at its own 10s timeout and
        // exitPromise NEVER settles. Fixed code propagates a prompt exit.
        expect(outcome).toBe("rejected:process-exited")
        const exited = await Promise.race([
          handle.exitPromise.then(() => true),
          sleep(WEDGE_WINDOW_MS).then(() => false),
        ])
        expect(exited).toBe(true)
        // The death is warned, not swallowed at debug.
        expect(warn.mock.calls.some((c) => String(c[0]).includes("pump"))).toBe(true)
      } finally {
        await handle.kill("SIGKILL")
      }
    } finally {
      warn.mockRestore()
    }
  })

  test("(a) throwing pump reports its settlement error (not swallowed)", async () => {
    const lines: string[] = []
    const stdout = (async function* (): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('{"ready":true}\n')
      throw new Error("EIO pump exploded")
    })()
    const pump = createMessagePump(stdout, "pump-death", (l) => lines.push(l))
    const settlement = await pump.done
    expect(lines).toEqual(['{"ready":true}'])
    expect(String(settlement.error)).toContain("EIO pump exploded")
  })

  test("(b) clean early end reports a null-error settlement (distinguishable from throw)", async () => {
    const lines: string[] = []
    const stdout = (async function* (): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('{"ready":true}\n')
    })()
    const pump = createMessagePump(stdout, "pump-death", (l) => lines.push(l))
    const settlement = await pump.done
    expect(lines).toEqual(['{"ready":true}'])
    expect(settlement.error).toBeNull()
  })

  test("(c) natural self-exit child (echo ready; exit 0) → NO warn, NO redundant SIGTERM", async () => {
    // Regression for the false-positive the audit-#10 fix introduced: stdout EOF
    // settles `pump.done` BEFORE Bun sets `proc.exitCode`, so a child that emits
    // ready and exits NATURALLY (no kill, no stream error) used to deterministically
    // trip the "pump died while child still running" warn + a redundant SIGTERM.
    // RED against the pre-fix liveness check; GREEN once the handler yields to the
    // concurrent `proc.exited` settlement before judging liveness.
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      const spawner = createBunSpawner()
      const handle = await spawner.spawn({
        entry: SH,
        // Emit ready, emit one payload line so the consumer has data, then exit 0.
        args: ["-c", `echo '{"ready":true}'; echo '{"hi":1}'; exit 0`],
        serviceName: "pump-natural",
      })
      try {
        // Let the child run to completion and the pump settle + the exit fan-out
        // settle. A natural exit must keep the pump-death handler quiet.
        await handle.exitPromise
        await sleep(SETTLE_TICK_MS)
        const pumpWarns = warn.mock.calls.filter((c) => String(c[0]).includes("pump died"))
        expect(pumpWarns).toEqual([])
      } finally {
        await handle.kill("SIGKILL")
      }
    } finally {
      warn.mockRestore()
    }
  })

  test("paired control: a deliberate kill() never warns pump death", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {})
    try {
      const spawner = createBunSpawner()
      const handle = await spawner.spawn({
        entry: SH,
        args: ["-c", `echo '{"ready":true}'; sleep 30`],
        serviceName: "pump-ctrl",
      })
      await handle.kill("SIGTERM")
      await handle.exitPromise
      await sleep(SETTLE_TICK_MS)
      expect(warn.mock.calls.some((c) => String(c[0]).includes("pump died"))).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })
})
