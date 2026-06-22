import { describe, expect, test } from "bun:test"
import type { ReproExecPort } from "@/agent/repro-test/execute"
import type { ReproTestOutcome } from "@/agent/repro-test/types"
import {
  type ReproRescoreInput,
  rescoreReproScripts,
} from "@/runner/batch/eval/repro-rescore"

/**
 * Hellgate — DETERMINISTIC offline repro-oracle rescore.
 *
 * The whole point of this harness: re-run already-generated repro scripts
 * against a (possibly fixed) build-env / exec path WITHOUT any LLM. So:
 *  - the rescore module takes ZERO `llm` port (structural proof of free-ness),
 *  - it must invoke the injected `buildArgv` (where the per-repo build-env fix
 *    lives — e.g. astropy `--no-build-isolation` + extension_helpers), and
 *  - it must classify outcomes via the real executor + report parity vs the
 *    recorded outcomes so a build-env fix that flips exec_failed→reproduced is
 *    observable, and a no-op change round-trips byte-identically.
 */

// A fake exec that decides outcome by the SANDBOX it runs in (so we can make
// different instances behave differently) and ECHOES the argv it received into
// stderr (so we can prove buildArgv was actually threaded through).
const fakeExec = (
  byCwd: Record<string, { code: number; stdout: string }>,
): { port: ReproExecPort; seenArgv: string[][] } => {
  const seenArgv: string[][] = []
  const port: ReproExecPort = async (argv, cwd, _t) => {
    seenArgv.push([...argv])
    const r = byCwd[cwd] ?? { code: 1, stdout: "" }
    return { code: r.code, stdout: r.stdout, stderr: `argv=${argv.join(" ")}` }
  }
  return { port, seenArgv }
}

const inst = (
  instanceId: string,
  scripts: { source: string; recordedOutcome?: ReproTestOutcome }[],
  extra: Partial<ReproRescoreInput> = {},
): ReproRescoreInput => ({
  instanceId,
  repo: "astropy/astropy",
  version: "5.1",
  scripts,
  ...extra,
})

describe("rescoreReproScripts — offline deterministic repro-oracle rescore", () => {
  test("RR-1: re-runs cached scripts per instance and classifies outcomes (zero LLM)", async () => {
    const { port } = fakeExec({
      "/sb/A": { code: 0, stdout: "Issue reproduced\n" },
      "/sb/B": { code: 1, stdout: "" }, // crashes → exec_failed
    })
    const results = await rescoreReproScripts(
      [
        inst("A", [{ source: "print('Issue reproduced')" }]),
        inst("B", [{ source: "import astropy" }]),
      ],
      {
        prepareSandbox: async (i) => `/sb/${i.instanceId}`,
        exec: port,
        writeFile: async () => {},
        buildArgv: (_i, p) => ["uv", "run", "python", p],
      },
    )
    const a = results.find((r) => r.instanceId === "A")
    const b = results.find((r) => r.instanceId === "B")
    expect(a?.outcomes).toEqual(["reproduced"])
    expect(a?.reproducedCount).toBe(1)
    expect(b?.outcomes).toEqual(["exec_failed"])
    expect(b?.reproducedCount).toBe(0)
  })

  test("RR-2: parity is 'match' when rescore reproduces the recorded outcome, 'drift' when it changes", async () => {
    // Recorded: astropy was exec_failed. Build-env STILL broken ⇒ match.
    const broken = fakeExec({ "/sb/A": { code: 1, stdout: "" } })
    const stillBroken = await rescoreReproScripts(
      [inst("A", [{ source: "import astropy", recordedOutcome: "exec_failed" }])],
      {
        prepareSandbox: async () => "/sb/A",
        exec: broken.port,
        writeFile: async () => {},
      },
    )
    expect(stillBroken[0]?.parity).toBe("match")

    // Build-env FIXED ⇒ now reproduces ⇒ drift vs the recorded exec_failed.
    const fixed = fakeExec({ "/sb/A": { code: 0, stdout: "Issue reproduced\n" } })
    const nowFixed = await rescoreReproScripts(
      [inst("A", [{ source: "import astropy", recordedOutcome: "exec_failed" }])],
      {
        prepareSandbox: async () => "/sb/A",
        exec: fixed.port,
        writeFile: async () => {},
      },
    )
    expect(nowFixed[0]?.parity).toBe("drift")
    expect(nowFixed[0]?.outcomes).toEqual(["reproduced"])
  })

  test("RR-3: buildArgv is threaded into exec (the build-env fix path is live, not bypassed)", async () => {
    const { port, seenArgv } = fakeExec({ "/sb/A": { code: 0, stdout: "Issue reproduced\n" } })
    await rescoreReproScripts([inst("A", [{ source: "x" }])], {
      prepareSandbox: async () => "/sb/A",
      exec: port,
      writeFile: async () => {},
      buildArgv: (i, p) => ["uv", "run", "--python", i.version ?? "3", "python", p],
    })
    // Red-on-injection: if rescore ignored buildArgv, the argv would be the
    // bare [python, path] default and this assertion fails.
    expect(seenArgv.length).toBe(1)
    expect(seenArgv[0]?.slice(0, 4)).toEqual(["uv", "run", "--python", "5.1"])
  })

  test("RR-4: prepareSandbox is called once per instance with its checkout coordinates", async () => {
    const seen: ReproRescoreInput[] = []
    const { port } = fakeExec({ "/sb/A": { code: 0, stdout: "Issue reproduced\n" } })
    await rescoreReproScripts(
      [
        inst("A", [{ source: "x" }], { baseCommit: "deadbeef" }),
        inst("B", [{ source: "y" }], { repo: "django/django", version: "3.2" }),
      ],
      {
        prepareSandbox: async (i) => {
          seen.push(i)
          return `/sb/${i.instanceId}`
        },
        exec: port,
        writeFile: async () => {},
      },
    )
    expect(seen.map((s) => s.instanceId)).toEqual(["A", "B"])
    expect(seen.find((s) => s.instanceId === "A")?.baseCommit).toBe("deadbeef")
    expect(seen.find((s) => s.instanceId === "B")?.repo).toBe("django/django")
  })

  test("RR-1b: ALL K scripts in an instance are executed and index-aligned (not just the first)", async () => {
    const { port, seenArgv } = fakeExec({ "/sb/A": { code: 0, stdout: "Issue reproduced\n" } })
    const results = await rescoreReproScripts(
      [inst("A", [{ source: "s1" }, { source: "s2" }, { source: "s3" }])],
      { prepareSandbox: async () => "/sb/A", exec: port, writeFile: async () => {} },
    )
    expect(seenArgv.length).toBe(3) // all 3 exec'd, not short-circuited
    expect(results[0]?.outcomes).toEqual(["reproduced", "reproduced", "reproduced"])
  })

  test("RR-2b: parity='drift' when a DEFINED recorded outcome diverges, IGNORING undefined ones", async () => {
    // Red-on-injection: if parityOf didn't `continue` on undefined, script 2's
    // undefined would mis-compare; if it ignored the recorded diff, it'd say match.
    const { port } = fakeExec({ "/sb/A": { code: 0, stdout: "Issue reproduced\n" } })
    const results = await rescoreReproScripts(
      [
        inst("A", [
          { source: "s1", recordedOutcome: "reproduced" }, // match
          { source: "s2" }, // undefined → ignored
          { source: "s3", recordedOutcome: "exec_failed" }, // diverges → drift
        ]),
      ],
      { prepareSandbox: async () => "/sb/A", exec: port, writeFile: async () => {} },
    )
    expect(results[0]?.outcomes).toEqual(["reproduced", "reproduced", "reproduced"])
    expect(results[0]?.recordedOutcomes).toEqual(["reproduced", undefined, "exec_failed"])
    expect(results[0]?.parity).toBe("drift")
  })

  test("RR-2c: parity='unknown' when NO recorded outcome exists (nothing to compare)", async () => {
    const { port } = fakeExec({ "/sb/A": { code: 0, stdout: "Issue reproduced\n" } })
    const results = await rescoreReproScripts([inst("A", [{ source: "s1" }, { source: "s2" }])], {
      prepareSandbox: async () => "/sb/A",
      exec: port,
      writeFile: async () => {},
    })
    expect(results[0]?.parity).toBe("unknown")
  })

  test("RR-3b: buildArgv receives the EXACT temp path that writeFile wrote (script path is real)", async () => {
    const written: string[] = []
    const seen: string[][] = []
    const exec: ReproExecPort = async (argv, _cwd, _t) => {
      seen.push([...argv])
      return { code: 0, stdout: "Issue reproduced\n", stderr: "" }
    }
    await rescoreReproScripts([inst("A", [{ source: "x" }])], {
      prepareSandbox: async () => "/sb/A",
      exec,
      writeFile: async (path) => {
        written.push(path)
      },
      buildArgv: (_i, p) => ["python", p],
    })
    expect(written.length).toBe(1)
    // the path handed to buildArgv (argv[1]) is the same one writeFile received
    expect(seen[0]?.[1]).toBe(written[0])
  })

  test("RR-4b: the sandbox returned by prepareSandbox IS the cwd used for every exec", async () => {
    const cwds: string[] = []
    const exec: ReproExecPort = async (_argv, cwd, _t) => {
      cwds.push(cwd)
      return { code: 0, stdout: "Issue reproduced\n", stderr: "" }
    }
    // Red-on-injection: if rescore exec'd in a hardcoded path instead of the
    // prepareSandbox return, this fails.
    await rescoreReproScripts([inst("A", [{ source: "x" }, { source: "y" }])], {
      prepareSandbox: async () => "/custom/sandbox",
      exec,
      writeFile: async () => {},
    })
    expect(cwds).toEqual(["/custom/sandbox", "/custom/sandbox"])
  })

  test("RR-5b: writeFile throwing yields per-sample exec_failed (NOT a whole-instance error)", async () => {
    const { port } = fakeExec({ "/sb/A": { code: 0, stdout: "Issue reproduced\n" } })
    const results = await rescoreReproScripts([inst("A", [{ source: "s1" }, { source: "s2" }])], {
      prepareSandbox: async () => "/sb/A",
      exec: port,
      writeFile: async () => {
        throw new Error("disk full")
      },
    })
    expect(results[0]?.outcomes).toEqual(["exec_failed", "exec_failed"])
    expect(results[0]?.error).toBeUndefined() // executeReproTests catches internally
    expect(results[0]?.reproducedCount).toBe(0)
  })

  test("RR-6: an aborted signal STOPS the run (partial results, not a silent full list)", async () => {
    const { port } = fakeExec({
      "/sb/A": { code: 0, stdout: "Issue reproduced\n" },
      "/sb/B": { code: 0, stdout: "Issue reproduced\n" },
    })
    const ctrl = new AbortController()
    const results = await rescoreReproScripts(
      [inst("A", [{ source: "x" }]), inst("B", [{ source: "y" }])],
      {
        prepareSandbox: async (i) => {
          if (i.instanceId === "A") ctrl.abort()
          return `/sb/${i.instanceId}`
        },
        exec: port,
        writeFile: async () => {},
        signal: ctrl.signal,
      },
    )
    // A runs (abort fires during its prep, checked before B), B is skipped.
    expect(results.map((r) => r.instanceId)).toEqual(["A"])
  })

  test("RR-5: an instance whose sandbox prep throws is isolated (other instances still rescore)", async () => {
    const { port } = fakeExec({ "/sb/B": { code: 0, stdout: "Issue reproduced\n" } })
    const results = await rescoreReproScripts(
      [inst("A", [{ source: "x" }]), inst("B", [{ source: "y" }])],
      {
        prepareSandbox: async (i) => {
          if (i.instanceId === "A") throw new Error("checkout failed")
          return `/sb/${i.instanceId}`
        },
        exec: port,
        writeFile: async () => {},
      },
    )
    const a = results.find((r) => r.instanceId === "A")
    const b = results.find((r) => r.instanceId === "B")
    expect(a?.error).toContain("checkout failed")
    expect(a?.outcomes).toEqual([])
    expect(b?.outcomes).toEqual(["reproduced"])
  })
})
