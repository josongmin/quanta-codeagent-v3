/**
 * HELLGATE — C6 deny-reason WIRE end-to-end through REAL `dispatchTool`.
 *
 * The sibling `deny-reason-reachability-hellgate.test.ts` proves the structured
 * reason reaches the failure envelope + content prefix when calling
 * `runAdmissibilityGate` DIRECTLY. This battery seals the SAME chain through the
 * PUBLIC dispatch entry point (`dispatchTool`) — the surface the loop actually
 * calls — so a regression in the dispatch wrapper (span/dedup/seam ordering)
 * that drops the structured reason is caught:
 *
 *   1. knob-ON  ⇒ a deny dispatched through `dispatchTool` carries the
 *      structured `denyReason` (right `layer`/`pillar`) on the
 *      `ToolFailure.permission_denied` envelope AND the categorical
 *      `[denied · layer=… · pillar=…]` model-facing content prefix.
 *   2. knob-OFF ⇒ the result is BYTE-IDENTICAL to legacy: NO `failure` key,
 *      NO content prefix.
 *   3. NO-LEAK ⇒ the structured `safeReason` is the categorical one-liner, never
 *      raw tool input / command.
 *   4. COMPLETENESS ⇒ the dispatch-SEAM `plan` collaboration-mode block (which
 *      fires BEFORE `runAdmissibilityGate`, preview `mode-blocked`) is ALSO
 *      wired — it carries `layer=mode` / `pillar=approval`, parity with the
 *      admissibility-gate `denyIfModeBlocked` (preview `plan-blocked`). This is
 *      the gap this battery's red→green covers.
 *
 * Defect class: a deny SITE on the dispatch path attaches no structured reason
 * (incompleteness), or the dispatch wrapper drops it, or the knob-OFF path
 * drifts from the legacy `{block, ok:false, preview}` shape.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { Tool, ToolEvent, ToolFailure } from "@/tool"
import { ToolRegistry } from "@/tool"

const makeTool = (name: string, readOnly = false): Tool => ({
  name,
  description: `${name} tool`,
  inputSchema: z.object({}).passthrough() as unknown as z.ZodType<unknown>,
  isReadOnly: () => readOnly,
  isConcurrencySafe: () => readOnly,
  execute: () =>
    (async function* (): AsyncIterable<ToolEvent> {
      yield { type: "result", result: { ok: true, output: "ran" } }
    })(),
})

const call = (name: string, input: unknown = {}, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
})

const cfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "default" } as PermissionContext,
    ...over,
  }) as AgentConfig

const permFailure = (
  f: ToolFailure | undefined,
): Extract<ToolFailure, { mode: "permission_denied" }> | undefined =>
  f?.mode === "permission_denied" ? f : undefined

const originalDenyReason = process.env.QUANTA_DENY_REASON

const setKnob = (on: boolean): void => {
  if (on) process.env.QUANTA_DENY_REASON = "1"
  else delete process.env.QUANTA_DENY_REASON
  __resetRuntimeConfig()
}

beforeEach(() => {
  __resetDefaultPermissionStore()
})

afterEach(() => {
  if (originalDenyReason === undefined) delete process.env.QUANTA_DENY_REASON
  else process.env.QUANTA_DENY_REASON = originalDenyReason
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

describe("hellgate — C6 e2e through dispatchTool: admissibility-gate deny", () => {
  // NOTE: a `mutate` tool absent from MUTATING_TOOL_TABLE in `plan` posture is
  // intercepted by the dispatch-SEAM guard (preview "mode-blocked") BEFORE it
  // ever reaches the admissibility-gate `denyIfModeBlocked` (preview
  // "plan-blocked"). Both denies are `layer:mode` — this is exactly the
  // cross-path consistency the e2e seals. The admissibility-gate "plan-blocked"
  // preview is covered directly in deny-reason-reachability-hellgate.test.ts.
  test("knob-ON: plan-posture mode block (seam) surfaces layer=mode + [denied] prefix via dispatchTool", async () => {
    setKnob(true)
    const mutate = makeTool("mutate")
    const c = cfg({ registry: new ToolRegistry([mutate]), planMode: true })
    const res = await dispatchTool(call("mutate"), c, { mode: "default" })
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("mode-blocked")
    const f = permFailure(res.failure)
    expect(f?.denyReason?.layer).toBe("mode")
    expect(f?.denyReason?.verdict).toBe("deny")
    expect(res.block.content).toContain("[denied · layer=mode")
  })

  test("knob-ON: stack ask→declined surfaces layer=stack + pillar=approval via dispatchTool", async () => {
    setKnob(true)
    const mutate = makeTool("mutate")
    const c = cfg({
      registry: new ToolRegistry([mutate]),
      onConfirm: async () => false,
    })
    const res = await dispatchTool(call("mutate"), c, { mode: "default" })
    expect(res.ok).toBe(false)
    const f = permFailure(res.failure)
    expect(f?.denyReason?.layer).toBe("stack")
    expect(f?.denyReason?.pillar).toBe("approval")
    expect(res.block.content).toContain("[denied · layer=stack · pillar=approval]")
  })

  test("knob-OFF: byte-identical — NO failure key, NO prefix via dispatchTool", async () => {
    setKnob(false)
    const mutate = makeTool("mutate")
    const c = cfg({ registry: new ToolRegistry([mutate]), planMode: true })
    const res = await dispatchTool(call("mutate"), c, { mode: "default" })
    expect(res.preview).toBe("mode-blocked")
    expect(res.failure).toBeUndefined()
    expect("failure" in res).toBe(false)
    expect(res.block.content).not.toContain("[denied ·")
  })
})

describe("hellgate — C6 COMPLETENESS: dispatch-SEAM plan-mode block is wired", () => {
  // `write` is in MUTATING_TOOL_TABLE (write_filesystem) so the dispatch-seam
  // guard returns PlanModeMutatingBlockedError → preview "mode-blocked" — a
  // DIFFERENT, EARLIER deny site than the admissibility-gate "plan-blocked".
  test("knob-ON: collaborationMode=plan mutating block carries layer=mode + pillar=approval", async () => {
    setKnob(true)
    const write = makeTool("write")
    const c = cfg({
      registry: new ToolRegistry([write]),
      collaborationMode: "plan",
    } as Partial<AgentConfig>)
    const res = await dispatchTool(call("write"), c, { mode: "default" })
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("mode-blocked")
    const f = permFailure(res.failure)
    expect(f?.denyReason?.layer).toBe("mode")
    expect(f?.denyReason?.pillar).toBe("approval")
    // Categorical safeReason — never the tool input.
    expect(f?.denyReason?.safeReason).toBe("tool blocked in plan collaboration mode")
    expect(res.block.content).toContain("[denied · layer=mode · pillar=approval]")
  })

  test("knob-ON: dispatch-seam block NO-LEAK — prefix/safeReason carry no input", async () => {
    setKnob(true)
    const write = makeTool("write")
    const c = cfg({
      registry: new ToolRegistry([write]),
      collaborationMode: "plan",
    } as Partial<AgentConfig>)
    const SECRET = "sk-live-DEADBEEF-input-secret"
    const res = await dispatchTool(call("write", { path: SECRET, contents: SECRET }), c, {
      mode: "default",
    })
    const f = permFailure(res.failure)
    expect(f?.denyReason?.safeReason).not.toContain(SECRET)
    const prefix = (res.block.content ?? "").split("]")[0] ?? ""
    expect(prefix).not.toContain(SECRET)
    expect(prefix).toContain("[denied · layer=mode · pillar=approval")
  })

  test("knob-OFF: dispatch-seam block byte-identical — NO failure key, NO prefix", async () => {
    setKnob(false)
    const write = makeTool("write")
    const c = cfg({
      registry: new ToolRegistry([write]),
      collaborationMode: "plan",
    } as Partial<AgentConfig>)
    const res = await dispatchTool(call("write"), c, { mode: "default" })
    expect(res.preview).toBe("mode-blocked")
    expect(res.failure).toBeUndefined()
    expect("failure" in res).toBe(false)
    expect(res.block.content).not.toContain("[denied ·")
  })
})

describe("hellgate — C6 COMPLETENESS: dispatch-GUARD seam deny is wired (ADR-0229)", () => {
  // The dispatch-guard (`consultDispatchGuard`) composes `@/permission` policy
  // detectors (git-write-protect / branch-only / network egress) and fires
  // BEFORE `runAdmissibilityGate`. Its `guard-deny` / `guard-ask` results are
  // seam-level PERMISSION denies — the second deny site (besides the plan-mode
  // block) that surfaces before the gate. Before this fix they carried NO
  // structured reason, so the C6 "EVERY deny carries a layer" claim was
  // incomplete. These cases red→green that gap.

  /** Minimal DispatchGuard stub — returns a fixed decision. Lets us drive the
   *  three arms (hard deny / soft deny / ask) without depending on a specific
   *  detector's input shape. */
  const guardOf = (decision: import("@/agent/dispatch-guard").GuardDecision) => ({
    check: () => decision,
  })

  test("knob-ON: hard guard-deny carries layer=stack (security boundary), no pillar guess", async () => {
    setKnob(true)
    const tool = makeTool("bash")
    const c = cfg({
      registry: new ToolRegistry([tool]),
      dispatchGuard: guardOf({
        kind: "deny",
        reason: "git-write protection: protected on '.git/config'",
        hardDeny: true,
      }),
    } as Partial<AgentConfig>)
    const res = await dispatchTool(call("bash", { command: "x" }), c, { mode: "default" })
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("guard-deny")
    const f = permFailure(res.failure)
    expect(f?.denyReason?.layer).toBe("stack")
    expect(f?.denyReason?.verdict).toBe("deny")
    // pillar OMITTED (the GuardDecision shape can't disambiguate the detector).
    expect(f?.denyReason && "pillar" in f.denyReason).toBe(false)
    expect(f?.denyReason?.safeReason).toBe("dispatch guard blocked (security boundary)")
    expect(res.block.content).toContain("[denied · layer=stack]")
  })

  test("knob-ON: soft guard-deny carries the recoverable-posture safeReason", async () => {
    setKnob(true)
    const tool = makeTool("bash")
    const c = cfg({
      registry: new ToolRegistry([tool]),
      dispatchGuard: guardOf({
        kind: "deny",
        reason: "git push to protected branch 'main'",
        hardDeny: false,
      }),
    } as Partial<AgentConfig>)
    const res = await dispatchTool(call("bash", { command: "x" }), c, { mode: "default" })
    expect(res.preview).toBe("guard-deny")
    const f = permFailure(res.failure)
    expect(f?.denyReason?.layer).toBe("stack")
    expect(f?.denyReason?.safeReason).toBe("dispatch guard blocked (recoverable posture)")
  })

  test("knob-ON: guard-ask carries layer=stack + categorical safeReason", async () => {
    setKnob(true)
    const tool = makeTool("web_fetch")
    const c = cfg({
      registry: new ToolRegistry([tool]),
      dispatchGuard: guardOf({
        kind: "ask",
        reason:
          "host 'evil.example.com' not in network allowlist (size=2); per-request approval required.",
      }),
    } as Partial<AgentConfig>)
    const res = await dispatchTool(call("web_fetch", { url: "x" }), c, { mode: "default" })
    expect(res.preview).toBe("guard-ask")
    const f = permFailure(res.failure)
    expect(f?.denyReason?.layer).toBe("stack")
    expect(f?.denyReason?.safeReason).toBe("dispatch guard requested confirmation")
    expect(res.block.content).toContain("[denied · layer=stack]")
  })

  test("knob-ON: NO-LEAK — guard reason echoing a secret path never reaches safeReason/prefix", async () => {
    setKnob(true)
    const SECRET = "sk-live-DEADBEEF-guard-secret"
    const tool = makeTool("bash")
    const c = cfg({
      registry: new ToolRegistry([tool]),
      dispatchGuard: guardOf({
        kind: "deny",
        reason: `host '${SECRET}' not in network allowlist (size=1).`,
        hardDeny: true,
      }),
    } as Partial<AgentConfig>)
    const res = await dispatchTool(call("bash", { command: SECRET }), c, { mode: "default" })
    const f = permFailure(res.failure)
    expect(f?.denyReason?.safeReason).not.toContain(SECRET)
    // The structured field is categorical; the [denied ·] PREFIX (layer-only)
    // also carries no input. The agent-authored prose CONTENT may still echo it.
    const prefix = (res.block.content ?? "").split("]")[0] ?? ""
    expect(prefix).not.toContain(SECRET)
    expect(prefix).toContain("[denied · layer=stack")
  })

  test("knob-OFF: guard-deny byte-identical — NO failure key, NO prefix", async () => {
    setKnob(false)
    const tool = makeTool("bash")
    const c = cfg({
      registry: new ToolRegistry([tool]),
      dispatchGuard: guardOf({
        kind: "deny",
        reason: "git-write protection: protected on '.git/config'",
        hardDeny: true,
      }),
    } as Partial<AgentConfig>)
    const res = await dispatchTool(call("bash", { command: "x" }), c, { mode: "default" })
    expect(res.preview).toBe("guard-deny")
    expect(res.failure).toBeUndefined()
    expect("failure" in res).toBe(false)
    expect(res.block.content).not.toContain("[denied ·")
  })

  test("knob-OFF: guard-ask byte-identical — NO failure key, NO prefix", async () => {
    setKnob(false)
    const tool = makeTool("web_fetch")
    const c = cfg({
      registry: new ToolRegistry([tool]),
      dispatchGuard: guardOf({ kind: "ask", reason: "needs approval" }),
    } as Partial<AgentConfig>)
    const res = await dispatchTool(call("web_fetch", { url: "x" }), c, { mode: "default" })
    expect(res.preview).toBe("guard-ask")
    expect(res.failure).toBeUndefined()
    expect("failure" in res).toBe(false)
    expect(res.block.content).not.toContain("[denied ·")
  })
})
