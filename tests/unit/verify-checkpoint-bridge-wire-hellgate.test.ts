/**
 * ADR-0123 verify-checkpoint-bridge wiring (hellgate). Pins the contract:
 * the bridge is invoked EXACTLY when the verify-guard adapter clears a
 * finish attempt (Cursor's `markVerifiedV2` pattern). All other paths —
 * non-finish actions, blocked verdicts, shadowOdb absent — leave the
 * bridge untouched (default-OFF byte-identical).
 *
 * The wire point lives in `createVerifyGuard.decide` (PASS branch) and
 * the bridge construction lives in `buildGuardChain` (gated on
 * `config.shadowOdb !== undefined`). These tests exercise BOTH layers:
 * the adapter (synthetic bridge spy) AND the composer (synthetic ShadowOdb
 * with a spied `markVerified`).
 */

import { describe, expect, test } from "bun:test"
import { buildGuardChain, createVerifyGuard, type TurnGuardContext } from "@/agent/guards"
import type { AssembledMessage, RecoveryAction } from "@/agent/recovery"
import { createToolChoiceTurnState } from "@/agent/tool-choice"
import type { AgentConfig } from "@/agent/types"
import type { VerifyCheckpointBridge } from "@/agent/verify-checkpoint-bridge"
import { createVerifyGuardState } from "@/agent/verify-guard"
import type { Message } from "@/llm"
import { createWorkingMemory } from "@/memory"
import type { ShadowOdb } from "@/storage/shadow-odb"

const textMessage = (text: string): AssembledMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
})
const completedAction: RecoveryAction = { do: "completed" }

const ctx = (overrides: Partial<TurnGuardContext> = {}): TurnGuardContext => ({
  action: overrides.action ?? completedAction,
  message: overrides.message ?? textMessage("done"),
  wm: overrides.wm ?? createWorkingMemory<Message>(),
  history: overrides.history ?? [{ name: "edit" }, { name: "test_runner" }],
  toolChoiceState: overrides.toolChoiceState ?? createToolChoiceTurnState(),
  emit: overrides.emit ?? (() => {}),
})

/** Bridge spy — records every `onVerifySuccess` invocation. The body
 *  resolves immediately (the production bridge is no-throw / no-await
 *  from the caller's POV). */
const makeBridgeSpy = (): {
  bridge: VerifyCheckpointBridge
  calls: string[]
} => {
  const calls: string[] = []
  return {
    calls,
    bridge: {
      async onVerifySuccess(workspace) {
        calls.push(workspace)
      },
    },
  }
}

/** Minimal `ShadowOdb` fake — only `markVerified` is exercised; the
 *  other methods reject so an accidental call surfaces loudly. */
const makeOdbSpy = (
  opts: { throwOnMark?: boolean } = {},
): {
  odb: ShadowOdb
  markVerifiedCalls: string[]
} => {
  const markVerifiedCalls: string[] = []
  const reject = () => Promise.reject(new Error("not implemented in wire test"))
  return {
    markVerifiedCalls,
    odb: {
      init: reject,
      registerHead: reject,
      diffSinceLast: reject,
      diffWorkspaceSinceLast: reject,
      rewindToLast: reject,
      listSnapshots: reject,
      cleanup: reject,
      restorePartial: reject,
      async markVerified(workspaceRoot: string) {
        markVerifiedCalls.push(workspaceRoot)
        if (opts.throwOnMark) throw new Error("simulated markVerified failure")
      },
      rewindToVerified: reject,
    } as unknown as ShadowOdb,
  }
}

describe("verify-checkpoint-bridge wiring — hellgate", () => {
  test("(1) shadowOdb absent ⇒ bridge.onVerifySuccess NOT called on verify pass", () => {
    // buildGuardChain MUST omit the `verifyCheckpoint` arg when
    // `config.shadowOdb === undefined`, so the adapter's `if (verifyCheckpoint
    // !== undefined)` guard skips the call entirely. Direct test on the
    // adapter: no verifyCheckpoint arg ⇒ no bridge contact at all.
    const { bridge, calls } = makeBridgeSpy()
    const guard = createVerifyGuard({
      cfg: {},
      state: createVerifyGuardState(),
      // verifyCheckpoint OMITTED — mirrors `buildGuardChain` when
      // `config.shadowOdb` is absent.
    })
    // Force a clean PASS: history has an edit followed by a test_runner so
    // `decideVerifyGuard` returns {block:false}.
    const r = guard.decide(ctx({ history: [{ name: "edit" }, { name: "test_runner" }] }))
    expect(r).toBeUndefined()
    expect(calls).toEqual([])
    // Sanity: bridge was never even touched — calls array is the spy.
    void bridge // keep reference so lint doesn't complain
  })

  test("(2) shadowOdb wired + verify pass ⇒ bridge.onVerifySuccess called with cwd", async () => {
    // Compose through buildGuardChain so the wiring contract (bridge built
    // from config.shadowOdb, cwd threaded from config.cwd) is end-to-end.
    const { odb, markVerifiedCalls } = makeOdbSpy()
    const config = {
      cwd: "/abs/workspace/A",
      verifyGuard: {},
      shadowOdb: odb,
    } as unknown as AgentConfig
    const chain = buildGuardChain({
      config,
      verifyGuardState: createVerifyGuardState(),
      closeoutGuardState: undefined,
    })
    expect(chain).toHaveLength(1)
    expect(chain[0]?.name).toBe("verify")
    const r = chain[0]?.decide(ctx({ history: [{ name: "edit" }, { name: "test_runner" }] }))
    expect(r).toBeUndefined()
    // The bridge fires synchronously (no-await), but `markVerified` is
    // awaited inside the bridge. Yield one microtask so the promise lands.
    await Promise.resolve()
    await Promise.resolve()
    expect(markVerifiedCalls).toEqual(["/abs/workspace/A"])
  })

  test("(3) odb.markVerified throws ⇒ verify-guard returns its normal outcome (no throw escapes)", async () => {
    // The bridge swallows; the adapter does `void bridge.onVerifySuccess(...)`
    // so an internal throw inside the awaited body becomes an unhandled
    // rejection at WORST — never a synchronous throw out of `decide`. The
    // verify gate must be unaffected.
    const { odb, markVerifiedCalls } = makeOdbSpy({ throwOnMark: true })
    const config = {
      cwd: "/abs/workspace/B",
      verifyGuard: {},
      shadowOdb: odb,
    } as unknown as AgentConfig
    const chain = buildGuardChain({
      config,
      verifyGuardState: createVerifyGuardState(),
      closeoutGuardState: undefined,
    })
    let threw: unknown = null
    let r: unknown = "sentinel"
    try {
      r = chain[0]?.decide(ctx({ history: [{ name: "edit" }, { name: "test_runner" }] }))
    } catch (e) {
      threw = e
    }
    expect(threw).toBeNull()
    expect(r).toBeUndefined() // verify PASS verdict preserved
    // The bridge's catch swallows the markVerified throw — even after the
    // microtasks land, no exception surfaces.
    await Promise.resolve()
    await Promise.resolve()
    expect(markVerifiedCalls).toEqual(["/abs/workspace/B"])
  })

  test("(4) verify FAILS ⇒ bridge.onVerifySuccess NOT called (only pass triggers)", async () => {
    // History: edit with NO verify after ⇒ `decideVerifyGuard` blocks
    // (presence branch). The adapter takes the BLOCK path, which must NOT
    // touch the bridge.
    const { odb, markVerifiedCalls } = makeOdbSpy()
    const config = {
      cwd: "/abs/workspace/C",
      verifyGuard: {},
      shadowOdb: odb,
    } as unknown as AgentConfig
    const chain = buildGuardChain({
      config,
      verifyGuardState: createVerifyGuardState(),
      closeoutGuardState: undefined,
    })
    const r = chain[0]?.decide(
      ctx({
        history: [{ name: "edit" }], // no verify after the edit ⇒ block
      }),
    )
    expect(r).toEqual({ continue: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(markVerifiedCalls).toEqual([])
  })

  test("(5) multiple turn passes ⇒ bridge called once per pass (cumulative)", async () => {
    // Each PASS through the same guard instance fires onVerifySuccess once.
    // The bridge wiring is per-CHAIN (one adapter instance per session), so
    // repeat invocations of `decide(...)` accumulate calls deterministically.
    const { odb, markVerifiedCalls } = makeOdbSpy()
    const config = {
      cwd: "/abs/workspace/D",
      verifyGuard: {},
      shadowOdb: odb,
    } as unknown as AgentConfig
    const chain = buildGuardChain({
      config,
      verifyGuardState: createVerifyGuardState(),
      closeoutGuardState: undefined,
    })
    const guard = chain[0]
    expect(guard).toBeDefined()
    const passHistory = [{ name: "edit" }, { name: "test_runner" }]
    expect(guard?.decide(ctx({ history: passHistory }))).toBeUndefined()
    expect(guard?.decide(ctx({ history: passHistory }))).toBeUndefined()
    expect(guard?.decide(ctx({ history: passHistory }))).toBeUndefined()
    await Promise.resolve()
    await Promise.resolve()
    expect(markVerifiedCalls).toEqual(["/abs/workspace/D", "/abs/workspace/D", "/abs/workspace/D"])
  })
})
