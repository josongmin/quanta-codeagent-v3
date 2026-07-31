import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  baseReceipt,
  classifyBaseMwe,
  classifyPatchedMwe,
  isCleanVetoAuthority,
  isInfraFailure,
  type MweProofReceipt,
} from "@/runner/batch/eval/mwe-proof"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const MODULE_SRC = join(REPO_ROOT, "src/runner/batch/eval/mwe-proof.ts")
const TEST_SRC = join(REPO_ROOT, "tests/unit/mwe-proof.test.ts")

describe("classifyBaseMwe", () => {
  it("no extractable MWE ⇒ not_found", () => {
    expect(classifyBaseMwe({ found: false, ran: false, reproducedFailure: false })).toBe(
      "not_found",
    )
    // found=false dominates even if downstream flags are (impossibly) set true.
    expect(classifyBaseMwe({ found: false, ran: true, reproducedFailure: true })).toBe("not_found")
  })

  it("MWE present but never ran ⇒ execution_failed (infra)", () => {
    expect(classifyBaseMwe({ found: true, ran: false, reproducedFailure: false })).toBe(
      "execution_failed",
    )
  })

  it("ran and reproduced the public failure ⇒ base_red (valid oracle)", () => {
    expect(classifyBaseMwe({ found: true, ran: true, reproducedFailure: true })).toBe("base_red")
  })

  it("ran but did NOT reproduce ⇒ base_not_red (base-green)", () => {
    expect(classifyBaseMwe({ found: true, ran: true, reproducedFailure: false })).toBe(
      "base_not_red",
    )
  })
})

describe("classifyPatchedMwe — only a base_red oracle grants authority", () => {
  const evidence = { command: "uv run python repro.py", envPrefix: "uv run", exitStatus: 0 }

  it("base_red + candidate ran + passed ⇒ patched_green carrying full evidence", () => {
    const r = classifyPatchedMwe({ base: "base_red", ran: true, passed: true, ...evidence })
    expect(r.state).toBe("patched_green")
    expect(r.command).toBe(evidence.command)
    expect(r.envPrefix).toBe(evidence.envPrefix)
    expect(r.exitStatus).toBe(0)
  })

  it("base_red + candidate ran + failed ⇒ candidate_red (executed RED, carries evidence)", () => {
    const failEvidence = { command: "uv run python repro.py", envPrefix: "uv run", exitStatus: 1 }
    const r = classifyPatchedMwe({ base: "base_red", ran: true, passed: false, ...failEvidence })
    expect(r.state).toBe("candidate_red")
    expect(r.command).toBe(failEvidence.command)
    expect(r.envPrefix).toBe(failEvidence.envPrefix)
    expect(r.exitStatus).toBe(1)
  })

  it("base_red + candidate did NOT run ⇒ execution_failed (infra, not candidate-wrong)", () => {
    const r = classifyPatchedMwe({ base: "base_red", ran: false, passed: false, ...evidence })
    expect(r.state).toBe("execution_failed")
  })

  it("base NOT red ⇒ patched run has NO authority (echoes the non-oracle base state)", () => {
    for (const base of ["not_found", "base_not_red", "execution_failed"] as const) {
      const r = classifyPatchedMwe({ base, ran: true, passed: true, ...evidence })
      expect(r.state).toBe(base)
      // A non-oracle base cannot be promoted to a veto by a candidate-side pass.
      expect(isCleanVetoAuthority(r)).toBe(false)
    }
  })
})

describe("isCleanVetoAuthority — clean admit/veto ONLY for executed oracle outcomes", () => {
  it("patched_green (candidate passed a base-red MWE) ⇒ authority", () => {
    expect(isCleanVetoAuthority({ state: "patched_green" })).toBe(true)
  })

  it("candidate_red (candidate executed but failed a base-red MWE) ⇒ authority", () => {
    expect(isCleanVetoAuthority({ state: "candidate_red" })).toBe(true)
  })

  it("non-executed / non-oracle states ⇒ NO authority", () => {
    for (const state of ["not_found", "base_not_red", "base_red", "execution_failed"] as const) {
      expect(isCleanVetoAuthority({ state })).toBe(false)
    }
  })
})

describe("HELLGATE — an MWE may only veto when it actually proved itself", () => {
  it("extracted code fence alone (found, no base run) is NOT clean veto authority", () => {
    // An extracted fence = found=true but never executed on base.
    const base = classifyBaseMwe({ found: true, ran: false, reproducedFailure: false })
    expect(isCleanVetoAuthority(baseReceipt(base))).toBe(false)
  })

  it("a base-green MWE cannot become clean veto authority", () => {
    const base = classifyBaseMwe({ found: true, ran: true, reproducedFailure: false })
    expect(base).toBe("base_not_red")
    // Even with a candidate-side pass, no authority is granted.
    const patched = classifyPatchedMwe({ base, ran: true, passed: true })
    expect(isCleanVetoAuthority(patched)).toBe(false)
    expect(isCleanVetoAuthority(baseReceipt(base))).toBe(false)
  })

  it("a bare base_red (oracle proven, candidate never run) is NOT yet authority", () => {
    const base = classifyBaseMwe({ found: true, ran: true, reproducedFailure: true })
    expect(base).toBe("base_red")
    expect(isCleanVetoAuthority(baseReceipt(base))).toBe(false)
  })

  it("execution_failed is INFRA, not candidate-wrong, and never veto authority", () => {
    const receipt: MweProofReceipt = { state: "execution_failed" }
    expect(isInfraFailure(receipt)).toBe(true)
    expect(isCleanVetoAuthority(receipt)).toBe(false)
    // No other state is misreported as infra.
    for (const state of [
      "not_found",
      "base_not_red",
      "base_red",
      "patched_green",
      "candidate_red",
    ] as const) {
      expect(isInfraFailure({ state })).toBe(false)
    }
  })

  it("patched_green receipt MUST carry command + envPrefix + exitStatus", () => {
    const r = classifyPatchedMwe({
      base: "base_red",
      ran: true,
      passed: true,
      command: "uv run python repro.py",
      envPrefix: "uv run",
      exitStatus: 0,
    })
    expect(r.state).toBe("patched_green")
    expect(r.command).toBeDefined()
    expect(r.envPrefix).toBeDefined()
    expect(r.exitStatus).toBeDefined()
  })

  it("a patched run when base was NOT red ⇒ no authority (no promotion)", () => {
    const base = classifyBaseMwe({ found: false, ran: false, reproducedFailure: false })
    const patched = classifyPatchedMwe({
      base,
      ran: true,
      passed: false,
      command: "uv run python repro.py",
      envPrefix: "uv run",
      exitStatus: 1,
    })
    expect(patched.state).toBe("not_found")
    expect(isCleanVetoAuthority(patched)).toBe(false)
  })

  it("determinism: same inputs ⇒ same receipt", () => {
    const input = {
      base: "base_red" as const,
      ran: true,
      passed: false,
      command: "uv run python repro.py",
      envPrefix: "uv run",
      exitStatus: 7,
    }
    const a = classifyPatchedMwe(input)
    const b = classifyPatchedMwe(input)
    expect(a).toEqual(b)
    const c = classifyBaseMwe({ found: true, ran: true, reproducedFailure: true })
    const d = classifyBaseMwe({ found: true, ran: true, reproducedFailure: true })
    expect(c).toBe(d)
  })
})

describe("self-policing — no benchmark-shaped literals in module or test", () => {
  // Needles assembled from fragments so the scan itself contains no banned literal.
  const needles = [
    `${"django"}__`,
    `${"astropy"}__`,
    `${"FAIL"}_TO_${"PASS"}`,
    `${"PASS"}_TO_${"PASS"}`,
    `${"gold"}-${"path"}`,
    `${"gold"}Patch`,
    `instance${"-"}id`,
  ]
  for (const src of [MODULE_SRC, TEST_SRC]) {
    it(`${src.split("/").slice(-1)[0]} contains no banned literal`, () => {
      const text = readFileSync(src, "utf8")
      for (const needle of needles) {
        expect(text.includes(needle)).toBe(false)
      }
    })
  }
})
