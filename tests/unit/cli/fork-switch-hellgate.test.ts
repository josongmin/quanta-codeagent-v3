/**
 * UUX-4-07 hellgate — `/fork` switches the operator onto the fork.
 *
 * RED-CORE (pre-implementation): `/fork <id>` mints the new session on disk
 * but IGNORES the surface-wired `switchSession` seam — the operator stays on
 * the parent and the printed copy claims nothing about the live session.
 *
 * Contract pinned here:
 *
 *   - seam present ⇒ after a successful disk fork, `/fork` calls
 *     `switchSession(newSessionId)` and prints "now editing fork …" plus the
 *     receipt's persistence note (effect receipt: copy only AFTER the switch
 *     resolves);
 *   - seam ABSENT (legacy/non-REPL surface) ⇒ prior copy byte-identical,
 *     exit 0 (no switch claimed);
 *   - switch REJECTS (e.g. mid-turn `transcript_replace_unavailable`) ⇒
 *     exit 1, honest copy: the fork exists on disk but the live session is
 *     unchanged (+ the disk fork is NOT rolled back — it is durable state the
 *     user can resume);
 *   - disk-fork failure (bad message id) ⇒ switch NEVER called (live state
 *     untouched).
 *
 * Real session-store effects (temp QUANTA_SESSIONS_DIR) + fresh readback.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message } from "@/llm"
import { loadSessionById, type SavePayload, type SessionMeta, saveSessionById } from "@/session"
import { __resetRuntimeConfig } from "@/shared"
import type { SessionSwitchReceipt } from "../../../src/apps/cli/repl/session-loop/session-switch"
import { type RewindSlashState, rewindCommands } from "../../../src/apps/cli/rewind-cmd"
import type { SlashContext } from "../../../src/apps/cli/slash-commands"

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
  ]
  const payload: SavePayload = { reason: "ok", turns: 2, messages }
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

/** switchSession recorder — captures calls + the out content AT call time so
 *  effect-receipt ordering ("now editing" prints only after the switch) is
 *  observable. */
const buildSwitchRecorder = (cap?: Captured, rejectWith?: Error) => {
  const calls: { id: string; outAtCall: string }[] = []
  const switchSession = async (id: string): Promise<SessionSwitchReceipt> => {
    calls.push({ id, outAtCall: cap?.out() ?? "" })
    if (rejectWith !== undefined) throw rejectWith
    return {
      sessionId: id,
      persistTarget: "fork-id",
      persistNote: `future turns persist under ${id}`,
    }
  }
  return { calls, switchSession }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fork-switch-"))
  process.env.QUANTA_SESSIONS_DIR = dir
  __resetRuntimeConfig()
})
afterEach(() => {
  delete process.env.QUANTA_SESSIONS_DIR
  __resetRuntimeConfig()
  rmSync(dir, { recursive: true, force: true })
})

const forkCmd = () => {
  const cmd = rewindCommands[1]
  if (cmd === undefined || cmd.name !== "/fork") throw new Error("expected /fork")
  return cmd
}

/* ------------------------------------------------------------------ */
/* the switch                                                          */
/* ------------------------------------------------------------------ */

describe("/fork switch (UUX-4-07)", () => {
  test("RED-CORE: seam present ⇒ switchSession(newId) called + 'now editing' copy AFTER the switch", async () => {
    await seed("s-fork")
    const cap = buildCtx()
    const rec = buildSwitchRecorder(cap)
    const state: RewindSlashState = {
      sessionId: "s-fork",
      env: { QUANTA_REWIND: "1" },
      switchSession: rec.switchSession,
    }
    const code = await forkCmd().run(["m1"], { ...cap.ctx, rewindSession: state })
    expect(code).toBe(0)
    expect(rec.calls.length).toBe(1)
    const newId = rec.calls[0]?.id as string
    expect(typeof newId).toBe("string")
    expect(newId.length).toBeGreaterThan(0)
    expect(newId).not.toBe("s-fork")
    // fresh readback: the fork is real and truncated to the fork point
    const fork = await loadSessionById(newId)
    expect(fork?.messages.map((m) => m.id)).toEqual(["m0", "m1"])
    // effect receipt: the "now editing" copy was NOT printed before the switch ran
    expect(rec.calls[0]?.outAtCall ?? "").not.toContain("now editing")
    expect(cap.out()).toContain(`now editing fork ${newId}`)
    expect(cap.out()).toContain(`future turns persist under ${newId}`)
  })

  test("seam absent ⇒ legacy copy, exit 0, no switch claimed", async () => {
    await seed("s-legacy")
    const cap = buildCtx()
    const state: RewindSlashState = {
      sessionId: "s-legacy",
      env: { QUANTA_REWIND: "1" },
    }
    const code = await forkCmd().run(["m1"], { ...cap.ctx, rewindSession: state })
    expect(code).toBe(0)
    expect(cap.out()).toContain("forked at")
    expect(cap.out()).not.toContain("now editing")
  })

  test("switch REJECTS ⇒ exit 1, honest disk-vs-live copy, fork remains on disk", async () => {
    await seed("s-reject")
    const cap = buildCtx()
    const rec = buildSwitchRecorder(cap, new Error("transcript_replace_unavailable"))
    const state: RewindSlashState = {
      sessionId: "s-reject",
      env: { QUANTA_REWIND: "1" },
      switchSession: rec.switchSession,
    }
    const code = await forkCmd().run(["m1"], { ...cap.ctx, rewindSession: state })
    expect(code).toBe(1)
    expect(rec.calls.length).toBe(1)
    const newId = rec.calls[0]?.id as string
    // honest copy: disk fork exists, live unchanged, how to recover
    expect(cap.err()).toContain(newId)
    expect(cap.err()).toContain("live")
    expect(cap.err()).toContain("--resume")
    // no success copy leaked
    expect(cap.out()).not.toContain("now editing")
    // the disk fork is durable (not rolled back) — user can resume it
    const fork = await loadSessionById(newId)
    expect(fork).toBeDefined()
    // parent untouched
    const parent = await loadSessionById("s-reject")
    expect(parent?.messages.length).toBe(4)
  })

  test("disk-fork failure (unknown message id) ⇒ switch NEVER called", async () => {
    await seed("s-badid")
    const cap = buildCtx()
    const rec = buildSwitchRecorder(cap)
    const state: RewindSlashState = {
      sessionId: "s-badid",
      env: { QUANTA_REWIND: "1" },
      switchSession: rec.switchSession,
    }
    const code = await forkCmd().run(["zz-nope"], { ...cap.ctx, rewindSession: state })
    expect(code).toBe(1)
    expect(rec.calls.length).toBe(0)
  })
})
