/**
 * Agentless-as-provider adapter + BYTE-IDENTITY compat HELLGATE (jul-6 S3).
 *
 * Two invariants:
 *   1. `agentlessProvider(result)` adapts an already-produced
 *      `AgentlessLocalizeResult` into an `ObservationProvider` whose fragment's
 *      `owners` mirror files/rationales (adapter does NOT run the localizer / LLM).
 *   2. BYTE-IDENTITY: when ONLY the agentless provider contributes and the
 *      renderer is in `legacy` mode, the output EQUALS the REAL
 *      `composeAgentlessHint(result)` verbatim — so wiring the kernel into the
 *      live issue-hint seam later is byte-identical when the kernel is off.
 *
 * The byte-identity test imports the ACTUAL `composeAgentlessHint` from the
 * existing module (NOT a copy) and asserts string equality across several
 * inputs, including the failing edge (empty files ⇒ empty string).
 */

import { describe, expect, test } from "bun:test"
// The REAL composer — byte-identity target. NOT a copy.
import {
  type AgentlessLocalizeResult,
  composeAgentlessHint,
} from "@/agent/issue-hint/agentless-localize"
import { DEFAULT_SOURCE_AUTHORITY, gatherObservations } from "@/agent/observation/pipeline"
import type { TaskContext } from "@/agent/observation/port"
import { agentlessProvider } from "@/agent/observation/render/agentless-provider"
import { renderObservations, renderObservationsLegacy } from "@/agent/observation/render/render"

const ctx: TaskContext = {
  cwd: "/repo",
  issueText: "boom",
  repoFiles: ["requests/models.py", "requests/exceptions.py"],
  capability: "source-repair",
}

const RESULTS: AgentlessLocalizeResult[] = [
  { files: [], rationales: [], rawResponse: "" }, // empty edge ⇒ "" byte sentinel
  {
    files: ["requests/models.py"],
    rationales: ["idna encode raises UnicodeError uncaught here"],
    rawResponse: "raw",
  },
  {
    files: ["requests/models.py", "requests/exceptions.py"],
    rationales: ["prepare_url path", ""], // second rationale intentionally empty
    rawResponse: "raw",
  },
  {
    files: ["a.py", "b.py", "c.py"],
    rationales: ["reason a", "reason b", "reason c"],
    rawResponse: "raw",
  },
  {
    // rationales shorter than files (adapter/composer must both tolerate)
    files: ["only.py"],
    rationales: [],
    rawResponse: "raw",
  },
]

describe("agentlessProvider — adapter shape", () => {
  test("adapter maps files → owners (does NOT run the localizer)", async () => {
    const r: AgentlessLocalizeResult = {
      files: ["x.py", "y.py"],
      rationales: ["rx", "ry"],
      rawResponse: "raw",
    }
    const p = agentlessProvider(r)
    expect(p.id).toBe("agentless-localize")
    expect(p.kind).toBe("localization")
    const frag = await p.produce(ctx, { maxMillis: 1000, maxOwners: 10 })
    expect(frag?.owners?.map((o) => o.file)).toEqual(["x.py", "y.py"])
    expect(frag?.owners?.[0]?.evidence).toBe("rx")
    expect(frag?.owners?.every((o) => o.source === "agentless-localize")).toBe(true)
  })

  test("empty result ⇒ produce returns null (no signal)", async () => {
    const p = agentlessProvider({ files: [], rationales: [], rawResponse: "" })
    const frag = await p.produce(ctx, { maxMillis: 1000, maxOwners: 10 })
    expect(frag).toBeNull()
  })

  test("adapter is applicable for source-repair, produces synchronously from the passed result", async () => {
    const p = agentlessProvider({ files: ["a.py"], rationales: ["r"], rawResponse: "raw" })
    expect(p.applicable(ctx)).toBe(true)
  })
})

describe("BYTE-IDENTITY — legacy render == composeAgentlessHint (verbatim, vs the REAL composer)", () => {
  for (const r of RESULTS) {
    test(`legacy render equals composeAgentlessHint for files=[${r.files.join(",")}]`, async () => {
      const expected = composeAgentlessHint(r) // the REAL, imported composer
      const bundle = await gatherObservations([agentlessProvider(r)], ctx, {
        authority: DEFAULT_SOURCE_AUTHORITY,
      })
      const actual = renderObservationsLegacy(bundle)
      expect(actual).toBe(expected)
    })
  }

  test("the compat target is genuinely the imported composer (guard against a local copy)", () => {
    // Regression guard: if someone replaces the import with an inline reimpl,
    // this identity would still pass but the reference would drift. Pin that
    // the composer module is the source by exercising a known-format assertion
    // on the REAL composer output, so this test co-fails with the real one.
    const out = composeAgentlessHint({ files: ["z.py"], rationales: ["zz"], rawResponse: "raw" })
    expect(out).toContain("## Issue Hints (Agentless localization)")
    expect(out).toContain("1. `z.py` — zz")
    expect(out).toContain("Use these as starting points but verify with your own tools.")
  })

  test("legacy mode does NOT emit the routing-hint / anti_signals scaffolding", async () => {
    // Legacy compat is a pure passthrough to the agentless format — the kernel
    // scaffolding (which changes bytes) must be absent in legacy mode.
    const bundle = await gatherObservations(
      [agentlessProvider({ files: ["a.py"], rationales: ["r"], rawResponse: "raw" })],
      ctx,
      { authority: DEFAULT_SOURCE_AUTHORITY },
    )
    const legacy = renderObservationsLegacy(bundle)
    expect(legacy).not.toContain("<quanta_observations>")
    expect(legacy).not.toContain("anti_signals")
    expect(legacy).not.toContain("routing hints")
  })
})

describe("full (non-legacy) render differs from legacy for the same agentless bundle", () => {
  test("kernel-on render carries the antidote scaffolding legacy omits", async () => {
    const bundle = await gatherObservations(
      [
        agentlessProvider({
          files: ["a.py", "b.py"],
          rationales: ["ra", "rb"],
          rawResponse: "raw",
        }),
      ],
      ctx,
      { authority: DEFAULT_SOURCE_AUTHORITY },
    )
    const legacy = renderObservationsLegacy(bundle)
    const full = renderObservations(bundle)
    expect(full).not.toBe(legacy)
    expect(full).toContain("anti_signals:")
    expect(full).toContain("<quanta_observations>")
    // top-1 still forbidden in full mode for a 2-owner bundle
    expect(full).toContain("a.py")
    expect(full).toContain("b.py")
  })
})
