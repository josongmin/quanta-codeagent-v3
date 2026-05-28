/**
 * ADR-0417 hellgate — fast-apply fallback (apply_patch failure → focused
 * side-conversation re-emit attempt).
 *
 * The runner is a PORT (slot on AgentConfig); apply-patch.ts is NOT modified
 * this wave, so no consumer triggers it. These cases prove the runner LOGIC
 * standalone with duck-typed `RoleResolverLike` + `SideConversationLike` fakes.
 *
 * 13 adversarial cases:
 *
 *   Happy path (3)
 *     HELL-FA-01 model re-emits a valid `*** Begin Patch` block ⇒ ok:true + newPatch + modelUsed
 *     HELL-FA-02 prompt mentions the prior error kind/message ("prior failed because …")
 *     HELL-FA-03 source file + content folded into the prompt when provided
 *
 *   No-patch / failure (4)
 *     HELL-FA-04 model replies with prose, no patch block ⇒ ok:false, newPatch:null, rationale nonempty
 *     HELL-FA-05 sideConversation returns ok:false ⇒ ok:false, rationale nonempty
 *     HELL-FA-06 empty text ⇒ ok:false, rationale nonempty
 *     HELL-FA-07 patch block present but truncated (no End Patch) ⇒ ok:false (no half patch)
 *
 *   NO-THROW dep failures (3)
 *     HELL-FA-08 sideConversation.dispatch throws ⇒ ok:false (caught), newPatch:null
 *     HELL-FA-09 roleResolver.resolve throws ⇒ ok:false (caught)
 *     HELL-FA-10 abort signal already aborted ⇒ ok:false, no dispatch attempted
 *
 *   Role / errorKind / rationale (3)
 *     HELL-FA-11 role miss ⇒ resolver returns defaultModel fallback; modelUsed reflects it
 *     HELL-FA-12 every errorKind variant accepted (anchor_not_found / apply_error / parse_error)
 *     HELL-FA-13 rationale is ALWAYS a nonempty string on every result
 */

import { describe, expect, test } from "bun:test"
import {
  createFastApplyFallback,
  type FastApplyFailure,
  type RoleResolverLike,
  type SideConversationLike,
} from "@/agent/fast-apply-fallback"

const PATCH = [
  "*** Begin Patch",
  "*** Update File: a.ts",
  "@@",
  "-old",
  "+new",
  "*** End Patch",
].join("\n")

const failure = (over: Partial<FastApplyFailure> = {}): FastApplyFailure => ({
  patch: "*** Begin Patch\n*** Update File: a.ts\n*** End Patch",
  errorKind: "anchor_not_found",
  errorMessage: "anchor `-old` not found in a.ts",
  ...over,
})

const fixedResolver = (model = "executor-model"): RoleResolverLike => ({
  resolve: () => model,
})

const okSide = (text: string): SideConversationLike => ({
  dispatch: async () => ({ ok: true, text }),
})

describe("ADR-0417 fast-apply-fallback hellgate", () => {
  test("HELL-FA-01 valid patch re-emitted ⇒ ok:true + newPatch + modelUsed", async () => {
    const port = createFastApplyFallback({
      roleResolver: fixedResolver("exec-1"),
      sideConversation: okSide(`Here is the fix:\n${PATCH}\n`),
      defaultModel: "default-model",
    })
    const res = await port.attempt({ failure: failure() })
    expect(res.ok).toBe(true)
    expect(res.newPatch).toContain("*** Begin Patch")
    expect(res.newPatch).toContain("*** End Patch")
    expect(res.modelUsed).toBe("exec-1")
    expect(res.rationale.length).toBeGreaterThan(0)
  })

  test("HELL-FA-02 prompt explains the prior failure reason", async () => {
    let seenPrompt = ""
    const side: SideConversationLike = {
      dispatch: async (req) => {
        seenPrompt = req.prompt
        return { ok: true, text: PATCH }
      },
    }
    const port = createFastApplyFallback({
      roleResolver: fixedResolver(),
      sideConversation: side,
      defaultModel: "d",
    })
    await port.attempt({
      failure: failure({ errorKind: "parse_error", errorMessage: "unexpected token @@" }),
    })
    expect(seenPrompt).toContain("V4A")
    expect(seenPrompt.toLowerCase()).toContain("parse_error")
    expect(seenPrompt).toContain("unexpected token @@")
  })

  test("HELL-FA-03 source file + content folded into prompt", async () => {
    let seenPrompt = ""
    const side: SideConversationLike = {
      dispatch: async (req) => {
        seenPrompt = req.prompt
        return { ok: true, text: PATCH }
      },
    }
    const port = createFastApplyFallback({
      roleResolver: fixedResolver(),
      sideConversation: side,
      defaultModel: "d",
    })
    await port.attempt({
      failure: failure(),
      sourceFile: "src/widget.ts",
      sourceContent: "export const widget = 1\n",
    })
    expect(seenPrompt).toContain("src/widget.ts")
    expect(seenPrompt).toContain("export const widget = 1")
  })

  test("HELL-FA-04 prose with no patch block ⇒ ok:false, null, rationale", async () => {
    const port = createFastApplyFallback({
      roleResolver: fixedResolver(),
      sideConversation: okSide("I cannot produce a patch for this."),
      defaultModel: "d",
    })
    const res = await port.attempt({ failure: failure() })
    expect(res.ok).toBe(false)
    expect(res.newPatch).toBeNull()
    expect(res.rationale.length).toBeGreaterThan(0)
  })

  test("HELL-FA-05 sideConversation ok:false ⇒ ok:false", async () => {
    const side: SideConversationLike = {
      dispatch: async () => ({ ok: false, text: "rate limited" }),
    }
    const port = createFastApplyFallback({
      roleResolver: fixedResolver(),
      sideConversation: side,
      defaultModel: "d",
    })
    const res = await port.attempt({ failure: failure() })
    expect(res.ok).toBe(false)
    expect(res.newPatch).toBeNull()
    expect(res.rationale.length).toBeGreaterThan(0)
  })

  test("HELL-FA-06 empty text ⇒ ok:false", async () => {
    const port = createFastApplyFallback({
      roleResolver: fixedResolver(),
      sideConversation: okSide(""),
      defaultModel: "d",
    })
    const res = await port.attempt({ failure: failure() })
    expect(res.ok).toBe(false)
    expect(res.newPatch).toBeNull()
  })

  test("HELL-FA-07 truncated patch (no End Patch) ⇒ ok:false", async () => {
    const truncated = "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new"
    const port = createFastApplyFallback({
      roleResolver: fixedResolver(),
      sideConversation: okSide(truncated),
      defaultModel: "d",
    })
    const res = await port.attempt({ failure: failure() })
    expect(res.ok).toBe(false)
    expect(res.newPatch).toBeNull()
  })

  test("HELL-FA-08 dispatch throws ⇒ NO-THROW, ok:false", async () => {
    const side: SideConversationLike = {
      dispatch: async () => {
        throw new Error("network down")
      },
    }
    const port = createFastApplyFallback({
      roleResolver: fixedResolver(),
      sideConversation: side,
      defaultModel: "d",
    })
    let res: Awaited<ReturnType<typeof port.attempt>>
    await expect(
      (async () => {
        res = await port.attempt({ failure: failure() })
      })(),
    ).resolves.toBeUndefined()
    // biome-ignore lint/style/noNonNullAssertion: assigned above
    expect(res!.ok).toBe(false)
    // biome-ignore lint/style/noNonNullAssertion: assigned above
    expect(res!.newPatch).toBeNull()
    // biome-ignore lint/style/noNonNullAssertion: assigned above
    expect(res!.rationale.length).toBeGreaterThan(0)
  })

  test("HELL-FA-09 roleResolver.resolve throws ⇒ NO-THROW, ok:false", async () => {
    const resolver: RoleResolverLike = {
      resolve: () => {
        throw new Error("resolver bug")
      },
    }
    const port = createFastApplyFallback({
      roleResolver: resolver,
      sideConversation: okSide(PATCH),
      defaultModel: "d",
    })
    const res = await port.attempt({ failure: failure() })
    expect(res.ok).toBe(false)
    expect(res.newPatch).toBeNull()
    expect(res.rationale.length).toBeGreaterThan(0)
  })

  test("HELL-FA-10 already-aborted signal ⇒ ok:false, no dispatch", async () => {
    let dispatched = false
    const side: SideConversationLike = {
      dispatch: async () => {
        dispatched = true
        return { ok: true, text: PATCH }
      },
    }
    const port = createFastApplyFallback({
      roleResolver: fixedResolver(),
      sideConversation: side,
      defaultModel: "d",
    })
    const ac = new AbortController()
    ac.abort()
    const res = await port.attempt({ failure: failure() }, ac.signal)
    expect(res.ok).toBe(false)
    expect(dispatched).toBe(false)
    expect(res.rationale.length).toBeGreaterThan(0)
  })

  test("HELL-FA-11 role miss ⇒ defaultModel fallback reflected in modelUsed", async () => {
    // resolver returns the defaultModel it was given (role miss path)
    const resolver: RoleResolverLike = {
      resolve: (_role, defaultModel) => defaultModel,
    }
    let seenModel = ""
    const side: SideConversationLike = {
      dispatch: async (req) => {
        seenModel = req.model
        return { ok: true, text: PATCH }
      },
    }
    const port = createFastApplyFallback({
      roleResolver: resolver,
      sideConversation: side,
      defaultModel: "fallback-default",
    })
    const res = await port.attempt({ failure: failure() })
    expect(seenModel).toBe("fallback-default")
    expect(res.modelUsed).toBe("fallback-default")
    expect(res.ok).toBe(true)
  })

  test("HELL-FA-12 every errorKind variant accepted", async () => {
    const kinds: FastApplyFailure["errorKind"][] = [
      "anchor_not_found",
      "apply_error",
      "parse_error",
    ]
    for (const kind of kinds) {
      const port = createFastApplyFallback({
        roleResolver: fixedResolver(),
        sideConversation: okSide(PATCH),
        defaultModel: "d",
      })
      const res = await port.attempt({ failure: failure({ errorKind: kind }) })
      expect(res.ok).toBe(true)
    }
  })

  test("HELL-FA-13 rationale ALWAYS nonempty", async () => {
    const cases: SideConversationLike[] = [
      okSide(PATCH), // ok
      okSide("no patch here"), // miss
      { dispatch: async () => ({ ok: false, text: "" }) }, // dep fail
      {
        dispatch: async () => {
          throw new Error("boom")
        },
      }, // throw
    ]
    for (const side of cases) {
      const port = createFastApplyFallback({
        roleResolver: fixedResolver(),
        sideConversation: side,
        defaultModel: "d",
      })
      const res = await port.attempt({ failure: failure() })
      expect(typeof res.rationale).toBe("string")
      expect(res.rationale.length).toBeGreaterThan(0)
    }
  })
})
