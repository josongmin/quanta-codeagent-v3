/**
 * GOVERNANCE RATCHET (P2-T3) — the external-action tools that perform
 * inherently-SENSITIVE, externally-visible, hard-to-reverse work MUST declare
 * `capability.confirm: "sensitive"` so the PDP security floor confirms them on
 * EVERY surface (even bypass, no HITL opt-in needed).
 *
 * This pins the classified set: if a sensitive tool loses its capability (or a
 * refactor drops it), this fails RED — the floor would silently stop confirming
 * a remote-mutating action. When you add a NEW external-write tool, classify it
 * and add it here.
 */
import { describe, expect, test } from "bun:test"
import { ghPrAutoMergeTool, ghPrCommentTool, ghPrCreateTool, ghPrOpenTool } from "@/tool/gh"
import { gitPushTool } from "@/tool/git"

// Stubs are never invoked — `capability()` is a pure declaration.
const stub = (() => {
  throw new Error("runner must not be invoked by capability()")
}) as never

const SENSITIVE_EXTERNAL_TOOLS = [
  ["git_push", gitPushTool(stub)],
  ["gh_pr_open", ghPrOpenTool(stub, stub, stub)],
  ["gh_pr_create", ghPrCreateTool()],
  ["gh_pr_comment", ghPrCommentTool()],
  ["gh_pr_auto_merge", ghPrAutoMergeTool()],
] as const

describe("sensitive external-action tools declare capability sensitive [P2-T3 ratchet]", () => {
  for (const [name, tool] of SENSITIVE_EXTERNAL_TOOLS) {
    test(`${name} ⇒ capability.confirm = "sensitive" (joins the universal floor)`, () => {
      expect(tool.name).toBe(name)
      // biome-ignore lint/suspicious/noExplicitAny: pure capability probe, input unused
      expect(tool.capability?.({} as any)).toEqual({ confirm: "sensitive" })
    })
  }
})
