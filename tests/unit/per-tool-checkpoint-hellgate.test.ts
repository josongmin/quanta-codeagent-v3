/**
 * ★ CONTRACT — ADR-0203 + ADR-0205: per-tool-call checkpoint granularity +
 * 3-way restore (Cline / Cursor / Codex absorption).
 *
 * 22-case hellgate in seven blocks:
 *
 *   A. granularity="turn" byte-identical parity        (HELL-A1..A3)
 *   B. granularity="tool" — per-call cardinality       (HELL-B4..B6)
 *   C. recordAnchorSha — typed registry invariants     (HELL-C7..C10)
 *   D. 3-way restore orthogonality                     (HELL-D11..D15)
 *   E. typed restore failures                          (HELL-E16..E18)
 *   F. /rewind-tool slash routing                      (HELL-F19..F21)
 *   G. tag collision + abort-mid-checkpoint            (HELL-G22)
 *
 * Hermetic: every dependency is a hand-rolled in-memory fake. NO real git,
 * NO tmpdir, NO loop, NO registry.
 */

import { describe, expect, test } from "bun:test"
import { defaultCheckpointPolicy } from "@/agent/checkpoint-policy"
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import {
  defaultGranularCheckpointPolicy,
  defaultThreeWayRestore,
  type GranularCheckpointPolicy,
} from "@/agent/per-tool-checkpoint"
import { __test as restoreTest } from "@/agent/per-tool-checkpoint/three-way-restore"
import type { Message, ToolUseBlock } from "@/llm"
import { type ShadowOdb, ShadowOdbError } from "@/storage/shadow-odb"
import type { Tool, ToolContext } from "@/tool"
import { __test as rewindToolTest } from "../../src/apps/cli/rewind-tool-cmd"

/* ------------------------------------------------------------------ */
/* hand-rolled fakes                                                   */
/* ------------------------------------------------------------------ */

/** Build a fake `ShadowOdb`. Every method throws "not implemented" unless
 *  the caller overrode it — accidental calls surface loudly. */
const makeFakeOdb = (over: Partial<ShadowOdb>): ShadowOdb => {
  const ni = (n: string) => async (): Promise<never> => {
    throw new Error(`fake odb: ${n} not implemented`)
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
    rewindToRef: ni("rewindToRef") as ShadowOdb["rewindToRef"],
    restorePartialFromRef: ni("restorePartialFromRef") as ShadowOdb["restorePartialFromRef"],
    diffSinceRef: ni("diffSinceRef") as ShadowOdb["diffSinceRef"],
    cleanup: over.cleanup ?? (ni("cleanup") as ShadowOdb["cleanup"]),
  }
}

async function* fakeExec(): AsyncIterable<never> {
  if (false as boolean) yield undefined as never
  throw new Error("fake tool: execute not implemented")
}

const makeTool = (readOnly: boolean, name = "edit_file"): Tool => ({
  name,
  description: "",
  inputSchema: {
    parse: (i: unknown) => i,
    safeParse: (i: unknown) => ({ success: true as const, data: i }),
  } as unknown as Tool["inputSchema"],
  isReadOnly: () => readOnly,
  isConcurrencySafe: () => readOnly,
  execute: fakeExec,
})

const makeCall = (name = "edit_file"): ToolUseBlock => ({
  type: "tool_use",
  id: `call-${name}-${Math.random().toString(36).slice(2, 8)}`,
  name,
  input: {},
})

const makeCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
  cwd: "/ws",
  signal: new AbortController().signal,
  ...over,
})

const buildBasePolicy = (mode: "off" | "per-mutating" | "pre-destructive") =>
  defaultCheckpointPolicy({
    mode,
    odb: makeFakeOdb({
      registerHead: async () => "a".repeat(40),
    }),
  })

/* ================================================================== */
/* A. granularity="turn" parity                                        */
/* ================================================================== */

describe('GranularCheckpointPolicy granularity="turn" parity (HELL-A1..A3)', () => {
  test("HELL-A1: shouldAnchorBefore delegates verbatim to base policy (per-mutating destructive ⇒ true)", async () => {
    const base = buildBasePolicy("per-mutating")
    const policy = defaultGranularCheckpointPolicy({ base, granularity: "turn" })
    const tool = makeTool(false)
    expect(await policy.shouldAnchorBefore(tool, makeCall(), makeCtx({ turnId: "t1" }))).toBe(true)
  })

  test("HELL-A2: computeTag returns null for turn-grain — registry stays empty", () => {
    const base = buildBasePolicy("per-mutating")
    const policy = defaultGranularCheckpointPolicy({ base, granularity: "turn" })
    expect(policy.computeTag({ workspace: "/ws", turnId: "t1", toolName: "edit_file" })).toBe(null)
    policy.recordAnchorSha("turn:t1", "deadbeef", { workspace: "/ws", turnId: "t1" })
    expect(policy.registry.list().length).toBe(0)
  })

  test('HELL-A3: granularity="turn" + off-mode = byte-identical (no anchor, empty registry)', async () => {
    const base = buildBasePolicy("off")
    const policy = defaultGranularCheckpointPolicy({ base, granularity: "turn" })
    const tool = makeTool(false)
    expect(await policy.shouldAnchorBefore(tool, makeCall(), makeCtx({ turnId: "t1" }))).toBe(false)
    expect(await policy.shouldAnchorAfterTurn("t1", "/ws")).toBe(false)
    expect(policy.registry.list().length).toBe(0)
  })
})

/* ================================================================== */
/* B. granularity="tool" — per-call cardinality                         */
/* ================================================================== */

describe('GranularCheckpointPolicy granularity="tool" (HELL-B4..B6)', () => {
  test("HELL-B4: per-mutating + tool-grain ⇒ each destructive call anchors (no per-turn dedup)", async () => {
    const base = buildBasePolicy("per-mutating")
    const policy = defaultGranularCheckpointPolicy({ base, granularity: "tool" })
    const tool = makeTool(false)
    const ctx = makeCtx({ turnId: "turn-1" })
    // Two destructive calls in the same turn — both should approve.
    expect(await policy.shouldAnchorBefore(tool, makeCall("edit_a"), ctx)).toBe(true)
    expect(await policy.shouldAnchorBefore(tool, makeCall("edit_b"), ctx)).toBe(true)
  })

  test("HELL-B5: read-only tools never anchor even in tool-grain", async () => {
    const base = buildBasePolicy("per-mutating")
    const policy = defaultGranularCheckpointPolicy({ base, granularity: "tool" })
    expect(
      await policy.shouldAnchorBefore(makeTool(true), makeCall("grep"), makeCtx({ turnId: "t1" })),
    ).toBe(false)
  })

  test("HELL-B6: shouldAnchorAfterTurn returns false for tool-grain (turn-after is not its concern)", async () => {
    // ALBB-21 — the `per-turn` MODE was deleted; the tool-grain override short-
    // circuits to false BEFORE delegating regardless of base mode, so this
    // delegation-contract pin is base-mode-independent now.
    const base = buildBasePolicy("pre-destructive")
    const policy = defaultGranularCheckpointPolicy({ base, granularity: "tool" })
    expect(await policy.shouldAnchorAfterTurn("t1", "/ws")).toBe(false)
  })
})

/* ================================================================== */
/* C. recordAnchorSha — typed registry invariants                       */
/* ================================================================== */

describe("GranularCheckpointPolicy recordAnchorSha (HELL-C7..C10)", () => {
  const buildToolPolicy = (now = () => 0): GranularCheckpointPolicy =>
    defaultGranularCheckpointPolicy({
      base: buildBasePolicy("per-mutating"),
      granularity: "tool",
      now,
    })

  test("HELL-C7: canonical tag flows through recordAnchorSha (tool:<name>:<turnId>:<index>)", () => {
    const policy = buildToolPolicy()
    const tag = policy.computeTag({
      workspace: "/ws",
      turnId: "turn-1",
      toolName: "edit_file",
      callIndex: 0,
    })
    expect(tag).toBe("tool:edit_file:turn-1:0")
    policy.recordAnchorSha(tag as string, "abc123", {
      workspace: "/ws",
      turnId: "turn-1",
      toolName: "edit_file",
      callIndex: 0,
    })
    const list = policy.registry.list()
    expect(list.length).toBe(1)
    const first = list[0]
    expect(first?.tag).toBe("tool:edit_file:turn-1:0")
    expect(first?.sha).toBe("abc123")
    expect(first?.granularity).toBe("tool")
    expect(first?.toolName).toBe("edit_file")
  })

  test("HELL-C8: empty SHA (anchor failed sentinel) ⇒ registry stays empty", () => {
    const policy = buildToolPolicy()
    policy.recordAnchorSha("tool:edit_file:turn-1:0", "", {
      workspace: "/ws",
      turnId: "turn-1",
      toolName: "edit_file",
      callIndex: 0,
    })
    expect(policy.registry.list().length).toBe(0)
  })

  test("HELL-C9: non-canonical tag (caller bug) ⇒ rejected without poisoning registry", () => {
    const policy = buildToolPolicy()
    // Caller passes a tag that doesn't match what computeTag would have produced.
    policy.recordAnchorSha("BOGUS_TAG", "abc123", {
      workspace: "/ws",
      turnId: "turn-1",
      toolName: "edit_file",
      callIndex: 0,
    })
    expect(policy.registry.list().length).toBe(0)
    // Now insert a legitimate one and confirm only THAT one is present.
    policy.recordAnchorSha("tool:edit_file:turn-1:0", "abc123", {
      workspace: "/ws",
      turnId: "turn-1",
      toolName: "edit_file",
      callIndex: 0,
    })
    expect(policy.registry.list().length).toBe(1)
  })

  test("HELL-C10: LRU eviction kicks in at maxRegistryEntries", () => {
    const policy = defaultGranularCheckpointPolicy({
      base: buildBasePolicy("per-mutating"),
      granularity: "tool",
      maxRegistryEntries: 2,
    })
    for (let i = 0; i < 5; i += 1) {
      const tag = policy.computeTag({
        workspace: "/ws",
        turnId: "turn-1",
        toolName: "edit",
        callIndex: i,
      }) as string
      policy.recordAnchorSha(tag, `sha-${i}`, {
        workspace: "/ws",
        turnId: "turn-1",
        toolName: "edit",
        callIndex: i,
      })
    }
    const list = policy.registry.list()
    expect(list.length).toBe(2)
    // Newest-first.
    expect(list[0]?.sha).toBe("sha-4")
    expect(list[1]?.sha).toBe("sha-3")
  })
})

/* ================================================================== */
/* D. 3-way restore orthogonality                                       */
/* ================================================================== */

describe("ThreeWayRestorePort orthogonality (HELL-D11..D15)", () => {
  const buildSetupWithBoth = () => {
    const policy = defaultGranularCheckpointPolicy({
      base: buildBasePolicy("per-mutating"),
      granularity: "tool",
    })
    const tag = policy.computeTag({
      workspace: "/ws",
      turnId: "turn-1",
      toolName: "edit_file",
      callIndex: 0,
    }) as string
    policy.recordAnchorSha(tag, "abc123", {
      workspace: "/ws",
      turnId: "turn-1",
      toolName: "edit_file",
      callIndex: 0,
    })
    let rewindCalls = 0
    const odb = makeFakeOdb({
      diffSinceLast: async () => "diff --git a/src/foo.ts b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n",
      rewindToLast: async () => {
        rewindCalls += 1
      },
    })
    const store = defaultConversationCheckpointStore()
    const snapMsgs: Message[] = [{ role: "user", content: [{ type: "text", text: "first user" }] }]
    store.record(tag, snapMsgs)
    const restore = defaultThreeWayRestore({
      registry: policy.registry,
      workspace: "/ws",
      shadowOdb: odb,
      conversationStore: store,
    })
    return { tag, restore, rewindCallsRef: () => rewindCalls, store }
  }

  test("HELL-D11: restoreFiles touches files only — conversation store NEVER consulted", async () => {
    const { tag, restore, rewindCallsRef } = buildSetupWithBoth()
    const out = await restore.restoreFiles(tag)
    expect(out.ok).toBe(true)
    expect(rewindCallsRef()).toBe(1)
    expect(out.filesChanged).toEqual(["src/foo.ts"])
    expect(out.messagesAfter).toBeUndefined()
    expect(out.messagesBefore).toBeUndefined()
  })

  test("HELL-D12: restoreTask touches conversation only — shadow ODB NEVER consulted", async () => {
    // Use a setup with NO shadowOdb to prove the task leg does not need it.
    const policy = defaultGranularCheckpointPolicy({
      base: buildBasePolicy("per-mutating"),
      granularity: "tool",
    })
    const tag = policy.computeTag({
      workspace: "/ws",
      turnId: "turn-1",
      toolName: "edit_file",
      callIndex: 0,
    }) as string
    policy.recordAnchorSha(tag, "abc123", {
      workspace: "/ws",
      turnId: "turn-1",
      toolName: "edit_file",
      callIndex: 0,
    })
    const store = defaultConversationCheckpointStore()
    store.record(tag, [{ role: "user", content: [{ type: "text", text: "x" }] }])
    const restore = defaultThreeWayRestore({
      registry: policy.registry,
      workspace: "/ws",
      conversationStore: store,
    })
    const before: Message[] = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
    ]
    const out = await restore.restoreTask(tag, { currentMessages: before })
    expect(out.ok).toBe(true)
    expect(out.messagesAfter?.length).toBe(1)
    expect(out.messagesBefore?.length).toBe(2)
    expect(out.filesChanged).toBeUndefined()
  })

  test("HELL-D13: restoreBoth restores files AND conversation in one call", async () => {
    const { tag, restore } = buildSetupWithBoth()
    const out = await restore.restoreBoth(tag, {
      currentMessages: [{ role: "user", content: [{ type: "text", text: "live" }] }],
    })
    expect(out.ok).toBe(true)
    expect(out.filesChanged).toEqual(["src/foo.ts"])
    expect(out.messagesAfter?.length).toBe(1)
  })

  test("HELL-D14: restoreFiles does NOT mutate conversation store (orthogonality)", async () => {
    const { tag, restore, store } = buildSetupWithBoth()
    const sizeBefore = store.list().length
    await restore.restoreFiles(tag)
    expect(store.list().length).toBe(sizeBefore)
  })

  test("HELL-D15: restoreTask does NOT mutate shadow ODB (orthogonality)", async () => {
    const { tag, restore, rewindCallsRef } = buildSetupWithBoth()
    await restore.restoreTask(tag, { currentMessages: [] })
    expect(rewindCallsRef()).toBe(0)
  })
})

/* ================================================================== */
/* E. typed restore failures                                            */
/* ================================================================== */

describe("ThreeWayRestorePort typed failures (HELL-E16..E18)", () => {
  test("HELL-E16: unknown tag ⇒ ok:false errorCode=tag-not-found (no throw)", async () => {
    const policy = defaultGranularCheckpointPolicy({
      base: buildBasePolicy("per-mutating"),
      granularity: "tool",
    })
    const restore = defaultThreeWayRestore({
      registry: policy.registry,
      workspace: "/ws",
    })
    const out = await restore.restoreFiles("tool:nope:t1:0")
    expect(out.ok).toBe(false)
    expect(out.errorCode).toBe("tag-not-found")
    expect(out.tag).toBe("tool:nope:t1:0")
  })

  test("HELL-E17: shadowOdb absent + files leg requested ⇒ shadow-odb-not-configured typed error", async () => {
    const policy = defaultGranularCheckpointPolicy({
      base: buildBasePolicy("per-mutating"),
      granularity: "tool",
    })
    const tag = policy.computeTag({
      workspace: "/ws",
      turnId: "t1",
      toolName: "x",
      callIndex: 0,
    }) as string
    policy.recordAnchorSha(tag, "deadbeef", {
      workspace: "/ws",
      turnId: "t1",
      toolName: "x",
      callIndex: 0,
    })
    const restore = defaultThreeWayRestore({
      registry: policy.registry,
      workspace: "/ws",
    })
    const out = await restore.restoreFiles(tag)
    expect(out.ok).toBe(false)
    expect(out.errorCode).toBe("shadow-odb-not-configured")
  })

  test("HELL-E18: shadow rewind throws ShadowOdbError ⇒ ok:false originalCode preserved", async () => {
    const policy = defaultGranularCheckpointPolicy({
      base: buildBasePolicy("per-mutating"),
      granularity: "tool",
    })
    const tag = policy.computeTag({
      workspace: "/ws",
      turnId: "t1",
      toolName: "x",
      callIndex: 0,
    }) as string
    policy.recordAnchorSha(tag, "deadbeef", {
      workspace: "/ws",
      turnId: "t1",
      toolName: "x",
      callIndex: 0,
    })
    const odb = makeFakeOdb({
      diffSinceLast: async () => "",
      rewindToLast: async () => {
        throw new ShadowOdbError("merge-in-progress", "MERGE_HEAD exists")
      },
    })
    const restore = defaultThreeWayRestore({
      registry: policy.registry,
      workspace: "/ws",
      shadowOdb: odb,
    })
    const out = await restore.restoreFiles(tag)
    expect(out.ok).toBe(false)
    expect(out.errorCode).toBe("shadow-rewind-failed")
    expect(out.originalCode).toBe("merge-in-progress")
  })
})

/* ================================================================== */
/* F. /rewind-tool slash routing                                        */
/* ================================================================== */

describe("/rewind-tool slash routing (HELL-F19..F21)", () => {
  test("HELL-F19: parseArgs rejects invalid --mode + unknown flags", () => {
    expect(rewindToolTest.parseArgs(["--mode=bogus"])).toContain("invalid --mode")
    expect(rewindToolTest.parseArgs(["--whatever"])).toContain("unknown flag")
  })

  test("HELL-F20: parseArgs returns typed shape on valid input (no `undefined` keys)", () => {
    const ok = rewindToolTest.parseArgs(["tool:edit_file:t1:0", "--mode=both", "--yes"])
    expect(typeof ok).toBe("object")
    if (typeof ok === "string") throw new Error("expected object")
    expect(ok.mode).toBe("both")
    expect(ok.yes).toBe(true)
    expect(ok.tagPrefix).toBe("tool:edit_file:t1:0")
  })

  test("HELL-F21: resolveTagPrefix detects ambiguity vs uniqueness", () => {
    const policy = defaultGranularCheckpointPolicy({
      base: buildBasePolicy("per-mutating"),
      granularity: "tool",
    })
    for (let i = 0; i < 2; i += 1) {
      const tag = policy.computeTag({
        workspace: "/ws",
        turnId: "turn-aaa",
        toolName: "edit",
        callIndex: i,
      }) as string
      policy.recordAnchorSha(tag, `sha-${i}`, {
        workspace: "/ws",
        turnId: "turn-aaa",
        toolName: "edit",
        callIndex: i,
      })
    }
    // Prefix "tool:edit:turn-aaa:" matches BOTH ⇒ ambiguous.
    const amb = rewindToolTest.resolveTagPrefix(policy.registry, "tool:edit:turn-aaa:")
    expect(amb.startsWith("ambiguous")).toBe(true)
    // Full tag ⇒ exact hit.
    const exact = rewindToolTest.resolveTagPrefix(policy.registry, "tool:edit:turn-aaa:0")
    expect(exact).toBe("tool:edit:turn-aaa:0")
    // Unknown prefix.
    const miss = rewindToolTest.resolveTagPrefix(policy.registry, "tool:nope")
    expect(miss.startsWith("tag not found")).toBe(true)
  })
})

/* ================================================================== */
/* G. tag collision + abort-mid-checkpoint                              */
/* ================================================================== */

describe("tag collision + abort-mid-checkpoint (HELL-G22)", () => {
  test("HELL-G22: same (workspace, turn, tool, index) collision ⇒ idempotent replace (no duplicates)", () => {
    const policy = defaultGranularCheckpointPolicy({
      base: buildBasePolicy("per-mutating"),
      granularity: "tool",
    })
    const anchorCtx = {
      workspace: "/ws",
      turnId: "turn-1",
      toolName: "edit_file",
      callIndex: 0,
    }
    const tag = policy.computeTag(anchorCtx) as string
    policy.recordAnchorSha(tag, "sha-first", anchorCtx)
    policy.recordAnchorSha(tag, "sha-second", anchorCtx)
    const list = policy.registry.list()
    expect(list.length).toBe(1)
    // Replacement semantics: second SHA wins.
    expect(list[0]?.sha).toBe("sha-second")
  })

  test("HELL-G22b: abort-mid-checkpoint — base.shouldAnchorBefore throws ⇒ collapses to false (no throw out)", async () => {
    const throwingBase = {
      async shouldAnchorBefore(): Promise<boolean> {
        throw new Error("base policy blew up")
      },
      async shouldAnchorAfterTurn(): Promise<boolean> {
        throw new Error("also broken")
      },
      recordAnchored(): void {},
    }
    const policy = defaultGranularCheckpointPolicy({
      base: throwingBase,
      granularity: "tool",
    })
    expect(
      await policy.shouldAnchorBefore(makeTool(false), makeCall(), makeCtx({ turnId: "t1" })),
    ).toBe(false)
    expect(await policy.shouldAnchorAfterTurn("t1", "/ws")).toBe(false)
  })
})

/* ================================================================== */
/* helpers used in the file but referenced indirectly                  */
/* ================================================================== */

// Stop the bundler from complaining about an unused import.
void restoreTest
