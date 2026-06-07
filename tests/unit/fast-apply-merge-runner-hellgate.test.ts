/**
 * jun-7-misc 06 (ADR ≥0497) hellgate — model-based fast-apply MERGE runner.
 *
 * The merge runner is a PORT (`createFastApplyMerge`) sibling to the V4A re-emit
 * runner. It takes `{original, editSketch}`, asks a DEDICATED apply model to
 * fold the terse edit into the full file, extracts the merged file, runs a
 * conservative STRUCTURAL verification, and collapses EVERY failure to a typed
 * `{ ok:false, merged:null }` — it NEVER throws.
 *
 * Adversarial invariants pinned here (red-on-removal):
 *
 *   Happy path / extraction
 *     MR-01 ```merged fence ⇒ ok:true + merged = the fenced body + modelUsed
 *     MR-02 bare file (no fence) ⇒ accepted as the merged file
 *     MR-03 generic ``` fence with a language tag ⇒ body extracted
 *     MR-04 prompt names the elision convention + hands over the original verbatim
 *     MR-05 the "apply" role is resolved with the operator-set applyModel (NOT main)
 *
 *   Verification (the load-bearing safety property)
 *     MR-06 empty / whitespace merge ⇒ ok:false (dropped the whole file)
 *     MR-07 merge identical to the original ⇒ ok:false (no edit landed)
 *     MR-08 merge still contains `// ... existing code ...` ⇒ ok:false (not expanded)
 *     MR-09 truncated fence (opened, never closed) ⇒ ok:false (no half file)
 *
 *   NO-THROW dep failures
 *     MR-10 dispatch throws ⇒ ok:false (caught), merged:null
 *     MR-11 roleResolver.resolve throws ⇒ ok:false (caught)
 *     MR-12 sideConversation returns ok:false ⇒ ok:false
 *     MR-13 already-aborted signal ⇒ ok:false, NO dispatch attempted
 *     MR-14 rationale ALWAYS nonempty on every result
 */

import { describe, expect, test } from "bun:test"
import {
  type ApplyRoleResolverLike,
  createFastApplyMerge,
  extractMergedFile,
  type SideConversationLike,
  verifyMergeStructural,
} from "@/agent/fast-apply-fallback"

// No trailing newline inside the file fixtures: the markdown fence's pre-closer
// newline is a STRUCTURAL delimiter, not file content, so a fenced body is the
// text between the open line and the `\n```` closer (verbatim, no trailing \n).
// Tests that exercise extraction therefore wrap as `\`\`\`merged\n${X}\n\`\`\``.
const ORIGINAL = "export const a = 1\nexport const b = 2\nexport const c = 3"
const MERGED = "export const a = 1\nexport const b = 99\nexport const c = 3"

const applyResolver = (model = "apply-haiku"): ApplyRoleResolverLike => ({
  resolve: (_role, applyModel) => model || applyModel,
})
const passthroughResolver = (): ApplyRoleResolverLike => ({
  resolve: (_role, applyModel) => applyModel,
})

const okSide = (text: string): SideConversationLike => ({
  dispatch: async () => ({ ok: true, text }),
})

describe("jun-7-misc 06 fast-apply MERGE runner hellgate", () => {
  test("MR-01 ```merged fence ⇒ ok:true + merged body + modelUsed", async () => {
    const port = createFastApplyMerge({
      roleResolver: applyResolver("apply-1"),
      sideConversation: okSide(`Sure:\n\`\`\`merged\n${MERGED}\n\`\`\`\n`),
      applyModel: "apply-cfg",
    })
    const res = await port.apply({ original: ORIGINAL, editSketch: "x" })
    expect(res.ok).toBe(true)
    expect(res.merged).toBe(MERGED)
    expect(res.modelUsed).toBe("apply-1")
    expect(res.rationale.length).toBeGreaterThan(0)
  })

  test("MR-02 bare file (no fence) accepted", async () => {
    const port = createFastApplyMerge({
      roleResolver: applyResolver(),
      sideConversation: okSide(MERGED),
      applyModel: "apply-cfg",
    })
    const res = await port.apply({ original: ORIGINAL, editSketch: "x" })
    expect(res.ok).toBe(true)
    expect(res.merged).toBe(MERGED.trim())
  })

  test("MR-03 generic ``` fence with language tag ⇒ body extracted", async () => {
    const port = createFastApplyMerge({
      roleResolver: applyResolver(),
      sideConversation: okSide(`\`\`\`ts\n${MERGED}\n\`\`\``),
      applyModel: "apply-cfg",
    })
    const res = await port.apply({ original: ORIGINAL, editSketch: "x" })
    expect(res.ok).toBe(true)
    expect(res.merged).toBe(MERGED)
  })

  test("MR-04 prompt names elision convention + original verbatim", async () => {
    let seen = ""
    const side: SideConversationLike = {
      dispatch: async (req) => {
        seen = req.prompt
        return { ok: true, text: `\`\`\`merged\n${MERGED}\n\`\`\`` }
      },
    }
    const port = createFastApplyMerge({
      roleResolver: applyResolver(),
      sideConversation: side,
      applyModel: "apply-cfg",
    })
    await port.apply({ original: ORIGINAL, editSketch: "edit-sketch-token", path: "x.ts" })
    expect(seen).toContain("// ... existing code ...")
    expect(seen).toContain(ORIGINAL)
    expect(seen).toContain("edit-sketch-token")
    expect(seen).toContain("x.ts")
  })

  test("MR-05 apply role resolved with operator-set applyModel (never main)", async () => {
    let seenModel = ""
    const side: SideConversationLike = {
      dispatch: async (req) => {
        seenModel = req.model
        return { ok: true, text: `\`\`\`merged\n${MERGED}\n\`\`\`` }
      },
    }
    const port = createFastApplyMerge({
      roleResolver: passthroughResolver(),
      sideConversation: side,
      applyModel: "cheap-apply-specialist",
    })
    const res = await port.apply({ original: ORIGINAL, editSketch: "x" })
    expect(seenModel).toBe("cheap-apply-specialist")
    expect(res.modelUsed).toBe("cheap-apply-specialist")
  })

  test("MR-06 empty merge ⇒ ok:false", async () => {
    const port = createFastApplyMerge({
      roleResolver: applyResolver(),
      sideConversation: okSide("```merged\n   \n```"),
      applyModel: "apply-cfg",
    })
    const res = await port.apply({ original: ORIGINAL, editSketch: "x" })
    expect(res.ok).toBe(false)
    expect(res.merged).toBeNull()
    expect(res.rationale.length).toBeGreaterThan(0)
  })

  test("MR-07 merge identical to original ⇒ ok:false (no edit landed)", async () => {
    const port = createFastApplyMerge({
      roleResolver: applyResolver(),
      sideConversation: okSide(`\`\`\`merged\n${ORIGINAL}\n\`\`\``),
      applyModel: "apply-cfg",
    })
    const res = await port.apply({ original: ORIGINAL, editSketch: "x" })
    expect(res.ok).toBe(false)
    expect(res.merged).toBeNull()
  })

  test("MR-08 merge still contains elision marker ⇒ ok:false", async () => {
    const sketchy = "export const a = 1\n// ... existing code ...\nexport const c = 3\n"
    const port = createFastApplyMerge({
      roleResolver: applyResolver(),
      sideConversation: okSide(`\`\`\`merged\n${sketchy}\n\`\`\``),
      applyModel: "apply-cfg",
    })
    const res = await port.apply({ original: ORIGINAL, editSketch: "x" })
    expect(res.ok).toBe(false)
    expect(res.merged).toBeNull()
  })

  test("MR-09 truncated fence (no close) ⇒ ok:false (no half file)", async () => {
    const port = createFastApplyMerge({
      roleResolver: applyResolver(),
      sideConversation: okSide(`\`\`\`merged\n${MERGED}`),
      applyModel: "apply-cfg",
    })
    const res = await port.apply({ original: ORIGINAL, editSketch: "x" })
    expect(res.ok).toBe(false)
    expect(res.merged).toBeNull()
  })

  test("MR-10 dispatch throws ⇒ NO-THROW, ok:false", async () => {
    const side: SideConversationLike = {
      dispatch: async () => {
        throw new Error("network down")
      },
    }
    const port = createFastApplyMerge({
      roleResolver: applyResolver(),
      sideConversation: side,
      applyModel: "apply-cfg",
    })
    let res: Awaited<ReturnType<typeof port.apply>> | undefined
    await expect(
      (async () => {
        res = await port.apply({ original: ORIGINAL, editSketch: "x" })
      })(),
    ).resolves.toBeUndefined()
    expect(res?.ok).toBe(false)
    expect(res?.merged).toBeNull()
    expect((res?.rationale.length ?? 0) > 0).toBe(true)
  })

  test("MR-11 roleResolver.resolve throws ⇒ NO-THROW, ok:false", async () => {
    const resolver: ApplyRoleResolverLike = {
      resolve: () => {
        throw new Error("resolver bug")
      },
    }
    const port = createFastApplyMerge({
      roleResolver: resolver,
      sideConversation: okSide(`\`\`\`merged\n${MERGED}\n\`\`\``),
      applyModel: "apply-cfg",
    })
    const res = await port.apply({ original: ORIGINAL, editSketch: "x" })
    expect(res.ok).toBe(false)
    expect(res.merged).toBeNull()
  })

  test("MR-12 sideConversation ok:false ⇒ ok:false", async () => {
    const side: SideConversationLike = {
      dispatch: async () => ({ ok: false, text: "rate limited" }),
    }
    const port = createFastApplyMerge({
      roleResolver: applyResolver(),
      sideConversation: side,
      applyModel: "apply-cfg",
    })
    const res = await port.apply({ original: ORIGINAL, editSketch: "x" })
    expect(res.ok).toBe(false)
    expect(res.merged).toBeNull()
  })

  test("MR-13 already-aborted signal ⇒ ok:false, NO dispatch", async () => {
    let dispatched = false
    const side: SideConversationLike = {
      dispatch: async () => {
        dispatched = true
        return { ok: true, text: `\`\`\`merged\n${MERGED}\n\`\`\`` }
      },
    }
    const port = createFastApplyMerge({
      roleResolver: applyResolver(),
      sideConversation: side,
      applyModel: "apply-cfg",
    })
    const ac = new AbortController()
    ac.abort()
    const res = await port.apply({ original: ORIGINAL, editSketch: "x" }, ac.signal)
    expect(res.ok).toBe(false)
    expect(dispatched).toBe(false)
  })

  test("MR-14 rationale ALWAYS nonempty", async () => {
    const cases: SideConversationLike[] = [
      okSide(`\`\`\`merged\n${MERGED}\n\`\`\``), // ok
      okSide("no file here at all"), // bare → but unchanged-vs-? actually accepted; use prose
      { dispatch: async () => ({ ok: false, text: "" }) }, // dep fail
      {
        dispatch: async () => {
          throw new Error("boom")
        },
      }, // throw
    ]
    for (const side of cases) {
      const port = createFastApplyMerge({
        roleResolver: applyResolver(),
        sideConversation: side,
        applyModel: "apply-cfg",
      })
      const res = await port.apply({ original: ORIGINAL, editSketch: "x" })
      expect(typeof res.rationale).toBe("string")
      expect(res.rationale.length).toBeGreaterThan(0)
    }
  })

  // Direct unit coverage of the pure helpers (defense-in-depth: the structural
  // verifier and extractor are the safety backstop and must stay strict).
  test("MR-pure extractMergedFile: unclosed fence ⇒ null", () => {
    expect(extractMergedFile("```merged\nfoo")).toBeNull()
    expect(extractMergedFile("")).toBeNull()
  })
  test("MR-pure verifyMergeStructural rejects empty/identical/elision", () => {
    expect(verifyMergeStructural(ORIGINAL, "")).not.toBeNull()
    expect(verifyMergeStructural(ORIGINAL, ORIGINAL)).not.toBeNull()
    expect(verifyMergeStructural(ORIGINAL, "x// ... existing code ...y")).not.toBeNull()
    expect(verifyMergeStructural(ORIGINAL, MERGED)).toBeNull()
  })
})
