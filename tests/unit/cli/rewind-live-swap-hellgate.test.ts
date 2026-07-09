import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  CheckpointTag,
  GranularRegistry,
  RestoreOutcome,
  ThreeWayRestorePort,
} from "@/agent/per-tool-checkpoint"
import type { Message } from "@/llm"
import { loadSessionById, type SavePayload, type SessionMeta, saveSessionById } from "@/session"
import { __resetRuntimeConfig } from "@/shared"
import { applyLiveHistorySwap } from "../../../src/apps/cli/live-history-swap"
import type { ConvCheckpointWire } from "../../../src/apps/cli/repl/conv-checkpoint-wire"
import { type RewindSlashState, rewindCommands } from "../../../src/apps/cli/rewind-cmd"
import { type ConvCheckpointSlashState, rewindConvCmd } from "../../../src/apps/cli/rewind-conv-cmd"
import {
  type PerToolCheckpointSlashState,
  rewindToolCmd,
} from "../../../src/apps/cli/rewind-tool-cmd"
import type { SlashContext } from "../../../src/apps/cli/slash-commands"

/**
 * UUX-4-02 + UUX-6-03 + UUX-6-09 hellgate — ONE live-history-swap seam.
 *
 * Root cause (WS-D §3): `/rewind` truncates the session ON DISK but the live
 * REPL in-memory history stays stale until restart; `/rewind-tool`'s task leg
 * receives `messagesAfter` in the outcome but only PRINTS it. `/rewind-conv`
 * already swaps via `slot.replaceMessages()` — that path is extracted into the
 * shared `applyLiveHistorySwap` seam and adopted by all three commands.
 *
 * Also: `/rewind-conv <tag>` was destructive with NO confirm (UUX-6-09) —
 * it now previews + refuses (exit 1) without `--yes`, mirroring the
 * confirm/preview pattern `/rewind` and `/rewind-tool` already ship.
 *
 * Strong-test rules honored: real session-store effects (temp
 * QUANTA_SESSIONS_DIR), fresh readback after mutation, paired controls on the
 * happy paths, red-on-injection for the swap-failure arm.
 */

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const mkMeta = (id: string): SessionMeta => ({
  id,
  title: "T",
  cwd: "/tmp/work",
  createdAt: 1_000,
  lastTouched: 1_000,
  archived: false,
})

const mkMessage = (text: string, role: "user" | "assistant", id: string): Message => ({
  role,
  content: [{ type: "text", text }],
  id,
})

const seed = async (id: string): Promise<void> => {
  const messages: Message[] = [
    mkMessage("hello", "user", "m0"),
    mkMessage("hi back", "assistant", "m1"),
    mkMessage("how about X", "user", "m2"),
    mkMessage("here is X", "assistant", "m3"),
    mkMessage("any followup?", "user", "m4"),
  ]
  const payload: SavePayload = { reason: "ok", turns: 3, messages }
  await saveSessionById(mkMeta(id), payload)
}

interface Captured {
  readonly ctx: SlashContext
  readonly out: () => string
  readonly err: () => string
}

const buildCtx = (extra: Partial<SlashContext> = {}): Captured => {
  const cap = { out: "", err: "" }
  const ctx = {
    out: (s: string) => {
      cap.out += s
    },
    err: (s: string) => {
      cap.err += s
    },
    cwd: "/tmp/work",
    ...extra,
  } as SlashContext
  return { ctx, out: () => cap.out, err: () => cap.err }
}

/** Live-slot fake: records every swap + the ctx.out content AT swap time so
 *  ordering ("success copy only prints after the swap") is observable. */
const buildSwapRecorder = (cap?: Captured, rejectWith?: Error) => {
  const calls: { msgs: ReadonlyArray<Message>; outAtCall: string }[] = []
  const replaceMessages = async (msgs: ReadonlyArray<Message>): Promise<void> => {
    calls.push({ msgs, outAtCall: cap?.out() ?? "" })
    if (rejectWith !== undefined) throw rejectWith
  }
  return { calls, replaceMessages }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewind-live-swap-"))
  process.env.QUANTA_SESSIONS_DIR = dir
  __resetRuntimeConfig()
})
afterEach(() => {
  delete process.env.QUANTA_SESSIONS_DIR
  __resetRuntimeConfig()
  rmSync(dir, { recursive: true, force: true })
})

const rewindCmd = () => {
  const cmd = rewindCommands[0]
  if (cmd === undefined || cmd.name !== "/rewind") throw new Error("expected /rewind")
  return cmd
}

/* ------------------------------------------------------------------ */
/* applyLiveHistorySwap — seam unit contract                           */
/* ------------------------------------------------------------------ */

describe("applyLiveHistorySwap seam", () => {
  test("undefined slot ⇒ no swap, returns false", async () => {
    expect(await applyLiveHistorySwap(undefined, [])).toBe(false)
  })
  test("slot without replaceMessages ⇒ no swap, returns false", async () => {
    expect(await applyLiveHistorySwap({}, [])).toBe(false)
  })
  test("undefined messages ⇒ no swap even with a live slot", async () => {
    const rec = buildSwapRecorder()
    expect(await applyLiveHistorySwap({ replaceMessages: rec.replaceMessages }, undefined)).toBe(
      false,
    )
    expect(rec.calls.length).toBe(0)
  })
  test("live slot + messages ⇒ swap runs with the EXACT array, returns true", async () => {
    const rec = buildSwapRecorder()
    const msgs = [mkMessage("a", "user", "x0")]
    expect(await applyLiveHistorySwap({ replaceMessages: rec.replaceMessages }, msgs)).toBe(true)
    expect(rec.calls.length).toBe(1)
    expect(rec.calls[0]?.msgs).toBe(msgs)
  })
  test("rejection propagates to the caller (no silent swallow)", async () => {
    const rec = buildSwapRecorder(undefined, new Error("boom-swap"))
    await expect(
      applyLiveHistorySwap({ replaceMessages: rec.replaceMessages }, []),
    ).rejects.toThrow("boom-swap")
  })
})

/* ------------------------------------------------------------------ */
/* /rewind — disk truncation must reach the live history               */
/* ------------------------------------------------------------------ */

describe("/rewind live-history swap (UUX-4-02)", () => {
  test("RED-CORE: --yes with a live slot ⇒ slot messages ACTUALLY replaced (fresh readback)", async () => {
    await seed("s-live")
    const cap = buildCtx()
    const rec = buildSwapRecorder(cap)
    const state: RewindSlashState = {
      sessionId: "s-live",
      env: { QUANTA_REWIND: "1" },
      replaceMessages: rec.replaceMessages,
    }
    const code = await rewindCmd().run(["m2", "--yes"], {
      ...cap.ctx,
      rewindSession: state,
    } as SlashContext)
    expect(code).toBe(0)
    // Disk effect (control): transcript truncated to m0..m2.
    const reloaded = await loadSessionById("s-live")
    expect(reloaded?.messages.length).toBe(3)
    // LIVE effect (the fix): the slot received the SAME truncated history.
    expect(rec.calls.length).toBe(1)
    expect(rec.calls[0]?.msgs.map((m) => m.id)).toEqual(["m0", "m1", "m2"])
    // Ordering: success copy printed only AFTER the swap ran.
    expect(rec.calls[0]?.outAtCall).not.toContain("rewound to")
    expect(cap.out()).toContain("rewound to m2")
  })

  test("paired control: no live slot on the state ⇒ prior behavior byte-preserved", async () => {
    await seed("s-noslot")
    const cap = buildCtx()
    const state: RewindSlashState = { sessionId: "s-noslot", env: { QUANTA_REWIND: "1" } }
    const code = await rewindCmd().run(["m2", "--yes"], {
      ...cap.ctx,
      rewindSession: state,
    } as SlashContext)
    expect(code).toBe(0)
    expect(cap.out()).toContain("rewound to m2")
    const reloaded = await loadSessionById("s-noslot")
    expect(reloaded?.messages.length).toBe(3)
  })

  test("confirm path (no --yes) never touches the live slot", async () => {
    await seed("s-preview")
    const cap = buildCtx()
    const rec = buildSwapRecorder(cap)
    const state: RewindSlashState = {
      sessionId: "s-preview",
      env: { QUANTA_REWIND: "1" },
      replaceMessages: rec.replaceMessages,
    }
    const code = await rewindCmd().run(["m1"], {
      ...cap.ctx,
      rewindSession: state,
    } as SlashContext)
    expect(code).toBe(0)
    expect(rec.calls.length).toBe(0)
    const reloaded = await loadSessionById("s-preview")
    expect(reloaded?.messages.length).toBe(5)
  })

  test("red-on-injection: swap rejection ⇒ exit 1 + honest disk-state note, NO bare success line", async () => {
    await seed("s-swapfail")
    const cap = buildCtx()
    const rec = buildSwapRecorder(cap, new Error("surface gone"))
    const state: RewindSlashState = {
      sessionId: "s-swapfail",
      env: { QUANTA_REWIND: "1" },
      replaceMessages: rec.replaceMessages,
    }
    const code = await rewindCmd().run(["m2", "--yes"], {
      ...cap.ctx,
      rewindSession: state,
    } as SlashContext)
    expect(code).toBe(1)
    expect(cap.err()).toContain("live history")
    expect(cap.err()).toContain("surface gone")
    // The disk effect DID happen and the error copy must say so.
    expect(cap.err()).toContain("disk")
    expect(cap.out()).not.toContain("rewound to m2")
  })
})

/* ------------------------------------------------------------------ */
/* /rewind-tool — task leg must swap, not just print                   */
/* ------------------------------------------------------------------ */

const TAG = "tool:edit_file:t1:0" as CheckpointTag

const buildRegistry = (): GranularRegistry =>
  ({
    list: () => [{ tag: TAG, granularity: "tool", sha: "a".repeat(40), toolName: "edit_file" }],
  }) as unknown as GranularRegistry

const buildRestorePort = (outcome: RestoreOutcome): ThreeWayRestorePort => ({
  restoreFiles: async () => outcome,
  restoreTask: async () => outcome,
  restoreBoth: async () => outcome,
})

describe("/rewind-tool task-leg live-history swap (UUX-6-03)", () => {
  const after: ReadonlyArray<Message> = [mkMessage("restored", "user", "r0")]

  test("RED-CORE: --mode=task --yes with messagesAfter ⇒ slot actually swapped, success after swap", async () => {
    const cap = buildCtx()
    const rec = buildSwapRecorder(cap)
    const state: PerToolCheckpointSlashState = {
      registry: buildRegistry(),
      restore: buildRestorePort({
        ok: true,
        message: "task restored",
        tag: TAG,
        messagesAfter: after,
      }),
      replaceMessages: rec.replaceMessages,
    }
    const code = await rewindToolCmd.run([TAG, "--mode=task", "--yes"], {
      ...cap.ctx,
      perToolCheckpoint: state,
    } as SlashContext)
    expect(code).toBe(0)
    expect(rec.calls.length).toBe(1)
    expect(rec.calls[0]?.msgs).toBe(after)
    // Success copy only after the swap.
    expect(rec.calls[0]?.outAtCall).not.toContain("OK")
    expect(cap.out()).toContain("OK")
  })

  test("--mode=both also swaps", async () => {
    const cap = buildCtx()
    const rec = buildSwapRecorder(cap)
    const state: PerToolCheckpointSlashState = {
      registry: buildRegistry(),
      restore: buildRestorePort({
        ok: true,
        message: "both restored",
        tag: TAG,
        messagesAfter: after,
      }),
      replaceMessages: rec.replaceMessages,
    }
    const code = await rewindToolCmd.run([TAG, "--mode=both", "--yes"], {
      ...cap.ctx,
      perToolCheckpoint: state,
    } as SlashContext)
    expect(code).toBe(0)
    expect(rec.calls.length).toBe(1)
  })

  test("adversarial: --mode=files NEVER swaps even when the outcome carries messagesAfter", async () => {
    const cap = buildCtx()
    const rec = buildSwapRecorder(cap)
    const state: PerToolCheckpointSlashState = {
      registry: buildRegistry(),
      restore: buildRestorePort({
        ok: true,
        message: "files restored",
        tag: TAG,
        messagesAfter: after,
      }),
      replaceMessages: rec.replaceMessages,
    }
    const code = await rewindToolCmd.run([TAG, "--mode=files", "--yes"], {
      ...cap.ctx,
      perToolCheckpoint: state,
    } as SlashContext)
    expect(code).toBe(0)
    expect(rec.calls.length).toBe(0)
  })

  test("adversarial: task leg WITHOUT messagesAfter ⇒ no swap, no crash, outcome printed", async () => {
    const cap = buildCtx()
    const rec = buildSwapRecorder(cap)
    const state: PerToolCheckpointSlashState = {
      registry: buildRegistry(),
      restore: buildRestorePort({ ok: true, message: "task restored (no messages)", tag: TAG }),
      replaceMessages: rec.replaceMessages,
    }
    const code = await rewindToolCmd.run([TAG, "--mode=task", "--yes"], {
      ...cap.ctx,
      perToolCheckpoint: state,
    } as SlashContext)
    expect(code).toBe(0)
    expect(rec.calls.length).toBe(0)
    expect(cap.out()).toContain("OK")
  })

  test("adversarial: failed outcome (ok:false) ⇒ no swap", async () => {
    const cap = buildCtx()
    const rec = buildSwapRecorder(cap)
    const state: PerToolCheckpointSlashState = {
      registry: buildRegistry(),
      restore: buildRestorePort({
        ok: false,
        errorCode: "shadow-odb-not-configured",
        message: "nope",
        tag: TAG,
        messagesAfter: after,
      }),
      replaceMessages: rec.replaceMessages,
    }
    const code = await rewindToolCmd.run([TAG, "--mode=task", "--yes"], {
      ...cap.ctx,
      perToolCheckpoint: state,
    } as SlashContext)
    expect(code).toBe(1)
    expect(rec.calls.length).toBe(0)
  })

  test("red-on-injection: swap rejection ⇒ exit 1 + honest note", async () => {
    const cap = buildCtx()
    const rec = buildSwapRecorder(cap, new Error("swap-die"))
    const state: PerToolCheckpointSlashState = {
      registry: buildRegistry(),
      restore: buildRestorePort({
        ok: true,
        message: "task restored",
        tag: TAG,
        messagesAfter: after,
      }),
      replaceMessages: rec.replaceMessages,
    }
    const code = await rewindToolCmd.run([TAG, "--mode=task", "--yes"], {
      ...cap.ctx,
      perToolCheckpoint: state,
    } as SlashContext)
    expect(code).toBe(1)
    expect(cap.err()).toContain("swap-die")
  })

  test("paired control: slot without replaceMessages (old shape) ⇒ prior print-only behavior", async () => {
    const cap = buildCtx()
    const state: PerToolCheckpointSlashState = {
      registry: buildRegistry(),
      restore: buildRestorePort({
        ok: true,
        message: "task restored",
        tag: TAG,
        messagesAfter: after,
      }),
    }
    const code = await rewindToolCmd.run([TAG, "--mode=task", "--yes"], {
      ...cap.ctx,
      perToolCheckpoint: state,
    } as SlashContext)
    expect(code).toBe(0)
    expect(cap.out()).toContain("OK")
  })
})

/* ------------------------------------------------------------------ */
/* /rewind-conv — confirm gate (UUX-6-09) + seam adoption (behavior pin)*/
/* ------------------------------------------------------------------ */

const buildConvSlot = (
  rec: ReturnType<typeof buildSwapRecorder>,
): { slot: ConvCheckpointSlashState; snapshot: ReadonlyArray<Message> } => {
  const snapshot: ReadonlyArray<Message> = [
    mkMessage("checkpointed", "user", "c0"),
    mkMessage("reply", "assistant", "c1"),
  ]
  const wire: ConvCheckpointWire = {
    recordTurn: () => {
      /* not used here */
    },
    listTags: () => [{ tag: "T1", takenAt: 1_700_000_000_000, len: snapshot.length }],
    restore: (tag: string) => (tag === "T1" ? snapshot : null),
    stop: () => {
      /* not used here */
    },
  }
  return {
    slot: { wire, replaceMessages: rec.replaceMessages },
    snapshot,
  }
}

describe("/rewind-conv confirm gate + swap pin (UUX-6-09)", () => {
  test("RED-CORE: <tag> WITHOUT --yes ⇒ refuses (exit 1), live history untouched, preview printed", async () => {
    const cap = buildCtx()
    const rec = buildSwapRecorder(cap)
    const { slot } = buildConvSlot(rec)
    const code = await rewindConvCmd.run(["T1"], {
      ...cap.ctx,
      convCheckpoint: slot,
    } as SlashContext)
    expect(code).toBe(1)
    expect(rec.calls.length).toBe(0)
    expect(cap.out()).toContain("--yes")
    expect(cap.out()).toContain("T1")
  })

  test("<tag> --yes ⇒ proceeds; success copy byte-identical to the pre-confirm restore path", async () => {
    const cap = buildCtx()
    const rec = buildSwapRecorder(cap)
    const { slot, snapshot } = buildConvSlot(rec)
    const code = await rewindConvCmd.run(["T1", "--yes"], {
      ...cap.ctx,
      convCheckpoint: slot,
    } as SlashContext)
    expect(code).toBe(0)
    expect(rec.calls.length).toBe(1)
    expect(rec.calls[0]?.msgs).toBe(snapshot)
    // Byte-identical pin: the success copy is EXACTLY what the pre-refactor
    // command printed for a bare `/rewind-conv T1`.
    expect(cap.out()).toBe("restored 'T1' (2 messages).\n")
    // Ordering: swap before success copy.
    expect(rec.calls[0]?.outAtCall).not.toContain("restored")
  })

  test("unknown tag with --yes ⇒ unchanged 'no such tag' + exit 1", async () => {
    const cap = buildCtx()
    const rec = buildSwapRecorder(cap)
    const { slot } = buildConvSlot(rec)
    const code = await rewindConvCmd.run(["nope", "--yes"], {
      ...cap.ctx,
      convCheckpoint: slot,
    } as SlashContext)
    expect(code).toBe(1)
    expect(cap.err()).toContain("no such tag")
    expect(rec.calls.length).toBe(0)
  })

  test("list forms unchanged (no confirm involvement)", async () => {
    const cap = buildCtx()
    const rec = buildSwapRecorder(cap)
    const { slot } = buildConvSlot(rec)
    const code = await rewindConvCmd.run(["--list"], {
      ...cap.ctx,
      convCheckpoint: slot,
    } as SlashContext)
    expect(code).toBe(0)
    expect(cap.out()).toContain("T1")
    expect(rec.calls.length).toBe(0)
  })

  test("not wired ⇒ unchanged surface-only degrade (exit 0)", async () => {
    const cap = buildCtx()
    const code = await rewindConvCmd.run(["T1", "--yes"], cap.ctx)
    expect(code).toBe(0)
    expect(cap.out()).toContain("not wired")
  })
})

/* ------------------------------------------------------------------ */
/* wiring proof — the surface builder threads the ONE swap closure     */
/* ------------------------------------------------------------------ */

describe("live-swap wiring proof (surface builder)", () => {
  test("buildReplSlashCtx threads perToolReplaceMessages onto the /rewind-tool slot", async () => {
    const { buildReplSlashCtx } = await import("../../../src/apps/cli/repl/slash-surface")
    const rec = buildSwapRecorder()
    const ctx = buildReplSlashCtx({
      skillsCb: undefined,
      idleMonitor: {} as never,
      imageQueue: undefined,
      rewindState: undefined,
      mcpSurface: undefined,
      costPanel: undefined,
      planStore: undefined,
      branchProgress: undefined,
      getHistory: () => [],
      startSideConversation: async () => {
        throw new Error("unused")
      },
      isSideConversationWired: () => false,
      abortSignal: new AbortController().signal,
      debugHandle: undefined,
      llm: undefined,
      sessionId: undefined,
      model: "m",
      inspect: undefined,
      replay: undefined,
      effort: undefined as never,
      brief: undefined as never,
      contextUsage: undefined,
      perToolRegistry: buildRegistry(),
      perToolReplaceMessages: rec.replaceMessages,
    } as never)
    // The slot must carry the SAME closure — the surface's ONE swap seam.
    expect(ctx.perToolCheckpoint?.replaceMessages).toBe(rec.replaceMessages)
  })

  test("buildPerToolCheckpointAdapter passes replaceMessages through 1:1 (and omits when absent)", async () => {
    const { buildPerToolCheckpointAdapter } = await import(
      "../../../src/apps/cli/repl/ctx-adapters/per-tool-checkpoint-adapter"
    )
    const rec = buildSwapRecorder()
    const withHook = buildPerToolCheckpointAdapter({
      registry: buildRegistry(),
      replaceMessages: rec.replaceMessages,
    })
    expect(withHook.replaceMessages).toBe(rec.replaceMessages)
    const withoutHook = buildPerToolCheckpointAdapter({ registry: buildRegistry() })
    expect("replaceMessages" in withoutHook).toBe(false)
  })
})
