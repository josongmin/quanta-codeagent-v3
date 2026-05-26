/**
 * ADR-0292 — ConvCheckpointWire (surface-side per-turn auto-record) +
 * `/rewind-conv` slash command hellgate.
 *
 * The wire lives in `src/apps/cli/repl/conv-checkpoint-wire.ts` and is
 * caller-driven (host calls `recordTurn(messages)` at turn-end). The
 * slash command lives in `src/apps/cli/rewind-conv-cmd.ts` and is
 * registered into BUILTINS so `runSlashCommand("/rewind-conv …", ctx)`
 * dispatches into it.
 *
 * Cases:
 *   1.  `startConvCheckpointWire` returns a wire whose `recordTurn` is
 *       idempotent on duplicate turn N (tagFormat collision).
 *   2.  `recordTurn` then `restore(tag)` round-trips the messages array
 *       (shallow equality on the array contents).
 *   3.  `listTags()` returns newest-first; deterministic insertion order
 *       on equal `takenAt` (the underlying store reverses its Map).
 *   4.  `stop()` makes subsequent `recordTurn` a no-op (defensive).
 *   5.  `/rewind-conv` with absent `ctx.convCheckpoint` →
 *       "not wired in this surface" + exit 0.
 *   6.  `/rewind-conv` no args + present ctx → prints tag list (assert
 *       contains at least one tag after a `recordTurn`).
 *   7.  `/rewind-conv <unknown-tag>` → "no such tag" + exit 1.
 *   8.  `/rewind-conv <valid-tag>` → calls `replaceMessages(restored)` +
 *       exit 0 (mocked surface adapter).
 *   9.  `recordTurn` is no-throw when the store internals fail.
 *   10. tagFormat override is honored verbatim in the list output.
 *   11. maxEntries on the store caps the visible list (LRU eviction).
 *   12. `recordTurn` with empty messages array ⇒ valid tag, zero-len
 *       record.
 *   13. Race: two concurrent `recordTurn` calls don't corrupt the tag
 *       counter (both unique tags, no overwrite).
 *   14. `--list` flag aliases to the bare-args list path.
 *   15. Unknown flag exits 1 with typed message.
 */

import { describe, expect, test } from "bun:test"
import type { Message } from "@/llm"
import { defaultConversationCheckpointStore } from "../../src/agent/conversation-checkpoint"
import type {
  ConvCheckpointWire,
  ConvCheckpointWireOpts,
} from "../../src/apps/cli/repl/conv-checkpoint-wire"
import { startConvCheckpointWire } from "../../src/apps/cli/repl/conv-checkpoint-wire"
import { rewindConvCmd } from "../../src/apps/cli/rewind-conv-cmd"
import type { SlashContext } from "../../src/apps/cli/slash-commands"
import { runSlashCommand } from "../../src/apps/cli/slash-commands"

/* ------------------------------------------------------------------ */
/* test scaffolding                                                    */
/* ------------------------------------------------------------------ */

const buildCtx = (
  overrides?: Partial<SlashContext> & {
    readonly wire?: ConvCheckpointWire
    readonly onReplace?: (msgs: ReadonlyArray<Message>) => Promise<void> | void
  },
): {
  ctx: SlashContext
  out: string[]
  err: string[]
} => {
  const out: string[] = []
  const err: string[] = []
  const wire = overrides?.wire
  const onReplace = overrides?.onReplace
  const base: SlashContext = {
    out: (s) => {
      out.push(s)
    },
    err: (s) => {
      err.push(s)
    },
    cwd: "/tmp",
    ...(wire !== undefined
      ? {
          convCheckpoint: {
            wire,
            replaceMessages: async (messages) => {
              await onReplace?.(messages)
            },
          },
        }
      : {}),
  }
  // Strip our private helper fields so we don't leak them into the
  // SlashContext shape.
  const { wire: _w, onReplace: _r, ...rest } = (overrides ?? {}) as Record<string, unknown>
  return { ctx: { ...base, ...rest } as SlashContext, out, err }
}

const m = (role: "user" | "assistant", text: string): Message =>
  ({ role, content: [{ type: "text", text }] }) as Message

const buildWire = (opts?: Partial<ConvCheckpointWireOpts>): ConvCheckpointWire => {
  const store = opts?.store ?? defaultConversationCheckpointStore()
  return startConvCheckpointWire({ store, ...opts })
}

/* ------------------------------------------------------------------ */
/* wire-shape cases (1, 2, 3, 4, 9, 10, 11, 12, 13)                    */
/* ------------------------------------------------------------------ */

describe("ConvCheckpointWire — wire-shape hellgate", () => {
  test("case 1: idempotent on duplicate tag (tagFormat collision)", () => {
    const store = defaultConversationCheckpointStore()
    // tagFormat collapses to the SAME tag for every turn — the wire
    // records over it (store's documented "replace + update takenAt"
    // semantics). Two recordTurn calls ⇒ exactly one entry.
    const wire = startConvCheckpointWire({ store, tagFormat: () => "fixed-tag" })
    wire.recordTurn([m("user", "first")])
    wire.recordTurn([m("user", "second")])
    const tags = wire.listTags()
    expect(tags.length).toBe(1)
    expect(tags[0]?.tag).toBe("fixed-tag")
  })

  test("case 2: recordTurn + restore round-trips messages (shallow)", () => {
    const wire = buildWire({ tagFormat: (t) => `T${t}` })
    const msgs = [m("user", "hi"), m("assistant", "hello")]
    wire.recordTurn(msgs)
    const restored = wire.restore("T1")
    expect(restored).not.toBeNull()
    expect(restored?.length).toBe(2)
    expect(restored?.[0]).toBe(msgs[0])
    expect(restored?.[1]).toBe(msgs[1])
  })

  test("case 3: listTags returns newest-first; insertion-order on tie", () => {
    // Pin the clock so several tags share `takenAt`. Insertion order is
    // T1, T2, T3 — newest-first list ⇒ T3, T2, T1.
    const store = defaultConversationCheckpointStore({ now: () => 1234 })
    const wire = startConvCheckpointWire({ store, tagFormat: (t) => `T${t}` })
    wire.recordTurn([m("user", "a")])
    wire.recordTurn([m("user", "b")])
    wire.recordTurn([m("user", "c")])
    const tags = wire.listTags()
    expect(tags.map((t) => t.tag)).toEqual(["T3", "T2", "T1"])
    expect(tags.every((t) => t.takenAt === 1234)).toBe(true)
  })

  test("case 4: stop() makes subsequent recordTurn a no-op", () => {
    const wire = buildWire({ tagFormat: (t) => `T${t}` })
    wire.recordTurn([m("user", "a")])
    wire.stop()
    wire.recordTurn([m("user", "b")])
    wire.recordTurn([m("user", "c")])
    const tags = wire.listTags()
    expect(tags.length).toBe(1)
    expect(tags[0]?.tag).toBe("T1")
  })

  test("case 9: recordTurn swallows store-internal throws (no-throw)", () => {
    // Build a store-shaped fake whose `record` throws. The wire must
    // swallow and continue — failure to checkpoint is strictly less bad
    // than crashing the loop.
    const throwingStore = {
      ...defaultConversationCheckpointStore(),
      record: (): void => {
        throw new Error("boom — store internals")
      },
    }
    const wire = startConvCheckpointWire({
      store: throwingStore,
      tagFormat: (t) => `T${t}`,
    })
    expect(() => wire.recordTurn([m("user", "a")])).not.toThrow()
    // Even though record threw, the underlying delegate didn't add an
    // entry — `list()` from the real (non-throwing) base returns empty.
    expect(wire.listTags().length).toBe(0)
  })

  test("case 10: tagFormat override surfaces verbatim", () => {
    const wire = buildWire({ tagFormat: (t, now) => `custom@${t}#${now}` })
    wire.recordTurn([m("user", "a")])
    const tags = wire.listTags()
    expect(tags[0]?.tag).toMatch(/^custom@1#\d+$/)
  })

  test("case 11: store maxEntries caps the list (LRU eviction visible)", () => {
    const store = defaultConversationCheckpointStore({ maxEntries: 2 })
    const wire = startConvCheckpointWire({ store, tagFormat: (t) => `T${t}` })
    wire.recordTurn([m("user", "a")])
    wire.recordTurn([m("user", "b")])
    wire.recordTurn([m("user", "c")])
    wire.recordTurn([m("user", "d")])
    const tags = wire.listTags().map((t) => t.tag)
    // Oldest (T1, T2) evicted under LRU; newest two remain — newest-first.
    expect(tags).toEqual(["T4", "T3"])
  })

  test("case 12: recordTurn with empty messages array → valid zero-len record", () => {
    const wire = buildWire({ tagFormat: (t) => `T${t}` })
    wire.recordTurn([])
    const tags = wire.listTags()
    expect(tags.length).toBe(1)
    expect(tags[0]?.len).toBe(0)
    const restored = wire.restore("T1")
    expect(restored).not.toBeNull()
    expect(restored?.length).toBe(0)
  })

  test("case 13: two concurrent recordTurn calls don't corrupt the counter", async () => {
    // Two parallel calls — JS is single-threaded but Promise.all forces
    // both into the microtask queue. The counter must produce two
    // distinct tags (T1, T2) with no overwrite.
    const wire = buildWire({ tagFormat: (t) => `T${t}` })
    await Promise.all([
      Promise.resolve().then(() => wire.recordTurn([m("user", "a")])),
      Promise.resolve().then(() => wire.recordTurn([m("user", "b")])),
    ])
    const tags = wire
      .listTags()
      .map((t) => t.tag)
      .sort()
    expect(tags).toEqual(["T1", "T2"])
  })
})

/* ------------------------------------------------------------------ */
/* slash-command cases (5, 6, 7, 8, 14, 15)                            */
/* ------------------------------------------------------------------ */

describe("/rewind-conv — slash hellgate", () => {
  test("case 5: absent ctx.convCheckpoint → 'not wired' + exit 0", async () => {
    const { ctx, out, err } = buildCtx()
    const rc = await rewindConvCmd.run([], ctx)
    expect(rc).toBe(0)
    expect(out.join("")).toContain("not wired in this surface")
    expect(err.join("")).toBe("")
  })

  test("case 5b: BUILTINS dispatch path also degrades gracefully", async () => {
    // Run through the registry-level dispatch to seal the registration
    // touch in slash-commands.ts (the 1-line BUILTINS push).
    const { ctx, out, err } = buildCtx()
    const rc = await runSlashCommand("/rewind-conv", ctx)
    expect(rc).toBe(0)
    expect(out.join("")).toContain("not wired in this surface")
    expect(err.join("")).toBe("")
  })

  test("case 6: no args + wired → prints tag list with one tag after recordTurn", async () => {
    const wire = buildWire({ tagFormat: (t) => `T${t}` })
    wire.recordTurn([m("user", "a")])
    const { ctx, out, err } = buildCtx({ wire })
    const rc = await rewindConvCmd.run([], ctx)
    expect(rc).toBe(0)
    expect(err.join("")).toBe("")
    const text = out.join("")
    expect(text).toContain("1 checkpoint")
    expect(text).toContain("T1")
    expect(text).toContain("1 message")
  })

  test("case 6b: empty wire → '(no checkpoints yet)'", async () => {
    const wire = buildWire()
    const { ctx, out } = buildCtx({ wire })
    const rc = await rewindConvCmd.run([], ctx)
    expect(rc).toBe(0)
    expect(out.join("")).toContain("(no checkpoints yet)")
  })

  test("case 7: unknown tag → 'no such tag' + exit 1", async () => {
    const wire = buildWire({ tagFormat: (t) => `T${t}` })
    wire.recordTurn([m("user", "a")])
    const { ctx, out, err } = buildCtx({ wire })
    const rc = await rewindConvCmd.run(["does-not-exist"], ctx)
    expect(rc).toBe(1)
    expect(err.join("")).toContain("no such tag: does-not-exist")
    // Listing wasn't printed (errors only).
    expect(out.join("")).toBe("")
  })

  test("case 8: valid tag → replaceMessages(restored) called + exit 0", async () => {
    const wire = buildWire({ tagFormat: (t) => `T${t}` })
    const msgs = [m("user", "first"), m("assistant", "second")]
    wire.recordTurn(msgs)
    const captured: ReadonlyArray<Message>[] = []
    const { ctx, out, err } = buildCtx({
      wire,
      onReplace: async (m2) => {
        captured.push(m2)
      },
    })
    const rc = await rewindConvCmd.run(["T1"], ctx)
    expect(rc).toBe(0)
    expect(err.join("")).toBe("")
    expect(captured.length).toBe(1)
    expect(captured[0]?.length).toBe(2)
    expect(out.join("")).toContain("restored 'T1' (2 messages)")
  })

  test("case 14: --list flag aliases to the no-arg list path", async () => {
    const wire = buildWire({ tagFormat: (t) => `T${t}` })
    wire.recordTurn([m("user", "a")])
    const { ctx, out, err } = buildCtx({ wire })
    const rc = await rewindConvCmd.run(["--list"], ctx)
    expect(rc).toBe(0)
    expect(err.join("")).toBe("")
    expect(out.join("")).toContain("T1")
  })

  test("case 15: unknown flag → typed error + exit 1", async () => {
    const wire = buildWire()
    const { ctx, err } = buildCtx({ wire })
    const rc = await rewindConvCmd.run(["--bogus"], ctx)
    expect(rc).toBe(1)
    expect(err.join("")).toContain("unknown flag: --bogus")
  })

  test("case 15b: too many args → typed error + exit 1", async () => {
    const wire = buildWire()
    const { ctx, err } = buildCtx({ wire })
    const rc = await rewindConvCmd.run(["tag-1", "tag-2"], ctx)
    expect(rc).toBe(1)
    expect(err.join("")).toContain("takes at most one argument")
  })
})
