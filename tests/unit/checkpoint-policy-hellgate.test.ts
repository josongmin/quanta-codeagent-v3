/**
 * ★ CONTRACT — ADR-0121: auto-checkpoint policy for the shadow git ODB.
 *
 * 20-case hellgate organized in six blocks:
 *  A. mode="off" byte-identical          (HELL-A1..A3)
 *  B. default destructiveness oracle      (HELL-B4..B6)
 *  C. mode="pre-destructive"              (HELL-C7..C10)
 *  D. mode="per-mutating"                 (HELL-D11..D13)
 *  E. mode="per-turn"                     (HELL-E14..E16)
 *  F. withAutoCheckpoint wrap             (HELL-F17..F20)
 *
 * Everything is hermetic: tests use hand-rolled fake `ShadowOdb`, fake
 * `EffectChannel`, fake `Tool`, and synthesize `ToolUseBlock` / `ToolContext`
 * inline. No real git, no tmpdir, no registry — every collaborator is a
 * closed-port injection.
 */

import { describe, expect, test } from "bun:test"
import {
  type CheckpointPolicy,
  type CheckpointTriggerMode,
  type DestructivenessOracle,
  defaultCheckpointPolicy,
  defaultDestructivenessOracle,
  withAutoCheckpoint,
} from "@/agent/checkpoint-policy"
import type { EffectChannel, ToolRequest, ToolResultEnvelope } from "@/agent/effect-channel"
import type { ToolUseBlock } from "@/llm"
import type { ShadowOdb } from "@/storage"
import type { Tool, ToolContext, ToolResult } from "@/tool"

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Hand-rolled fake `ShadowOdb`. Every method throws "not implemented" so an
 *  accidental call surfaces loudly — tests opt in to the methods they need. */
const makeFakeOdb = (over: Partial<ShadowOdb>): ShadowOdb => {
  const ni = (name: string) => async (): Promise<never> => {
    throw new Error(`fake odb: ${name} not implemented`)
  }
  return {
    init: over.init ?? (ni("init") as ShadowOdb["init"]),
    registerHead: over.registerHead ?? (ni("registerHead") as ShadowOdb["registerHead"]),
    diffSinceLast: over.diffSinceLast ?? (ni("diffSinceLast") as ShadowOdb["diffSinceLast"]),
    diffWorkspaceSinceLast:
      over.diffWorkspaceSinceLast ??
      (ni("diffWorkspaceSinceLast") as ShadowOdb["diffWorkspaceSinceLast"]),
    rewindToLast: over.rewindToLast ?? (ni("rewindToLast") as ShadowOdb["rewindToLast"]),
    restorePartial: over.restorePartial ?? (ni("restorePartial") as ShadowOdb["restorePartial"]),
    markVerified: over.markVerified ?? (ni("markVerified") as ShadowOdb["markVerified"]),
    rewindToVerified:
      over.rewindToVerified ?? (ni("rewindToVerified") as ShadowOdb["rewindToVerified"]),
    listSnapshots: over.listSnapshots ?? (ni("listSnapshots") as ShadowOdb["listSnapshots"]),
    cleanup: over.cleanup ?? (ni("cleanup") as ShadowOdb["cleanup"]),
  }
}

/** A do-nothing async generator used by every fake tool's `execute`. The
 *  hellgate never invokes execute (the policy only consumes `isReadOnly`); the
 *  yield is unreachable but satisfies biome's `useYield` rule. */
async function* fakeExecute(): AsyncIterable<never> {
  if (false as boolean) yield undefined as never
  throw new Error("fake tool: execute not implemented")
}

/** Build a tool stub with a configurable `isReadOnly`. The hellgate uses only
 *  the `isReadOnly` surface — everything else throws if accidentally called. */
const makeTool = (readOnly: boolean, name = "fake_tool"): Tool => ({
  name,
  description: "",
  inputSchema: {
    parse: (i: unknown) => i,
    safeParse: (i: unknown) => ({ success: true as const, data: i }),
  } as unknown as Tool["inputSchema"],
  isReadOnly: () => readOnly,
  isConcurrencySafe: () => readOnly,
  execute: fakeExecute,
})

/** A tool whose `isReadOnly` THROWS — used for HELL-B6 fail-open coverage. */
const makeThrowingReadonlyTool = (): Tool => ({
  name: "throwing_tool",
  description: "",
  inputSchema: {
    parse: (i: unknown) => i,
    safeParse: (i: unknown) => ({ success: true as const, data: i }),
  } as unknown as Tool["inputSchema"],
  isReadOnly: () => {
    throw new Error("isReadOnly is broken")
  },
  isConcurrencySafe: () => false,
  execute: fakeExecute,
})

const makeCall = (name = "fake_tool"): ToolUseBlock => ({
  type: "tool_use",
  id: `call-${name}`,
  name,
  input: {},
})

const makeCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
  cwd: "/ws",
  signal: new AbortController().signal,
  ...over,
})

const makeReq = (over: Partial<ToolRequest> = {}): ToolRequest => ({
  call: makeCall(),
  ctx: makeCtx(),
  ...over,
})

/** Build a policy with all 4 modes. `oracle` defaults to the package default. */
const buildPolicy = (
  mode: CheckpointTriggerMode,
  odb: ShadowOdb,
  oracle?: DestructivenessOracle,
): CheckpointPolicy =>
  defaultCheckpointPolicy({
    mode,
    odb,
    ...(oracle !== undefined ? { oracle } : {}),
  })

/** Build a fake inner EffectChannel that records every call and returns the
 *  caller-supplied envelope. Optionally throws inside `execute`. */
interface FakeChannel {
  channel: EffectChannel
  calls: ToolRequest[]
}
const fakeChannel = (
  result: ToolResult = { ok: true, output: "ok" },
  opts?: { throwOnExecute?: boolean },
): FakeChannel => {
  const calls: ToolRequest[] = []
  const channel: EffectChannel = {
    async execute(req: ToolRequest): Promise<ToolResultEnvelope> {
      calls.push(req)
      if (opts?.throwOnExecute === true) throw new Error("inner blew up")
      return { result, durationMs: 0 }
    },
  }
  return { channel, calls }
}

/* ================================================================== */
/* A. mode="off" — byte-identical                                      */
/* ================================================================== */

describe('CheckpointPolicy mode="off" (HELL-A1..A3)', () => {
  test("HELL-A1: destructive call ⇒ shouldAnchorBefore=false, odb.registerHead never called", async () => {
    let registerHeadCalls = 0
    const odb = makeFakeOdb({
      registerHead: async () => {
        registerHeadCalls += 1
        return "a".repeat(40)
      },
    })
    const policy = buildPolicy("off", odb)
    const tool = makeTool(false) // destructive
    const decision = await policy.shouldAnchorBefore(tool, makeCall(), makeCtx())
    expect(decision).toBe(false)
    expect(registerHeadCalls).toBe(0)
  })

  test("HELL-A2: withAutoCheckpoint(inner, off-policy) ⇒ byte-identical to inner (no extra calls)", async () => {
    let registerHeadCalls = 0
    const odb = makeFakeOdb({
      registerHead: async () => {
        registerHeadCalls += 1
        return "a".repeat(40)
      },
    })
    const policy = buildPolicy("off", odb)
    const { channel: inner, calls: innerCalls } = fakeChannel()
    const wrapped = withAutoCheckpoint(inner, policy, { mode: "off", odb }, () => makeTool(false))
    const env = await wrapped.execute(makeReq())
    expect(env.result.ok).toBe(true)
    expect(innerCalls.length).toBe(1)
    expect(registerHeadCalls).toBe(0)
  })

  test('HELL-A3: mode="off" + read-only call ⇒ shouldAnchorBefore=false', async () => {
    const odb = makeFakeOdb({})
    const policy = buildPolicy("off", odb)
    const tool = makeTool(true) // read-only
    expect(await policy.shouldAnchorBefore(tool, makeCall(), makeCtx())).toBe(false)
  })
})

/* ================================================================== */
/* B. Default destructiveness oracle                                   */
/* ================================================================== */

describe("defaultDestructivenessOracle (HELL-B4..B6)", () => {
  test("HELL-B4: readonly=true tool ⇒ oracle=false", () => {
    expect(defaultDestructivenessOracle(makeTool(true), makeCall(), makeCtx())).toBe(false)
  })

  test("HELL-B5: readonly=false tool ⇒ oracle=true", () => {
    expect(defaultDestructivenessOracle(makeTool(false), makeCall(), makeCtx())).toBe(true)
  })

  test("HELL-B6: tool.isReadOnly() throws ⇒ oracle returns false (fail-open, no throw)", () => {
    expect(defaultDestructivenessOracle(makeThrowingReadonlyTool(), makeCall(), makeCtx())).toBe(
      false,
    )
  })
})

/* ================================================================== */
/* C. mode="pre-destructive"                                           */
/* ================================================================== */

describe('CheckpointPolicy mode="pre-destructive" (HELL-C7..C10)', () => {
  test("HELL-C7: destructive call ⇒ shouldAnchorBefore=true", async () => {
    const policy = buildPolicy("pre-destructive", makeFakeOdb({}))
    expect(
      await policy.shouldAnchorBefore(makeTool(false), makeCall(), makeCtx({ turnId: "t1" })),
    ).toBe(true)
  })

  test("HELL-C8: read-only call ⇒ shouldAnchorBefore=false", async () => {
    const policy = buildPolicy("pre-destructive", makeFakeOdb({}))
    expect(
      await policy.shouldAnchorBefore(makeTool(true), makeCall(), makeCtx({ turnId: "t1" })),
    ).toBe(false)
  })

  test("HELL-C9: second destructive call in SAME turn (same turnId) ⇒ deduped, returns false", async () => {
    const policy = buildPolicy("pre-destructive", makeFakeOdb({}))
    const ctx = makeCtx({ turnId: "t1" })
    const tool = makeTool(false)
    const first = await policy.shouldAnchorBefore(tool, makeCall(), ctx)
    expect(first).toBe(true)
    // The caller-side wrap records the anchor on a successful first hit.
    policy.recordAnchored({ workspace: ctx.cwd, turnId: "t1" })
    const second = await policy.shouldAnchorBefore(tool, makeCall("edit"), ctx)
    expect(second).toBe(false)
  })

  test("HELL-C10: destructive in turn-1 then turn-2 ⇒ BOTH fire (different turnId)", async () => {
    const policy = buildPolicy("pre-destructive", makeFakeOdb({}))
    const tool = makeTool(false)
    const ctx1 = makeCtx({ turnId: "t1" })
    const r1 = await policy.shouldAnchorBefore(tool, makeCall(), ctx1)
    policy.recordAnchored({ workspace: ctx1.cwd, turnId: "t1" })
    const ctx2 = makeCtx({ turnId: "t2" })
    const r2 = await policy.shouldAnchorBefore(tool, makeCall(), ctx2)
    expect(r1).toBe(true)
    expect(r2).toBe(true)
  })
})

/* ================================================================== */
/* D. mode="per-mutating"                                              */
/* ================================================================== */

describe('CheckpointPolicy mode="per-mutating" (HELL-D11..D13)', () => {
  test("HELL-D11: every destructive call ⇒ always true (NO dedup)", async () => {
    const policy = buildPolicy("per-mutating", makeFakeOdb({}))
    const tool = makeTool(false)
    const ctx = makeCtx({ turnId: "t1" })
    expect(await policy.shouldAnchorBefore(tool, makeCall(), ctx)).toBe(true)
    policy.recordAnchored({ workspace: ctx.cwd, turnId: "t1" })
    // record does not affect per-mutating; second call still fires.
    expect(await policy.shouldAnchorBefore(tool, makeCall(), ctx)).toBe(true)
  })

  test("HELL-D12: read-only call ⇒ shouldAnchorBefore=false", async () => {
    const policy = buildPolicy("per-mutating", makeFakeOdb({}))
    expect(
      await policy.shouldAnchorBefore(makeTool(true), makeCall(), makeCtx({ turnId: "t1" })),
    ).toBe(false)
  })

  test("HELL-D13: 5 sequential destructive calls ⇒ 5 anchors (per-mutating, no dedup)", async () => {
    const policy = buildPolicy("per-mutating", makeFakeOdb({}))
    const tool = makeTool(false)
    const ctx = makeCtx({ turnId: "t1" })
    let anchored = 0
    for (let i = 0; i < 5; i += 1) {
      if (await policy.shouldAnchorBefore(tool, makeCall(`call-${i}`), ctx)) {
        anchored += 1
        policy.recordAnchored({ workspace: ctx.cwd, turnId: "t1" })
      }
    }
    expect(anchored).toBe(5)
  })
})

/* ================================================================== */
/* E. shouldAnchorAfterTurn — the deleted `per-turn` live path (ALBB-21) */
/* ================================================================== */

// ALBB-21 — the `"per-turn"` trigger MODE was DELETED (it had zero production
// callers: no turn-epilogue site ever invoked `shouldAnchorAfterTurn`, so
// selecting it produced NO anchors — a wired-but-dead live path). The method
// SURVIVES on the port (the granular wrapper delegates it for the remaining
// grains) but no configured mode selects a turn-epilogue anchor, so it now
// ALWAYS returns false. These tests PIN that dead-path removal: reintroducing a
// mode that makes `shouldAnchorAfterTurn` return true turns them RED.
describe("CheckpointPolicy shouldAnchorAfterTurn — dead per-turn path removed (HELL-E14..E16)", () => {
  test("HELL-E14: shouldAnchorAfterTurn returns false for every remaining mode", async () => {
    for (const mode of ["off", "pre-destructive", "per-mutating"] as const) {
      const policy = buildPolicy(mode, makeFakeOdb({}))
      expect(await policy.shouldAnchorAfterTurn("t1", "/ws")).toBe(false)
    }
  })

  test("HELL-E15: recordAnchored does not flip shouldAnchorAfterTurn to true (no live turn-epilogue anchor)", async () => {
    const policy = buildPolicy("pre-destructive", makeFakeOdb({}))
    policy.recordAnchored({ workspace: "/ws", turnId: "t1" })
    expect(await policy.shouldAnchorAfterTurn("t1", "/ws")).toBe(false)
    expect(await policy.shouldAnchorAfterTurn("t2", "/ws")).toBe(false)
  })

  test("HELL-E16: empty turnId ⇒ still false (no dedup window, still no anchor)", async () => {
    const policy = buildPolicy("per-mutating", makeFakeOdb({}))
    expect(await policy.shouldAnchorAfterTurn("", "/ws")).toBe(false)
  })
})

/* ================================================================== */
/* F. withAutoCheckpoint wrap                                          */
/* ================================================================== */

describe("withAutoCheckpoint wrap (HELL-F17..F20)", () => {
  test('HELL-F17: destructive call + mode="pre-destructive" ⇒ odb.registerHead called BEFORE inner.execute', async () => {
    const callOrder: string[] = []
    const odb = makeFakeOdb({
      registerHead: async () => {
        callOrder.push("registerHead")
        return "a".repeat(40)
      },
    })
    const policy = buildPolicy("pre-destructive", odb)
    const { channel: inner } = fakeChannel({ ok: true, output: "x" })
    const orderInner: EffectChannel = {
      async execute(req): Promise<ToolResultEnvelope> {
        callOrder.push("inner.execute")
        return await inner.execute(req)
      },
    }
    const wrapped = withAutoCheckpoint(orderInner, policy, { mode: "pre-destructive", odb }, () =>
      makeTool(false),
    )
    await wrapped.execute(makeReq({ ctx: makeCtx({ turnId: "t1" }) }))
    expect(callOrder).toEqual(["registerHead", "inner.execute"])
  })

  test("HELL-F18: inner.execute throws ⇒ wrap re-throws (does NOT swallow tool errors)", async () => {
    const odb = makeFakeOdb({
      registerHead: async () => "a".repeat(40),
    })
    const policy = buildPolicy("pre-destructive", odb)
    const { channel: throwingInner } = fakeChannel(
      { ok: true, output: "x" },
      {
        throwOnExecute: true,
      },
    )
    const wrapped = withAutoCheckpoint(
      throwingInner,
      policy,
      { mode: "pre-destructive", odb },
      () => makeTool(false),
    )
    await expect(wrapped.execute(makeReq({ ctx: makeCtx({ turnId: "t1" }) }))).rejects.toThrow(
      "inner blew up",
    )
  })

  test("HELL-F19: odb.registerHead throws ⇒ swallowed; inner.execute STILL runs; result returned normally", async () => {
    const odb = makeFakeOdb({
      registerHead: async () => {
        throw new Error("shadow odb is sad")
      },
    })
    const policy = buildPolicy("pre-destructive", odb)
    const { channel: inner, calls: innerCalls } = fakeChannel({ ok: true, output: "happy" })
    const wrapped = withAutoCheckpoint(inner, policy, { mode: "pre-destructive", odb }, () =>
      makeTool(false),
    )
    const env = await wrapped.execute(makeReq({ ctx: makeCtx({ turnId: "t1" }) }))
    expect(env.result).toEqual({ ok: true, output: "happy" })
    expect(innerCalls.length).toBe(1)
  })

  test("HELL-F20: shouldAnchorAfterTurn is inert for any remaining mode (deleted per-turn path)", async () => {
    // ALBB-21 — with the `per-turn` mode removed, the turn-epilogue predicate is
    // always false regardless of turnId. Empty turnId (the loop receiving an
    // absent turnId source) is still false — no anchor spam, no live path.
    let afterCalls = 0
    const odb = makeFakeOdb({})
    const policy = buildPolicy("pre-destructive", odb)
    const decision = await policy.shouldAnchorAfterTurn("", "/ws")
    if (decision) afterCalls += 1
    expect(decision).toBe(false)
    expect(afterCalls).toBe(0)
  })
})
