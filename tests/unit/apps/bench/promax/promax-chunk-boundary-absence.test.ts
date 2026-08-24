/**
 * PMX-04 — THE ABSENCE PROBE RUNS BEFORE **EVERY** AGENT PHASE, NOT ONCE PER BOX.
 *
 * The agent-phase bootstrap — which carries `absenceProbe`, the command that
 * proves the answer key is gone before the agent starts — is executed by
 * `setupBoxForFamily` at provision and by `ensureWarmBoxFamilyBootstrap` on warm
 * attach. A pool worker holds one live session and runs many chunks through it,
 * so chunks 2..N never re-bootstrapped: they started their agent phase with
 * nothing checking that the previous chunk's teardown actually worked.
 *
 * The teardown is bound to the grade call and runs on every in-process exit, and
 * a teardown that FAILS throws — the pool then terminates the box. So the
 * uncovered case is precise: a teardown that exits 0 without having removed
 * everything. That is exactly the case the probe exists to catch as a SECOND
 * gate, and at the chunk boundary that second gate was missing.
 *
 * `evaluator-bootstrap.ts` says as much about the first chunk: "until this
 * command existed … the second chunk on a warm box started its agent phase on a
 * box that still held the answer key". The probe fixed chunk 1 of each box only.
 */
import { describe, expect, test } from "bun:test"
import { familyRemoteBootstrap } from "@/apps/bench/profiles/bootstrap"
import { proveAnswerKeyAbsentForAgent } from "@/apps/bench/remote/box-session/family-box-grade"
import { resolveBenchRunConfig } from "@/apps/bench/run-config"

const promaxBootstrap = () =>
  familyRemoteBootstrap(resolveBenchRunConfig({ argvFamily: "promax", env: {} }))

const CHECKOUT = "/opt/quanta/promax/upstream"

/** `dirty` ⇒ the box still holds the checkout, i.e. the probe must fail. */
const recorder = (opts: { dirty?: boolean } = {}) => {
  const issued: string[] = []
  return {
    issued,
    ssh: async (cmd: string) => {
      issued.push(cmd)
      if (cmd.includes("'test'") && cmd.includes(CHECKOUT)) {
        return opts.dirty === true
          ? { code: 1, stdout: "", stderr: "" }
          : { code: 0, stdout: "", stderr: "" }
      }
      if (cmd.includes("--version")) return { code: 0, stdout: "Python 3.11.14\n", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    },
  }
}

describe("every chunk re-proves the box is clean before its agent runs", () => {
  test("🔴 a CLEAN box passes, and the probe was actually issued", () => {
    const r = recorder()
    return proveAnswerKeyAbsentForAgent({
      ssh: r.ssh,
      log: () => {},
      family: "promax",
      bootstrap: promaxBootstrap(),
    }).then(() => {
      expect(
        r.issued.some((c) => c.includes("'test'") && c.includes(CHECKOUT)),
        "the absence probe never reached the box",
      ).toBe(true)
    })
  })

  test("🔴 a box that STILL HOLDS the answer key is refused before the agent starts", async () => {
    const r = recorder({ dirty: true })
    await expect(
      proveAnswerKeyAbsentForAgent({
        ssh: r.ssh,
        log: () => {},
        family: "promax",
        bootstrap: promaxBootstrap(),
      }),
    ).rejects.toThrow()
  })

  test("PAIRED CONTROL: a family with no declared bootstrap issues NOTHING", async () => {
    const r = recorder()
    await proveAnswerKeyAbsentForAgent({
      ssh: r.ssh,
      log: () => {},
      family: "verified",
      bootstrap: undefined,
    })
    expect(r.issued).toEqual([])
  })

  test("PAIRED CONTROL: it runs the AGENT phase only — no gold-bearing command", async () => {
    const r = recorder()
    await proveAnswerKeyAbsentForAgent({
      ssh: r.ssh,
      log: () => {},
      family: "promax",
      bootstrap: promaxBootstrap(),
    })
    // the checkout belongs to the grader phase; re-proving absence must never
    // materialize the very thing it is checking for
    expect(r.issued.some((c) => c.includes("'git'"))).toBe(false)
  })
})
