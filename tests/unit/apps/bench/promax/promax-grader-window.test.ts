/**
 * PMX-04 — THE WINDOW IN WHICH THE ANSWER KEY EXISTS ON A BOX.
 *
 * The grader phase does not grade. Its commands clone the pinned upstream (which
 * carries `data/swe-bench-promax.json` — the answer key — beside the evaluator),
 * verify their hashes, and build a venv; the teardown `rm -rf`s the checkout.
 * The actual evaluator invocation is a separate thing that has to happen WHILE
 * that checkout exists.
 *
 * `executeFamilyRemoteBootstrap` ran the grader commands and the teardown
 * back-to-back, with no seam between them. So there was nowhere to put the
 * grading: materialize, then immediately destroy. Wiring a grader-phase caller
 * was impossible without this hook, which is a large part of why the phase had
 * no production caller at all.
 *
 * `whileMaterialized` is that seam, and it is deliberately a CALLBACK rather
 * than two exported functions (`materialize()` / `teardown()`) that a caller
 * sequences itself. The module's own rule: "a teardown with its own call site is
 * a teardown that gets forgotten — which is exactly how the checkout survived
 * into the next chunk." A callback keeps the teardown bound to the same call, so
 * there is no code path in which a caller can materialize the key and not remove
 * it.
 *
 * THE PROPERTY: the teardown runs on EVERY exit from that window — success, a
 * throwing grade, and a grade that throws while the teardown ALSO fails. The
 * last case is the one that matters most, because it is when the box is left
 * carrying the key and the operator has to be told.
 */
import { describe, expect, test } from "bun:test"
import type { FamilyRemoteBootstrap } from "@/apps/bench/profiles/types"
import { executeFamilyRemoteBootstrap } from "@/apps/bench/remote/box-session/family-bootstrap-exec"

const bootstrap: FamilyRemoteBootstrap = {
  family: "promax",
  graderWorkers: 1,
  planNotes: [],
  commands: [
    // REQUIRED by the executor: a family that materializes gold in its grader
    // phase must declare an agent-phase ABSENCE PROBE, so "the box is clean" is
    // proven rather than assumed. Omitting it makes the agent phase refuse —
    // which this fixture discovered the honest way.
    {
      phase: "agent",
      step: "gold-absence",
      // false: the probe ASSERTS the key's absence, it never carries the key.
      goldBearing: false,
      argv: ["test", "!", "-e", "/opt/quanta/promax/upstream"],
      purpose: "prove the answer key is absent before the agent runs",
      absenceProbe: { absolutePath: "/opt/quanta/promax/upstream" },
    },
    {
      phase: "grader",
      step: "checkout",
      goldBearing: true,
      argv: ["git", "clone", "upstream"],
      purpose: "materialize the pinned upstream (carries the answer key)",
    },
    {
      phase: "teardown",
      step: "gold-teardown",
      goldBearing: true,
      argv: ["rm", "-rf", "/opt/quanta/promax/upstream"],
      purpose: "remove the answer key",
    },
  ],
}

interface Recorder {
  readonly issued: string[]
  readonly ssh: (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>
}

const recorder = (failOn?: string): Recorder => {
  const issued: string[] = []
  return {
    issued,
    ssh: async (cmd: string) => {
      issued.push(cmd)
      return failOn !== undefined && cmd.includes(failOn)
        ? { code: 1, stdout: "", stderr: "boom" }
        : { code: 0, stdout: "", stderr: "" }
    },
  }
}

/** The executor shell-QUOTES each argv token (`'rm' '-rf' '/opt/…'`), so match
 *  the quoted form — an unquoted `"rm -rf"` needle silently never matches and
 *  would make every teardown assertion below vacuously false. */
const ranTeardown = (issued: readonly string[]): boolean =>
  issued.some((c) => /'?rm'?\s+'?-rf'?/.test(c))

describe("whileMaterialized — the grading seam between materialize and teardown", () => {
  test("the work runs AFTER the grader commands and BEFORE the teardown", async () => {
    const r = recorder()
    const order: string[] = []
    await executeFamilyRemoteBootstrap({
      bootstrap,
      phase: "grader",
      ssh: async (cmd) => {
        order.push(/'?rm'?\s+'?-rf'?/.test(cmd) ? "teardown" : "materialize")
        return r.ssh(cmd)
      },
      log: () => {},
      whileMaterialized: async () => {
        order.push("grade")
      },
    })
    expect(order).toEqual(["materialize", "grade", "teardown"])
  })

  test("🔴 a THROWING grade still tears the answer key down, and the grade error wins", async () => {
    const r = recorder()
    const boom = new Error("evaluator died")
    await expect(
      executeFamilyRemoteBootstrap({
        bootstrap,
        phase: "grader",
        ssh: r.ssh,
        log: () => {},
        whileMaterialized: async () => {
          throw boom
        },
      }),
    ).rejects.toThrow("evaluator died")
    // THE property: a crashed grade is precisely when the key is left behind.
    expect(ranTeardown(r.issued), "the answer key was NOT removed after a failed grade").toBe(true)
  })

  test("a grade that throws while the TEARDOWN also fails still surfaces the grade error, loudly", async () => {
    const logs: string[] = []
    const r = recorder("'rm'") // the teardown itself fails
    await expect(
      executeFamilyRemoteBootstrap({
        bootstrap,
        phase: "grader",
        ssh: r.ssh,
        log: (m) => logs.push(m),
        whileMaterialized: async () => {
          throw new Error("evaluator died")
        },
      }),
    ).rejects.toThrow("evaluator died")
    // the teardown was ATTEMPTED …
    expect(ranTeardown(r.issued)).toBe(true)
    // … and its failure is announced rather than swallowed, because the box now
    // carries the key and must not be reused for an agent phase.
    expect(logs.join(" ")).toMatch(/TEARDOWN also failed|answer-key/i)
  })

  test("PAIRED CONTROL: no callback ⇒ byte-identical — the WHOLE issued list, not just a teardown", async () => {
    const r = recorder()
    await executeFamilyRemoteBootstrap({
      bootstrap,
      phase: "grader",
      ssh: r.ssh,
      log: () => {},
    })
    // Asserting only "a teardown happened somewhere" let an EXTRA command be
    // added to the no-callback path without turning this red. The list is the
    // claim: exactly the grader command, then exactly the teardown.
    expect(r.issued).toEqual([
      "'git' 'clone' 'upstream'",
      "'rm' '-rf' '/opt/quanta/promax/upstream'",
    ])
  })

  test("PAIRED CONTROL: the callback is IGNORED for a non-grader phase", async () => {
    // The seam exists only where the key exists. An agent phase that ran it
    // would be running grade work with no materialized evaluator.
    let called = false
    await executeFamilyRemoteBootstrap({
      bootstrap,
      phase: "agent",
      ssh: recorder().ssh,
      log: () => {},
      whileMaterialized: async () => {
        called = true
      },
    })
    expect(called).toBe(false)
  })
})
