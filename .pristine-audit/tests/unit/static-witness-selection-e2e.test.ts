/**
 * SCAFF end-to-end: AST source → static witness → clean selection.
 *
 * Static witnesses still localize and seed family context, but they do not mint
 * required contracts by themselves. The clean selector therefore keeps
 * minimality/proof authority unless some executable public proof says otherwise.
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

describe("SCAFF e2e — static-witness remains advisory-only for selection authority", () => {
  const witnesses = buildAstStaticWitnesses({
    problemStatement: `${SHARED} drops the empty environment incorrectly`,
    ownerCandidates: [OWNER_A, OWNER_B],
    readSource: source,
  })
  const contracts = buildStaticWitnessContracts(witnesses)

  it("the AST adapter still emits an authoritative override-family witness", () => {
    expect(witnesses).toHaveLength(1)
    expect(witnesses[0]?.kind).toBe("override-family")
    expect(witnesses[0]?.authority).toBe("authoritative")
    expect(witnesses[0]?.subjectFiles).toEqual([OWNER_A, OWNER_B])
  })

  it("the contract bridge mints ZERO required contracts from static-only evidence", () => {
    expect(contracts).toEqual([])
  })

  it("CLEAN: without executable proof, minimality still beats the bigger complete-family patch", async () => {
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
    expect(r.winner?.id).toBe("cand-0")
  })

  it("with the same empty contract set, baseline clean selection stays byte-identical", async () => {
    const r = await runSelection({
      n: 2,
      seeds: [undefined, undefined],
      owners: new Set([OWNER_A, OWNER_B]),
      mode: "clean",
      ports: {
        generate: async (i) =>
          [cand("cand-0", [OWNER_A]), cand("cand-1", [OWNER_A, OWNER_B])][i] as Candidate,
        applyClean: async () => true,
      },
    })
    expect(r.winner?.id).toBe("cand-0")
  })
})
