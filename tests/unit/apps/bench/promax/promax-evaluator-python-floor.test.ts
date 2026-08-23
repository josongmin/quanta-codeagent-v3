/**
 * PMX-04 — the pinned evaluator's PYTHON INTERPRETER FLOOR as a checked
 * contract rather than operator folklore.
 *
 * ## The evidence this file encodes
 *
 * The pinned evaluator (`src/evaluation/test_run.py`, sha256
 * `af2ee720de8a51a921f4af2617937c45f4e3b983549b640756b0fa8b2c1bf42d`) contains
 * EXACTLY ONE version-gated construct, at line 64:
 *
 * ```python
 * def _extract_omnigril_exit(text: str) -> int | None:
 * ```
 *
 * a PEP 604 union in an annotation, and the file carries NO
 * `from __future__ import annotations`. An AST scan of the pinned bytes finds no
 * `match` statement, no `except*`, no 3.11 stdlib import — so the floor derived
 * from the evidence is **3.10**, not the 3.11 that happened to be installed to
 * work around it.
 *
 * The failure it produces on 3.9 is NOT a SyntaxError, which is what the tool's
 * own docstring used to claim: the module COMPILES fine (verified with
 * `py_compile` on 3.9.6) and dies at DEF-TIME, at import, with
 *
 * ```text
 * TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'
 * ```
 *
 * That distinction is load-bearing: a syntax pre-check would pass a 3.9
 * interpreter straight through to a confusing runtime failure that reads like a
 * broken evaluator. The interpreter VERSION is the only thing that can be
 * checked ahead of time, which is why it is checked here.
 *
 * ## The trap these tests exist to hold shut
 *
 * `"3.9" > "3.10"` and `"3.9" > "3.11"` are both TRUE as string comparisons. A
 * lexical compare therefore ADMITS the one interpreter that is known to fail.
 * The comparison must be numeric, and `refuses 3.9 although it sorts ABOVE the
 * floor lexically` is the test that proves it.
 *
 * Everything here drives INJECTED ports. Nothing spawns a process.
 */
import { describe, expect, test } from "bun:test"
import {
  buildProMaxBootstrapPlan,
  buildProMaxBootstrapSpec,
  evaluateProMaxBootstrapReadiness,
  PROMAX_EVALUATOR_PYTHON_FLOOR,
  type ProMaxGateRunPorts,
  runProMaxGate,
} from "@/apps/bench/harness/promax"
import { proMaxRemoteBootstrap } from "@/apps/bench/profiles/promax-bootstrap"
import {
  describePythonFloorRefusal,
  formatPythonVersion,
  meetsPythonFloor,
  parsePythonVersion,
} from "@/apps/bench/profiles/python-version"
import { sha256Hex } from "@/apps/bench/promax/provenance"
import { classifyBootstrapPythonFloor } from "@/apps/bench/remote/box-session/family-bootstrap-exec"

/** The two interpreters this machine actually has, as `--version` prints them. */
const PY_39 = "Python 3.9.6\n"
const PY_311 = "Python 3.11.14\n"

describe("python floor — parsing what an interpreter reports", () => {
  test("parses the two REAL `--version` outputs this machine produces", () => {
    expect(parsePythonVersion(PY_39)).toEqual({ major: 3, minor: 9 })
    expect(parsePythonVersion(PY_311)).toEqual({ major: 3, minor: 11 })
  })

  test("accepts the version on STDERR too — old interpreters print it there", () => {
    // Python <3.4 wrote `--version` to stderr. The caller hands us both streams
    // concatenated; a parser that only understood stdout would report
    // "unreadable" for an interpreter that answered perfectly well.
    expect(parsePythonVersion(`\n${PY_39}`)).toEqual({ major: 3, minor: 9 })
  })

  test("parses pre-release and multi-digit minors", () => {
    expect(parsePythonVersion("Python 3.13.0a1\n")).toEqual({ major: 3, minor: 13 })
    expect(parsePythonVersion("Python 4.0.0\n")).toEqual({ major: 4, minor: 0 })
  })

  test("REFUSES to read a version out of output that does not announce one", () => {
    // Fail-closed: anything we cannot read is `null`, never an optimistic guess.
    for (const junk of ["", "\n", "command not found", "3.11.14", "Pythonic 3.11"]) {
      expect(parsePythonVersion(junk)).toBeNull()
    }
  })

  test("does not mistake a version inside a TRACEBACK for the interpreter's own", () => {
    // The exact shape this whole contract exists to avoid printing.
    const traceback =
      'File "/opt/quanta/promax/upstream/src/evaluation/test_run.py", line 64\n' +
      "TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'\n"
    expect(parsePythonVersion(traceback)).toBeNull()
  })
})

describe("python floor — the comparison is NUMERIC, not lexical", () => {
  const floor = { major: 3, minor: 10 } as const

  test("refuses 3.9 although it sorts ABOVE the floor lexically", () => {
    // Guard on the real trap. If either of these string comparisons stopped
    // being true the test below would still be correct, but this asserts the
    // hazard is real rather than imagined.
    expect("3.9" > "3.10").toBe(true)
    expect("3.9" > "3.11").toBe(true)

    expect(meetsPythonFloor({ major: 3, minor: 9 }, floor)).toBe(false)
  })

  test("admits the floor itself and everything above it", () => {
    expect(meetsPythonFloor({ major: 3, minor: 10 }, floor)).toBe(true)
    expect(meetsPythonFloor({ major: 3, minor: 11 }, floor)).toBe(true)
    expect(meetsPythonFloor({ major: 3, minor: 13 }, floor)).toBe(true)
    expect(meetsPythonFloor({ major: 4, minor: 0 }, floor)).toBe(true)
  })

  test("refuses everything below it, including an older MAJOR", () => {
    expect(meetsPythonFloor({ major: 2, minor: 7 }, floor)).toBe(false)
    expect(meetsPythonFloor({ major: 3, minor: 0 }, floor)).toBe(false)
    // 2.99 would beat 3.10 on minor alone — major must dominate.
    expect(meetsPythonFloor({ major: 2, minor: 99 }, floor)).toBe(false)
  })

  test("formats a version the way an operator reads one", () => {
    expect(formatPythonVersion({ major: 3, minor: 10 })).toBe("3.10")
  })
})

describe("python floor — the ProMax constant is DERIVED and records why", () => {
  test("the floor is 3.10 — the PEP 604 annotation, not the 3.11 that was installed", () => {
    expect(PROMAX_EVALUATOR_PYTHON_FLOOR.minimum).toEqual({ major: 3, minor: 10 })
  })

  test("carries the REASON and the REMEDY, so the refusal can name both", () => {
    const reason = PROMAX_EVALUATOR_PYTHON_FLOOR.reason
    // The evidence, not a bare assertion of a number.
    expect(reason).toContain("604")
    expect(reason).toContain("int | None")
    // The OBSERVED failure — the thing an operator will actually see if the
    // check is missing. It is a TypeError, not a SyntaxError.
    expect(reason).toContain("TypeError")
    expect(reason).not.toContain("SyntaxError")
    expect(PROMAX_EVALUATOR_PYTHON_FLOOR.remedy.length).toBeGreaterThan(0)
  })
})

describe("python floor — the refusal message names found, required, and remedy", () => {
  test("names the interpreter, the FOUND version, the FLOOR and the remedy", () => {
    const message = describePythonFloorRefusal({
      label: "evaluator interpreter",
      executable: "/usr/bin/python3",
      observed: { major: 3, minor: 9 },
      floor: PROMAX_EVALUATOR_PYTHON_FLOOR,
    })
    expect(message).toContain("/usr/bin/python3")
    expect(message).toContain("3.9") // found
    expect(message).toContain("3.10") // required floor
    expect(message).toContain(PROMAX_EVALUATOR_PYTHON_FLOOR.remedy)
    // It must read as a decision, not as a stack trace.
    expect(message).not.toContain("Traceback")
  })

  test("says UNREADABLE distinctly when no version could be parsed at all", () => {
    const message = describePythonFloorRefusal({
      label: "evaluator interpreter",
      executable: "/usr/bin/python3",
      observed: null,
      floor: PROMAX_EVALUATOR_PYTHON_FLOOR,
    })
    expect(message).toContain("/usr/bin/python3")
    expect(message).toContain("3.10")
    // An unreadable probe is not "version 0" — it is its own failure.
    expect(message.toLowerCase()).toContain("no python version")
  })
})

// ---------------------------------------------------------------------------
// WIRING 1 — the gate run refuses BEFORE it spawns the evaluator
// ---------------------------------------------------------------------------

const ROOT = "/campaign/pinned"
const WORK = "/campaign/work"
const IDS = ["aws__s2n-tls-5464"] as const
const EVALUATOR_BYTES = "# pinned evaluator fixture\n"
const EVAL_META_BYTES = '{"fixture": true}\n'
const FIXTURE_PINS = {
  evaluatorSha256: sha256Hex(EVALUATOR_BYTES),
  evalMetaSha256: sha256Hex(EVAL_META_BYTES),
}

interface GateHarness {
  readonly ports: ProMaxGateRunPorts
  readonly spawns: { argv: readonly string[]; cwd: string }[]
  readonly probed: string[]
}

const makeGateHarness = (versionOutput: string): GateHarness => {
  const writes = new Map<string, string>()
  const spawns: { argv: readonly string[]; cwd: string }[] = []
  const probed: string[] = []
  const files = new Map<string, string>([
    [`${ROOT}/src/evaluation/test_run.py`, EVALUATOR_BYTES],
    [`${ROOT}/data/eval.json`, EVAL_META_BYTES],
  ])
  const outputPath = `${WORK}/pass-rate.json`
  const ports: ProMaxGateRunPorts = {
    readBytes: (p) => {
      const text = files.get(p)
      return text === undefined ? null : new TextEncoder().encode(text)
    },
    readText: (p) => writes.get(p) ?? files.get(p) ?? null,
    writeText: (p, text) => {
      writes.set(p, text)
    },
    probePython: (executable) => {
      probed.push(executable)
      return { exitCode: 0, stdout: versionOutput, stderr: "" }
    },
    spawn: (argv, cwd) => {
      spawns.push({ argv, cwd })
      writes.set(
        outputPath,
        JSON.stringify(
          IDS.map((id) => ({
            instance_id: id,
            language: "c",
            passed: false,
            model: {
              final_result: "apply_failed",
              raw_reason: "apply_failed",
              returncode: 8,
              script_exit_code: 8,
            },
            golden: {
              final_result: "success",
              raw_reason: "success",
              returncode: 0,
              script_exit_code: 0,
            },
          })),
        ),
      )
      return { exitCode: 0, stdout: "", stderr: "" }
    },
    now: () => "2026-08-23T00:00:00.000Z",
  }
  return { ports, spawns, probed }
}

const gateInput = {
  campaignId: "pmx7-floor-test",
  // the python floor is checked BEFORE the payload is built, so the
  // submission kind is irrelevant to these tests — it just has to be one.
  submission: { kind: "gold-sentinel" } as const,
  assignedInstanceIds: IDS,
  pinnedRoot: ROOT,
  goldenPath: "/campaign/golden.json",
  workDir: WORK,
  pythonExecutable: "/usr/bin/python3",
}

describe("python floor — WIRED into the gate run, ahead of the spawn", () => {
  test("REFUSES a 3.9 interpreter and never spawns the evaluator", () => {
    const h = makeGateHarness(PY_39)
    const result = runProMaxGate(gateInput, h.ports, FIXTURE_PINS)

    expect(result.outcome).toBe("refused")
    if (result.outcome !== "refused") throw new Error("unreachable")
    expect(result.stage).toBe("python")
    expect(result.failures.map((f) => f.code)).toEqual(["python_below_floor"])
    // THE point: the evaluator never ran, so the operator gets a decision
    // instead of a traceback.
    expect(h.spawns).toHaveLength(0)
    // and it probed the interpreter it was actually going to use.
    expect(h.probed).toEqual(["/usr/bin/python3"])

    const message = result.failures[0]?.message ?? ""
    expect(message).toContain("3.9")
    expect(message).toContain("3.10")
    expect(message).toContain("/usr/bin/python3")
  })

  test("PROCEEDS on 3.11 — the same input, one field different", () => {
    const h = makeGateHarness(PY_311)
    const result = runProMaxGate(gateInput, h.ports, FIXTURE_PINS)

    expect(result.outcome).toBe("judged")
    if (result.outcome !== "judged") throw new Error("unreachable")
    expect(h.spawns).toHaveLength(1)
    expect(h.probed).toEqual(["/usr/bin/python3"])
    expect(result.gate.ok).toBe(true)
  })

  test("REFUSES an interpreter whose probe fails to run at all", () => {
    const h = makeGateHarness(PY_311)
    const ports: ProMaxGateRunPorts = {
      ...h.ports,
      probePython: () => ({ exitCode: 127, stdout: "", stderr: "no such file\n" }),
    }
    const result = runProMaxGate(gateInput, ports, FIXTURE_PINS)

    expect(result.outcome).toBe("refused")
    if (result.outcome !== "refused") throw new Error("unreachable")
    expect(result.stage).toBe("python")
    expect(result.failures.map((f) => f.code)).toEqual(["python_version_unreadable"])
    expect(h.spawns).toHaveLength(0)
  })

  test("the evaluator hash check still wins — a tampered evaluator is refused FIRST", () => {
    // Ordering guard: the cheapest, strongest claim keeps its place. A 3.9 box
    // with a tampered evaluator must still be told about the tampering.
    const h = makeGateHarness(PY_39)
    const result = runProMaxGate(gateInput, h.ports) // production pins

    expect(result.outcome).toBe("refused")
    if (result.outcome !== "refused") throw new Error("unreachable")
    expect(result.stage).toBe("verify-evaluator")
    // and NOTHING was probed or spawned.
    expect(h.probed).toHaveLength(0)
    expect(h.spawns).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// WIRING 2 — the remote bootstrap spec refuses a box BEFORE provisioning
// ---------------------------------------------------------------------------

const specInput = {
  campaignRoot: "/opt/quanta/promax",
  checkoutRoot: "/opt/quanta/promax/upstream",
  venvRoot: "/opt/quanta/promax/venv",
  patchGenConcurrency: 1,
}

describe("python floor — part of the TYPED bootstrap spec", () => {
  test("the DEFAULT spec carries the floor; it is not an argument a caller must remember", () => {
    const spec = buildProMaxBootstrapSpec(specInput)
    expect(spec.minPythonVersion).toEqual(PROMAX_EVALUATOR_PYTHON_FLOOR.minimum)
  })

  test("the PRODUCTION profile leaf carries it too, and prints it on the dry-run", () => {
    // The default production path: no systemPython argument anywhere, so the
    // spec resolves the interpreter to bare `python3` — which on this very
    // machine is 3.9.6. That is exactly the box this floor exists to refuse.
    const bootstrap = proMaxRemoteBootstrap({ promax: { upstreamCommit: "deadbeef" } } as never)
    expect(bootstrap.planNotes.some((n) => n.includes("promax-min-python=3.10"))).toBe(true)
  })

  test("an AGENT-phase probe checks the interpreter BEFORE the agent run is paid for", () => {
    const plan = buildProMaxBootstrapPlan(buildProMaxBootstrapSpec(specInput))
    const probes = plan.filter((c) => c.pythonFloor !== undefined)
    expect(probes.length).toBeGreaterThanOrEqual(1)

    const agentProbe = probes.find((c) => c.phase === "agent")
    expect(agentProbe).toBeDefined()
    if (agentProbe === undefined) throw new Error("unreachable")
    // It runs the SYSTEM interpreter — the one that will BUILD the venv. A venv
    // built by 3.9 is a 3.9 venv, so checking only after provisioning is
    // checking too late.
    expect(agentProbe.argv).toEqual(["python3", "--version"])
    expect(agentProbe.goldBearing).toBe(false)
    expect(agentProbe.pythonFloor?.minimum).toEqual({ major: 3, minor: 10 })
  })

  test("the dedicated venv interpreter is checked too, not just the system one", () => {
    const plan = buildProMaxBootstrapPlan(buildProMaxBootstrapSpec(specInput))
    const venvProbe = plan.find(
      (c) => c.pythonFloor !== undefined && c.argv[0] === "/opt/quanta/promax/venv/bin/python",
    )
    expect(venvProbe).toBeDefined()
    expect(venvProbe?.argv).toEqual(["/opt/quanta/promax/venv/bin/python", "--version"])
  })
})

describe("python floor — the EXECUTOR compares the declared floor", () => {
  const probe = {
    step: "python-floor",
    phase: "agent",
    goldBearing: false,
    argv: ["python3", "--version"],
    purpose: "test fixture",
    pythonFloor: PROMAX_EVALUATOR_PYTHON_FLOOR,
  } as const

  test("REFUSES the box when it reports 3.9", () => {
    const problem = classifyBootstrapPythonFloor(probe, PY_39)
    expect(problem).toBeDefined()
    expect(problem).toContain("3.9")
    expect(problem).toContain("3.10")
    expect(problem).toContain("python3")
  })

  test("ADMITS the box when it reports 3.11", () => {
    expect(classifyBootstrapPythonFloor(probe, PY_311)).toBeUndefined()
  })

  test("REFUSES rather than skips when the box reports NO version", () => {
    // Same posture as the digest check: an unreadable answer is a refusal, not
    // a skipped gate.
    expect(classifyBootstrapPythonFloor(probe, "")).toBeDefined()
  })

  test("a command with NO declared floor is untouched", () => {
    // The key is OMITTED, not set to `undefined`: under
    // `exactOptionalPropertyTypes` those are different types, and only the
    // omission is what a command without a floor actually looks like.
    const { pythonFloor: _floor, ...plain } = probe
    expect(classifyBootstrapPythonFloor(plain, PY_39)).toBeUndefined()
    // non-vacuous: the SAME output refuses once a floor is declared.
    expect(classifyBootstrapPythonFloor(probe, PY_39)).toBeDefined()
  })
})

describe("python floor — the readiness classifier no longer omits it", () => {
  const spec = buildProMaxBootstrapSpec(specInput)
  const baseObservation = {
    dockerInfo: `${spec.requiredPlatform.os}/${spec.requiredPlatform.architecture}`,
    freeDiskBytes: spec.minFreeDiskBytes,
    headCommit: spec.upstreamGitCommit,
    detached: true,
    fileHashes: Object.fromEntries(spec.upstreamFiles.map((f) => [f.path, f.sha256])),
  }

  test("an otherwise-perfect box is REFUSED for a 3.9 interpreter", () => {
    const problems = evaluateProMaxBootstrapReadiness(spec, {
      ...baseObservation,
      pythonVersion: { major: 3, minor: 9 },
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("3.10")
  })

  test("the same box passes on 3.11", () => {
    expect(
      evaluateProMaxBootstrapReadiness(spec, {
        ...baseObservation,
        pythonVersion: { major: 3, minor: 11 },
      }),
    ).toHaveLength(0)
  })

  test("an ABSENT observation is a problem, not a skipped check", () => {
    const problems = evaluateProMaxBootstrapReadiness(spec, {
      ...baseObservation,
      pythonVersion: null,
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("3.10")
  })
})
