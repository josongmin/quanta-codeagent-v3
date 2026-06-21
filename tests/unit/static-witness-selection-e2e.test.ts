/**
 * SCAFF end-to-end: AST source → static witness → required contract → clean
 * selection. This is the exact "single-site beats complete co-change" failure
 * from the django RCA cases, proven fixed through the real logic chain the two
 * drivers compose (buildAstStaticWitnesses → buildStaticWitnessContracts →
 * runSelection clean). No instance id / gold path / file-path regex anywhere.
 */
import { describe, expect, it } from "bun:test"
import { type Candidate, runSelection } from "@/runner/batch/eval/selection-executor"
import { buildAstStaticWitnesses } from "@/runner/batch/eval/static-witness-adapter"
import { buildStaticWitnessContracts } from "@/runner/batch/eval/static-witness-contracts"

// Two owner files that BOTH define the same issue-named method (a base + an
// override) — generic made-up names, no benchmark literal.
const OWNER_A = "pkg/base/client.py"
const OWNER_B = "pkg/postgres/client.py"
const SHARED = "settings_to_cmd_args_env"
const source = (file: string): string | null =>
  file === OWNER_A || file === OWNER_B
    ? `class Client:\n    def ${SHARED}(self, settings, parameters):\n        return args, env\n`
    : null

const oneFileDiff = (file: string): string =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,2 @@ def ${SHARED}(self, s, p):\n-        return args, env\n+        return args, (env or None)`

const cand = (id: string, files: readonly string[]): Candidate => ({
  id,
  patch: files.map(oneFileDiff).join("\n"),
  turns: 1,
  files,
  baseValidatedRed: true,
})

describe("SCAFF e2e — complete co-change beats single-site under a static-witness required contract", () => {
  const witnesses = buildAstStaticWitnesses({
    problemStatement: `${SHARED} drops the empty environment incorrectly`,
    ownerCandidates: [OWNER_A, OWNER_B],
    readSource: source,
  })
  const contracts = buildStaticWitnessContracts(witnesses)

  it("the AST adapter + bridge produce ONE required multi-site-family over both owner files", () => {
    expect(contracts).toHaveLength(1)
    expect(contracts[0]?.kind).toBe("multi-site-family")
    expect(contracts[0]?.strength).toBe("required")
    expect([...(contracts[0]?.subjectFiles ?? [])].sort()).toEqual([OWNER_A, OWNER_B])
  })

  it("CLEAN: proof tied — the BIGGER complete-family patch beats the SMALLER single-site one", async () => {
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set([OWNER_A, OWNER_B]),
      mode: "clean",
      publicContracts: { contracts },
      ports: {
        // cand-0 = single-site (only the base file); cand-1 = complete co-change.
        generate: async (i) =>
          [cand("cand-0", [OWNER_A]), cand("cand-1", [OWNER_A, OWNER_B])][i] as Candidate,
        applyClean: async () => true,
      },
    })
    expect(r.winner?.id).toBe("cand-1")
  })

  it("RED-ON-INJECTION: with NO witness contract, minimality makes the WRONG single-site patch win", async () => {
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set([OWNER_A, OWNER_B]),
      mode: "clean",
      // no publicContracts ⇒ no required obligation ⇒ minimality decides ⇒ single-site.
      ports: {
        generate: async (i) =>
          [cand("cand-0", [OWNER_A]), cand("cand-1", [OWNER_A, OWNER_B])][i] as Candidate,
        applyClean: async () => true,
      },
    })
    expect(r.winner?.id).toBe("cand-0")
  })
})
