/**
 * Epistemic-calibration contract for `lsp_nav` tool DESCRIPTIONS.
 *
 * Bug it guards (jun-25): the references / incoming-calls descriptions used to
 * claim "returns EVERY call site / EVERY CALLER ... no false positives". For
 * Python/pyright (the dominant target), dynamic dispatch / getattr / duck-typing
 * or a cold/unindexed server return INCOMPLETE or EMPTY results, which the
 * formatter renders as a bare "no results". The absolute-completeness wording
 * made the model treat an empty result as PROOF-of-unused and delete live code —
 * directly contradicting the system prompt's anti-signal rail
 * (`src/agent/prompt-body.ts`: "A grep hit is presence evidence only — it is
 * NEVER proof of 'unused'").
 *
 * Contract: usage-query descriptions (references / incoming_calls) must NOT
 * assert absolute exhaustiveness AND must carry the "empty != unused, confirm
 * with grep + source + runtime" calibration. No lsp_nav description may imply
 * exhaustiveness over usage.
 *
 * Teeth: the OLD wording ("every call site", "every CALLER", "no false
 * positives") fails the absence assertions; a description missing the
 * calibration sentence fails the presence assertion.
 */

import { describe, expect, test } from "bun:test"
import { lspNavTools, nullLspNavProvider } from "@/tool/lsp_nav"

const tools = lspNavTools(nullLspNavProvider)
const desc = (name: string): string => {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool '${name}' not registered`)
  return t.description
}

// Usage queries whose empty result could be misread as "this symbol is unused"
// and drive a deletion. These carry the strongest contract.
const USAGE_QUERY_TOOLS = ["lsp_references", "lsp_incoming_calls"] as const

describe("lsp_nav description calibration (empty != unused)", () => {
  for (const name of USAGE_QUERY_TOOLS) {
    describe(name, () => {
      test("does NOT claim absolute completeness / exhaustiveness", () => {
        const d = desc(name).toLowerCase()
        // The exact old over-claims.
        expect(d).not.toContain("every call")
        expect(d).not.toContain("every caller")
        expect(d).not.toContain("no false positives")
        expect(d).not.toContain("no name-shadow false positives")
        // No generic exhaustiveness assertion ("returns every/all ...").
        expect(d).not.toMatch(/returns? (every|all) /)
      })

      test("carries the 'empty != unused' calibration", () => {
        const d = desc(name).toLowerCase()
        // States it is not exhaustive.
        expect(d).toContain("not exhaustive")
        // Names the failure modes a model must account for.
        expect(d).toMatch(/cold|unindexed|dynamic dispatch/)
        // Explicitly says empty is not proof of unused.
        expect(d).toContain("unused")
        expect(d).toMatch(/not proof|never proof|not.*unused/)
        // Directs the model to confirm via grep + source + runtime.
        expect(d).toContain("grep")
        expect(d).toMatch(/read the source|read source/)
        expect(d).toMatch(/run the code|run the runtime|running the code/)
      })

      test("keeps the genuine, accurate advantage (semantic, not text matches)", () => {
        expect(desc(name).toLowerCase()).toContain("semantic")
      })
    })
  }

  test("NO lsp_nav description implies exhaustiveness over usage", () => {
    for (const t of tools) {
      const d = t.description.toLowerCase()
      expect(d, `${t.name} must not claim "no false positives"`).not.toContain(
        "no false positives",
      )
      expect(d, `${t.name} must not claim "returns every/all"`).not.toMatch(
        /returns? (every|all) /,
      )
    }
  })
})
