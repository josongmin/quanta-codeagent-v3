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

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultCheckpointPolicy } from "@/agent/checkpoint-policy"
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import {
  defaultGranularCheckpointPolicy,
  defaultThreeWayRestore,
  type GranularCheckpointPolicy,
} from "@/agent/per-tool-checkpoint"
import { __test as restoreTest } from "@/agent/per-tool-checkpoint/three-way-restore"
import { createSavedSessionRollbackStore, executeRollback } from "@/agent/thread-rollback"
import { captureCheckpoint, resolveRollbackTarget } from "@/agent/thread-rollback-checkpoint"
import type { Message, ToolUseBlock } from "@/llm"
import {
  latestOperation,
  loadSessionById,
  ROLLBACK_RECORD_VERSION,
  saveSessionById,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"
import { type ShadowOdb, ShadowOdbError } from "@/storage/shadow-odb"
import type { Tool, ToolContext } from "@/tool"
import {
  buildPerToolCheckpointWire,
  buildRollbackEffectPort,
} from "../../src/apps/cli/repl/per-tool-checkpoint-wire"
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
    rewindToRef: over.rewindToRef ?? (ni("rewindToRef") as ShadowOdb["rewindToRef"]),
    restorePartialFromRef: ni("restorePartialFromRef") as ShadowOdb["restorePartialFromRef"],
    diffSinceRef: over.diffSinceRef ?? (ni("diffSinceRef") as ShadowOdb["diffSinceRef"]),
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

  test("HELL-C10b: actual dispatched tool-call id is the rewind tag identity", () => {
    const policy = buildToolPolicy()
    const anchor = {
      workspace: "/ws",
      turnId: "turn-1",
      toolName: "edit_file",
      toolCallId: "call_real_42",
    }
    const tag = policy.computeTag(anchor)
    expect(tag).toBe("tool:edit_file:call_real_42")
    policy.recordAnchorSha(tag as string, "abc123", anchor)
    expect(policy.registry.lookup("tool:edit_file:call_real_42")?.toolCallId).toBe("call_real_42")
  })

  test("HELL-C10c: record lifecycle clears all bounded anchors on session close", () => {
    const policy = buildToolPolicy()
    const tag = policy.computeTag({
      workspace: "/ws",
      turnId: "turn-1",
      toolName: "edit_file",
      toolCallId: "call_close_1",
    }) as string
    policy.recordAnchorSha(tag, "abc123", {
      workspace: "/ws",
      turnId: "turn-1",
      toolName: "edit_file",
      toolCallId: "call_close_1",
    })
    expect(policy.registry.list()).toHaveLength(1)
    policy.registry.clear()
    expect(policy.registry.list()).toEqual([])
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
      listSnapshots: async () => [
        { ref: "refs/quanta/snapshots/last-registered", sha: "abc123", timestampSec: 1 },
      ],
      diffSinceRef: async () => ({
        snap: { ref: "refs/quanta/snapshots/last-registered", sha: "abc123", timestampSec: 1 },
        diff: "diff --git a/src/foo.ts b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n",
      }),
      rewindToRef: async (_workspace, ordinal, opts) => {
        expect(ordinal).toBe(1)
        expect(opts?.expectSha).toBe("abc123")
        rewindCalls += 1
        return { ref: "refs/quanta/snapshots/last-registered", sha: "abc123", timestampSec: 1 }
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

  test("HELL-D11b: restoreFiles targets the selected tag SHA, never the newer last anchor", async () => {
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
    policy.recordAnchorSha(tag, "selected-sha", {
      workspace: "/ws",
      turnId: "turn-1",
      toolName: "edit_file",
      callIndex: 0,
    })
    const restore = defaultThreeWayRestore({
      registry: policy.registry,
      workspace: "/ws",
      shadowOdb: makeFakeOdb({
        listSnapshots: async () => [
          { ref: "refs/quanta/snapshots/last-registered", sha: "newer-sha", timestampSec: 2 },
          { ref: "refs/quanta/snapshots/older", sha: "selected-sha", timestampSec: 1 },
        ],
        diffSinceRef: async (_workspace, ordinal) => {
          expect(ordinal).toBe(2)
          return {
            snap: { ref: "refs/quanta/snapshots/older", sha: "selected-sha", timestampSec: 1 },
            diff: "",
          }
        },
        rewindToLast: async () => {
          throw new Error("must not restore the latest anchor")
        },
        rewindToRef: async (_workspace, ordinal, opts) => {
          expect(ordinal).toBe(2)
          expect(opts?.expectSha).toBe("selected-sha")
          return { ref: "refs/quanta/snapshots/older", sha: "selected-sha", timestampSec: 1 }
        },
      }),
    })

    expect((await restore.restoreFiles(tag)).ok).toBe(true)
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
      listSnapshots: async () => [
        { ref: "refs/quanta/snapshots/last-registered", sha: "deadbeef", timestampSec: 1 },
      ],
      diffSinceRef: async () => ({
        snap: { ref: "refs/quanta/snapshots/last-registered", sha: "deadbeef", timestampSec: 1 },
        diff: "",
      }),
      rewindToRef: async () => {
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

  test("HELL-E18b: tag SHA absent from shadow list refuses before any rewind", async () => {
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
    policy.recordAnchorSha(tag, "absent-sha", {
      workspace: "/ws",
      turnId: "t1",
      toolName: "x",
      callIndex: 0,
    })
    let rewindCalls = 0
    const restore = defaultThreeWayRestore({
      registry: policy.registry,
      workspace: "/ws",
      shadowOdb: makeFakeOdb({
        listSnapshots: async () => [
          { ref: "refs/quanta/snapshots/last-registered", sha: "other-sha", timestampSec: 1 },
        ],
        rewindToRef: async () => {
          rewindCalls += 1
          return { ref: "refs/quanta/snapshots/last-registered", sha: "other-sha", timestampSec: 1 }
        },
      }),
    })
    const out = await restore.restoreFiles(tag)
    expect(out.ok).toBe(false)
    expect(out.errorCode).toBe("shadow-rewind-failed")
    expect(rewindCalls).toBe(0)
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
/* RFC01-2 — durable checkpoint MAPPING capture (aug-02 absorption)     */
/* ================================================================== */

describe("thread-rollback-checkpoint — durable mapping capture (RFC01-2)", () => {
  test("captureCheckpoint binds the ShadowOdb head SHA to (turnId, messageId)", async () => {
    let registerCalls = 0
    const port = {
      registerHead: async (ws: string) => {
        expect(ws).toBe("/ws")
        registerCalls += 1
        return "sha-head-1"
      },
    }
    const { checkpoints, record } = await captureCheckpoint(port, [], {
      workspace: "/ws",
      turnId: "turn-3",
      messageId: "m-3",
      expectedFileHashes: { "src/a.ts": "h1" },
    })
    expect(registerCalls).toBe(1)
    expect(record.checkpointSha).toBe("sha-head-1")
    expect(record.turnId).toBe("turn-3")
    expect(record.messageId).toBe("m-3")
    expect(record.expectedFileHashes).toEqual({ "src/a.ts": "h1" })
    // The mapping is now resolvable as a rollback target.
    expect(resolveRollbackTarget(checkpoints, "turn-3")).toEqual({ kind: "ok", checkpoint: record })
  })

  test("capture does NOT invent hashes — the caller's boundary set is stored verbatim + copied", async () => {
    const live: Record<string, string> = { "src/a.ts": "h1" }
    const port = { registerHead: async () => "sha-x" }
    const { record } = await captureCheckpoint(port, [], {
      workspace: "/ws",
      turnId: "t1",
      messageId: "m1",
      expectedFileHashes: live,
    })
    // Mutating the caller's map after capture must not rewrite the durable record.
    live["src/a.ts"] = "TAMPERED"
    live["src/b.ts"] = "new"
    expect(record.expectedFileHashes).toEqual({ "src/a.ts": "h1" })
  })

  test("a failed head capture writes NO record (fail-closed; error surfaces)", async () => {
    const port = {
      registerHead: async () => {
        throw new ShadowOdbError("uninitialized", "registerHead never called")
      },
    }
    await expect(
      captureCheckpoint(port, [], {
        workspace: "/ws",
        turnId: "t1",
        messageId: "m1",
        expectedFileHashes: {},
      }),
    ).rejects.toThrow(ShadowOdbError)
  })

  // RED: a MISSING mapping must resolve to a typed refusal — NOT a fabricated
  // target. The coordinator performs NO restore on `missing`.
  test("resolveRollbackTarget: missing mapping ⇒ typed `missing` refusal (no target invented)", async () => {
    const port = { registerHead: async () => "sha-1" }
    const { checkpoints } = await captureCheckpoint(port, [], {
      workspace: "/ws",
      turnId: "turn-1",
      messageId: "m-1",
      expectedFileHashes: {},
    })
    // A target turn with no recorded checkpoint is unknown — fail-closed.
    expect(resolveRollbackTarget(checkpoints, "turn-99")).toEqual({
      kind: "missing",
      targetTurnId: "turn-99",
    })
  })

  // A re-capture of the SAME boundary replaces (newest SHA/hashes authoritative);
  // a DIFFERENT boundary appends. No duplicate-boundary rollback targets.
  test("re-capture of same boundary replaces; new boundary appends", async () => {
    const port1 = { registerHead: async () => "sha-old" }
    const port2 = { registerHead: async () => "sha-new" }
    const first = await captureCheckpoint(port1, [], {
      workspace: "/ws",
      turnId: "turn-1",
      messageId: "m-1",
      expectedFileHashes: {},
    })
    const second = await captureCheckpoint(port2, first.checkpoints, {
      workspace: "/ws",
      turnId: "turn-1",
      messageId: "m-1",
      expectedFileHashes: {},
    })
    expect(second.checkpoints.length).toBe(1)
    const r1 = resolveRollbackTarget(second.checkpoints, "turn-1")
    expect(r1.kind === "ok" && r1.checkpoint.checkpointSha).toBe("sha-new")

    const third = await captureCheckpoint(port1, second.checkpoints, {
      workspace: "/ws",
      turnId: "turn-2",
      messageId: "m-2",
      expectedFileHashes: {},
    })
    expect(third.checkpoints.length).toBe(2)
  })
})

/* ================================================================== */
/* RFC01-2 — dirty/untracked/moved-SHA preservation on the file leg    */
/* ================================================================== */

describe("ThreeWayRestorePort preservation matrix (RFC01-2)", () => {
  const buildTagged = (sha: string) => {
    const policy = defaultGranularCheckpointPolicy({
      base: buildBasePolicy("per-mutating"),
      granularity: "tool",
    })
    const ctx = { workspace: "/ws", turnId: "turn-1", toolName: "edit_file", callIndex: 0 }
    const tag = policy.computeTag(ctx) as string
    policy.recordAnchorSha(tag, sha, ctx)
    return { policy, tag }
  }

  // MOVED SHA: the recorded snapshot no longer carries the expected sha ⇒ the
  // file leg fails closed with a typed refusal and NEVER calls rewindToRef (no
  // mutation), so any unrelated dirty file on disk is left byte-identical.
  test("moved SHA ⇒ typed `shadow-rewind-failed`, rewindToRef NEVER called (no mutation)", async () => {
    const { policy, tag } = buildTagged("expected-sha")
    let rewindCalls = 0
    const odb = makeFakeOdb({
      // The snapshot list no longer contains `expected-sha` (it moved).
      listSnapshots: async () => [
        { ref: "refs/quanta/snapshots/last-registered", sha: "different-sha", timestampSec: 2 },
      ],
      rewindToRef: async () => {
        rewindCalls += 1
        return { ref: "x", sha: "different-sha", timestampSec: 2 }
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
    // The destructive op was NEVER attempted — nothing on disk changed.
    expect(rewindCalls).toBe(0)
  })

  // UNTRACKED PRESERVATION: the file leg forwards `untracked:"preserve"` so an
  // unrelated untracked file is never discarded by a restore.
  test("restoreFiles forwards untracked:preserve (unrelated untracked files kept)", async () => {
    const { policy, tag } = buildTagged("abc123")
    let seenUntracked: string | undefined
    const odb = makeFakeOdb({
      listSnapshots: async () => [
        { ref: "refs/quanta/snapshots/last-registered", sha: "abc123", timestampSec: 1 },
      ],
      diffSinceRef: async () => ({
        snap: { ref: "refs/quanta/snapshots/last-registered", sha: "abc123", timestampSec: 1 },
        diff: "",
      }),
      rewindToRef: async (_ws, _ord, opts) => {
        seenUntracked = opts?.untracked
        return { ref: "refs/quanta/snapshots/last-registered", sha: "abc123", timestampSec: 1 }
      },
    })
    const restore = defaultThreeWayRestore({
      registry: policy.registry,
      workspace: "/ws",
      shadowOdb: odb,
    })
    const out = await restore.restoreFiles(tag)
    expect(out.ok).toBe(true)
    expect(seenUntracked).toBe("preserve")
  })

  // MISSING MAPPING at the port: an unknown tag ⇒ `tag-not-found`, rewind never
  // called (the coordinator's missing-mapping refusal is honored end-to-end).
  test("unknown tag ⇒ `tag-not-found`, no restore attempted", async () => {
    const { policy } = buildTagged("abc123")
    let rewindCalls = 0
    const odb = makeFakeOdb({
      rewindToRef: async () => {
        rewindCalls += 1
        return { ref: "x", sha: "abc123", timestampSec: 1 }
      },
    })
    const restore = defaultThreeWayRestore({
      registry: policy.registry,
      workspace: "/ws",
      shadowOdb: odb,
    })
    const out = await restore.restoreFiles("tool:edit_file:turn-1:99")
    expect(out.ok).toBe(false)
    expect(out.errorCode).toBe("tag-not-found")
    expect(rewindCalls).toBe(0)
  })
})

/* ================================================================== */
/* RFC01-3 — front-door: CLI effect-port adapter drives the coordinator */
/*           end-to-end (SHA→tag→ONE ThreeWayRestorePort), no second    */
/*           restore path, over the REAL SavedSession store. This lives  */
/*           in the CLI-import-allowed hellgate so a library test never   */
/*           reaches into `@/apps/cli` internals (slice isolation).       */
/* ================================================================== */

describe("thread-rollback front-door composition (RFC01-3)", () => {
  let dir: string
  let snap: NodeJS.ProcessEnv
  beforeEach(() => {
    snap = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "rollback-frontdoor-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const k of Object.keys(process.env)) if (!(k in snap)) delete process.env[k]
    Object.assign(process.env, snap)
    __resetRuntimeConfig()
  })

  test("CLI effect port resolves SHA→tag and drives ONE restore through the coordinator", async () => {
    const SHA = "c".repeat(40)
    let rewindCalls = 0
    const odb = makeFakeOdb({
      registerHead: async () => SHA,
      listSnapshots: async () => [
        { ref: "refs/quanta/snapshots/last-registered", sha: SHA, timestampSec: 1 },
      ],
      diffSinceRef: async () => ({
        snap: { ref: "refs/quanta/snapshots/last-registered", sha: SHA, timestampSec: 1 },
        diff: "",
      }),
      rewindToRef: async (_ws, _ord, opts) => {
        expect(opts?.expectSha).toBe(SHA)
        rewindCalls += 1
        return { ref: "refs/quanta/snapshots/last-registered", sha: SHA, timestampSec: 1 }
      },
    })
    const wire = buildPerToolCheckpointWire({ shadowOdb: odb, workspace: "/ws" })
    // Register a live anchor carrying SHA (what dispatch does at a boundary).
    const tag = wire.policy.computeTag({
      workspace: "/ws",
      turnId: "turn-1",
      toolName: "edit_file",
      callIndex: 0,
    }) as string
    wire.policy.recordAnchorSha(tag, SHA, {
      workspace: "/ws",
      turnId: "turn-1",
      toolName: "edit_file",
      callIndex: 0,
    })

    // Seed the session, capture the durable checkpoint mapping (RFC01-2), persist it.
    await saveSessionById(
      {
        id: "fd-1",
        title: "T",
        cwd: "/ws",
        createdAt: 1_000,
        lastTouched: 1_000,
        archived: false,
      },
      {
        reason: "ok",
        turns: 1,
        messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }],
      },
    )
    const cap = await captureCheckpoint(odb, [], {
      workspace: "/ws",
      turnId: "turn-1",
      messageId: "m1",
      expectedFileHashes: {},
    })
    const s = await loadSessionById("fd-1")
    if (s === undefined) throw new Error("seed missing")
    await saveSessionById(s.meta, {
      reason: s.reason,
      turns: s.turns,
      messages: s.messages,
      rollbackCheckpoints: [...cap.checkpoints],
    })

    // Front door: build the effect port from the CLI wire and run the coordinator.
    const store = createSavedSessionRollbackStore()
    const effect = buildRollbackEffectPort(wire)
    let clock = 1
    const out = await executeRollback(
      { store, effect, now: () => clock++ },
      { sessionId: "fd-1", operationId: "op-fd", targetTurnId: "turn-1" },
    )
    expect(out.kind).toBe("rolled_back")
    // The REAL ThreeWayRestorePort → ShadowOdb rewindToRef ran exactly once.
    expect(rewindCalls).toBe(1)
    const finalOps = (await loadSessionById("fd-1"))?.rollbackOperations ?? []
    expect(latestOperation(finalOps, "op-fd")?.state).toBe("rolled_back")
  })

  test("effect port fails closed when no live anchor carries the recorded SHA", async () => {
    const odb = makeFakeOdb({})
    const wire = buildPerToolCheckpointWire({ shadowOdb: odb, workspace: "/ws" })
    const effect = buildRollbackEffectPort(wire)
    const res = await effect.restoreToCheckpoint({
      recordVersion: ROLLBACK_RECORD_VERSION,
      turnId: "turn-1",
      messageId: "m1",
      checkpointSha: "d".repeat(40),
      expectedFileHashes: {},
    })
    expect(res).toEqual({ ok: false, code: "checkpoint-anchor-missing" })
  })
})

/* ================================================================== */
/* helpers used in the file but referenced indirectly                  */
/* ================================================================== */

// Stop the bundler from complaining about an unused import.
void restoreTest
