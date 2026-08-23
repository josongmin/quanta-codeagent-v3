/**
 * ★ HELLGATE — the sandbox-escalation handler is a PER-SESSION `AgentConfig`
 *   slot projected onto `ToolContext`, NOT a process-global module singleton.
 *
 * PINNED BUG (pre-fix): `src/tool/bash/sandbox-escalation-wire.ts` held
 * `let installed: BashSandboxEscalationHandler | undefined` at MODULE scope, and
 * the installer (`maybeWireBashSandboxEscalation`) closed over SESSION-UNIQUE
 * state — the session's `PermissionStore`, its `onConfirm` HITL authority, and
 * its escalation cap — before writing that global. One process hosting two
 * sessions (`src/sdk/embed.ts` calls `assembleAgentConfig` on EVERY `run()`)
 * therefore had last-writer-wins:
 *   - session A's sandbox block prompted session B's `onConfirm`, and
 *   - the ADR-0046 post-denial override landed in session B's store;
 *   - a knob-LESS second `run()` executed `__setBashSandboxEscalationHandler(
 *     undefined)` and DISARMED the still-live session A.
 *
 * FIX SHAPE (the `writeBudget` 2-stage mirror):
 *   1. per-SESSION mint — `maybeWireBashSandboxEscalation` sets
 *      `cfg.bashSandboxEscalation` (handler + its ONE cap) instead of a global;
 *   2. per-TURN projection — `buildToolContext` projects that slot onto
 *      `ToolContext.sandboxEscalation`, which `bash` reads through
 *      `ShellToolContext`.
 *
 * WHY STAGE 1 MUST BE THE MINT POINT (the naive-fix hellgate, test C): if the
 * handler + cap were built INSIDE `buildToolContext`, the cap's closure `Map`
 * would be re-created on EVERY tool call, so `admit()` would always return
 * `count: 1` and `QUANTA_SANDBOX_ESCALATION_MAX` would be silently inert. Test C
 * builds a FRESH `ToolContext` per bash call (exactly what dispatch does) from
 * ONE config and proves the cap still accumulates to exhaustion.
 *
 * Determinism: no Date.now/Math.random in assertions; the permission stores and
 * the escalation cap are the REAL ones, driven by injected fake `onConfirm`
 * spies and a fake per-call sandbox that always denies.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ConfirmDecision } from "@/agent"
import { buildToolContext } from "@/agent/dispatch/tool-context"
import { resolveCollaborationMode } from "@/agent/mode"
import type { AgentConfig } from "@/agent/types"
import { maybeWireBashSandboxEscalation } from "@/host/runtime/sandbox-escalation-wire"
import type { PermissionStore, PostDenialAction, ToolAction } from "@/permission"
import {
  __resetDefaultPermissionStore,
  createPermissionStore,
  hasPostDenialOverride,
} from "@/permission"
import { __resetShellSandbox } from "@/runtime"
import type { PerCallSandboxAvailability, PerCallSandboxPort } from "@/runtime/os-sandbox"
import { __resetRuntimeConfig, runtimeConfigFromEnv } from "@/shared"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool"
import { bashTool } from "@/tool/bash"
import { __setBashPerCallSandboxFactory } from "@/tool/bash/per-call-factory"

const dir = mkdtempSync(join(tmpdir(), "sbxesc-per-session-"))

/** A fake per-call sandbox that APPLIES (`sandboxApplied:true`) and rewrites the
 *  argv so the SANDBOXED spawn fails with a high-confidence Seatbelt-deny
 *  stderr. The UNSANDBOXED re-run (no per-call wrap) runs the ORIGINAL command,
 *  which succeeds — so an APPROVED escalation flips failure → success. */
const blockingSandbox = (): PerCallSandboxPort => ({
  availability: (): PerCallSandboxAvailability => ({ supported: true }),
  wrap: () => ({
    argv: ["bash", "-lc", 'echo "Sandbox: app(1) deny(1) file-write-data" 1>&2; exit 1'],
    sandboxApplied: true,
  }),
})

/** One session's observable identity: its OWN permission store + an onConfirm
 *  spy that records every consult. */
interface Session {
  readonly label: string
  readonly store: PermissionStore
  readonly confirms: ToolAction[]
  readonly cfg: AgentConfig
}

const KNOB_ON = { QUANTA_SANDBOX_ESCALATION: "1" } as const

/** Assemble a session-shaped `AgentConfig` and run the REAL host wire over it.
 *  This is the composition-root call the assembler / CLI compose both make. */
const mintSession = async (
  label: string,
  approve: boolean,
  env: Record<string, string>,
): Promise<Session> => {
  const store = createPermissionStore({
    filePath: join(dir, `perm-${label}.json`),
    debounceMs: 0,
  })
  await store.load()
  const confirms: ToolAction[] = []
  const onConfirm = async (a: ToolAction): Promise<ConfirmDecision> => {
    confirms.push(a)
    return { decision: approve ? "allow" : "deny" }
  }
  const cfg = {
    llm: { model: "t", async *stream() {} },
    stream: { emit: () => {} },
    registry: { register: () => undefined, get: () => undefined, list: () => [] },
    permission: { mode: "acceptEdits" },
    messages: [],
    system: "s",
    cwd: dir,
    maxTurns: 4,
    signal: new AbortController().signal,
    run: { turn: 0 },
    onConfirm,
    admissibility: { permissionStore: store },
  } as unknown as AgentConfig
  maybeWireBashSandboxEscalation(cfg, runtimeConfigFromEnv(env))
  return { label, store, confirms, cfg }
}

/** The REAL per-turn dispatch projection — a FRESH ToolContext per tool call,
 *  exactly as `dispatchTool` builds one. */
const ctxOf = (s: Session): ToolContext =>
  buildToolContext({
    config: s.cfg,
    workingState: undefined,
    collabMode: resolveCollaborationMode({ planMode: false }),
    toolCallId: `tc-${s.label}`,
  })

const runBash = async (command: string, ctx: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of bashTool.execute(
    { command, mode: "read" } as never,
    ctx,
  ) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

/** The post-denial key the host wire derives for a bash escalation (threadId
 *  falls back to `"root"` when the ctx carries no agentLabel). */
const denialKeyFor = (command: string): PostDenialAction => ({
  threadId: "root",
  tool: "bash",
  workdir: dir,
  args: { command },
})

beforeEach(() => {
  __resetShellSandbox()
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
  __setBashPerCallSandboxFactory(() => blockingSandbox())
})

afterEach(() => {
  __resetShellSandbox()
  __resetRuntimeConfig()
  __setBashPerCallSandboxFactory(undefined)
  __resetDefaultPermissionStore()
})

describe("HELLGATE A — two sessions in ONE process do NOT cross-wire", () => {
  test("A's sandbox block consults ONLY A's onConfirm and records the override in ONLY A's store", async () => {
    const a = await mintSession("A", /* approve */ true, KNOB_ON)
    // B is minted AFTER A — under the module-global seam B is the LAST WRITER and
    // therefore hijacks A's escalation (its spy fires, its store gets the record).
    const b = await mintSession("B", /* approve */ false, KNOB_ON)

    // Both sessions must carry their OWN handler on their OWN config.
    expect(a.cfg.bashSandboxEscalation).toBeDefined()
    expect(b.cfg.bashSandboxEscalation).toBeDefined()
    expect(a.cfg.bashSandboxEscalation).not.toBe(b.cfg.bashSandboxEscalation)
    // …and the per-turn projection must carry it to the tool.
    expect(ctxOf(a).sandboxEscalation).toBe(a.cfg.bashSandboxEscalation)
    expect(ctxOf(b).sandboxEscalation).toBe(b.cfg.bashSandboxEscalation)

    const command = "echo a-unsandboxed-ok"
    const r = await runBash(command, ctxOf(a))

    // A's authority APPROVED ⇒ the unsandboxed re-run flipped failure → success.
    // (Under the global seam B's DENY authority answered, so this is `false`.)
    expect(r.ok).toBe(true)
    expect(r.output).toContain("a-unsandboxed-ok")
    expect(r.output.toLowerCase()).toContain("approved")

    // GROUND TRUTH 1 — ONLY A's HITL authority was consulted.
    expect(a.confirms.length).toBeGreaterThan(0)
    expect(b.confirms).toEqual([])

    // GROUND TRUTH 2 — the ADR-0046 override landed in A's store, NOT B's.
    const key = denialKeyFor(command)
    expect(hasPostDenialOverride(key, { store: a.store })).toBe(true)
    expect(hasPostDenialOverride(key, { store: b.store })).toBe(false)

    await a.store.flush().catch(() => {})
    await b.store.flush().catch(() => {})
  })
})

describe("HELLGATE B — a knob-LESS second session does NOT disarm a live sibling", () => {
  test("minting a knob-off session leaves the armed session's handler intact and FIRING", async () => {
    const armed = await mintSession("armed", /* approve */ true, KNOB_ON)
    expect(armed.cfg.bashSandboxEscalation).toBeDefined()

    // A second `run()` with NO knob — under the global seam this executed
    // `__setBashSandboxEscalationHandler(undefined)` and disarmed `armed`.
    const plain = await mintSession("plain", /* approve */ true, {})
    expect(plain.cfg.bashSandboxEscalation).toBeUndefined()
    // Default-OFF must not even stamp an own property (byte-identical config).
    expect(Object.hasOwn(plain.cfg, "bashSandboxEscalation")).toBe(false)

    // The armed session is STILL armed.
    expect(armed.cfg.bashSandboxEscalation).toBeDefined()
    const r = await runBash("echo still-armed-ok", ctxOf(armed))
    expect(r.ok).toBe(true)
    expect(r.output).toContain("still-armed-ok")
    expect(r.output).toContain("blocked by the OS sandbox")

    // CONTROL — the knob-off session escalates NOTHING (its ctx has no seam), so
    // the same block surfaces as a plain failure. This proves the assertion above
    // is about the SLOT, not about the bash tool retrying on its own.
    expect(ctxOf(plain).sandboxEscalation).toBeUndefined()
    const off = await runBash("echo never-unsandboxed", ctxOf(plain))
    expect(off.ok).toBe(false)
    expect(off.output).not.toContain("never-unsandboxed")
    expect(off.output).not.toContain("blocked by the OS sandbox")

    await armed.store.flush().catch(() => {})
    await plain.store.flush().catch(() => {})
  })
})

describe("HELLGATE C — the cap is minted PER SESSION, not per tool call", () => {
  test("QUANTA_SANDBOX_ESCALATION_MAX accumulates across tool calls that each build a FRESH ToolContext", async () => {
    const s = await mintSession("cap", /* approve */ true, {
      ...KNOB_ON,
      QUANTA_SANDBOX_ESCALATION_MAX: "2",
    })

    // Each call rebuilds the ctx from the SAME config — the exact per-turn
    // projection dispatch performs. A cap re-minted inside that projection would
    // reset the counter and admit all three (the naive-fix failure mode).
    const first = await runBash("echo cap-1", ctxOf(s))
    expect(first.ok).toBe(true)
    expect(first.output).toContain("cap-1")

    const second = await runBash("echo cap-2", ctxOf(s))
    expect(second.ok).toBe(true)
    expect(second.output).toContain("cap-2")

    // Third escalation request in the same (threadId, turnId) exceeds max=2.
    const third = await runBash("echo cap-3", ctxOf(s))
    expect(third.ok).toBe(false)
    expect(third.output).not.toContain("cap-3")
    expect(third.output.toLowerCase()).toContain("exhausted")
    expect(third.output).toContain("3/2")

    await s.store.flush().catch(() => {})
  })

  test("two sessions keep INDEPENDENT caps (A exhausted ⇏ B exhausted)", async () => {
    const a = await mintSession("capA", true, { ...KNOB_ON, QUANTA_SANDBOX_ESCALATION_MAX: "1" })
    const b = await mintSession("capB", true, { ...KNOB_ON, QUANTA_SANDBOX_ESCALATION_MAX: "1" })

    expect((await runBash("echo a1", ctxOf(a))).ok).toBe(true)
    const aExhausted = await runBash("echo a2", ctxOf(a))
    expect(aExhausted.ok).toBe(false)
    expect(aExhausted.output.toLowerCase()).toContain("exhausted")

    // B's cap is untouched by A's exhaustion.
    const b1 = await runBash("echo b1", ctxOf(b))
    expect(b1.ok).toBe(true)
    expect(b1.output).toContain("b1")

    await a.store.flush().catch(() => {})
    await b.store.flush().catch(() => {})
  })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
