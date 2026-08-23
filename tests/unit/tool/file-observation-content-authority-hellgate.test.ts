/**
 * HELLGATE — F2: content is the freshness authority; mtime is a hint
 * (§17.5 packet F2).
 *
 * The stale-read guard records the mtime a file carried when the agent read it,
 * and blocks a later write only on a STRICT FORWARD move. Its own comment says
 * so: "only a FORWARD move is evidence of an external write after the read".
 *
 * That makes the guard bypassable by anything that changes a file's CONTENT
 * without advancing its mtime — and that is not exotic. `cp -p`, `rsync
 * --times`, `tar -x`, `git checkout` on some filesystems, a build step that
 * restores timestamps, or a second-granularity filesystem where two writes land
 * in the same tick all produce a content change with an equal-or-earlier mtime.
 * Measured on the shipping guard: a same-mtime swap and a backward-mtime swap
 * are both ALLOWED.
 *
 * A second, separate gap: a subagent gets NO guard at all.
 * `subagent-runner-child-config.ts` never mentions `readFileState`, so the child
 * config carries none and every child mutation skips the guard entirely.
 *
 * The fix makes the recorded CONTENT DIGEST the authority when one is available
 * on both sides, and leaves the mtime rule exactly as-is when it is not — so a
 * caller that cannot cheaply hash keeps today's behavior byte-for-byte.
 *
 * NOT "atomic CAS". A check-then-rename on an ordinary filesystem leaves an
 * external-writer TOCTOU window between the digest comparison and the rename.
 * This narrows Quanta's OWN self-inflicted staleness; real isolation is the
 * worktree/ownership boundary.
 *
 * Invariants:
 *
 *  F2-1  RED — a SAME-mtime content swap is stale.
 *  F2-2  RED — a BACKWARD-mtime content swap is stale.
 *  F2-3  PAIRED CONTROL — an unchanged digest is fresh even if the mtime moved
 *        FORWARD. Without this the fix would be "block everything", which passes
 *        F2-1/F2-2 and makes the tool unusable: a mutation that rewrites a file
 *        to identical bytes must not veto the next edit.
 *  F2-4  Digest beats mtime in BOTH directions — that is what "authority" means.
 *  F2-5  FALLBACK PARITY — with no digest recorded, or none supplied, the
 *        forward-mtime rule is unchanged.
 *  F2-6  `unread` still passes: a file the agent never read has no baseline and
 *        cannot be stale (creating a new file must keep working).
 *  F2-7  A successful self-mutation updates only THAT state instance.
 *  F2-8  CHILD-LOCAL — a subagent gets its OWN state instance, never the
 *        parent's, and never `undefined` when the parent has one.
 */

import { describe, expect, test } from "bun:test"
import { guardWrite, ReadFileState } from "@/tool/stale-read-guard"

const digestOf = (s: string): string => Bun.hash(s).toString(16)

describe("F2 — content digest is the freshness authority", () => {
  test("F2-1 a SAME-mtime content swap is stale", () => {
    const state = new ReadFileState()
    state.record("/a.ts", 1000)
    state.recordContent("/a.ts", digestOf("original"))
    const guard = guardWrite(state, "/a.ts", 1000, digestOf("swapped"))
    expect(guard.ok).toBe(false)
  })

  test("F2-2 a BACKWARD-mtime content swap is stale", () => {
    const state = new ReadFileState()
    state.record("/a.ts", 1000)
    state.recordContent("/a.ts", digestOf("original"))
    const guard = guardWrite(state, "/a.ts", 1, digestOf("swapped"))
    expect(guard.ok).toBe(false)
  })

  test("F2-3 PAIRED CONTROL — an unchanged digest is fresh even when mtime moved forward", () => {
    const state = new ReadFileState()
    state.record("/a.ts", 1000)
    state.recordContent("/a.ts", digestOf("same bytes"))
    // A `touch`, a mode change, or a rewrite to identical bytes. Blocking here
    // would veto the model's next edit for no reason.
    const guard = guardWrite(state, "/a.ts", 9999, digestOf("same bytes"))
    expect(guard.ok).toBe(true)
  })

  test("F2-4 the digest decides in BOTH directions", () => {
    const state = new ReadFileState()
    state.record("/a.ts", 1000)
    state.recordContent("/a.ts", digestOf("v1"))
    expect(guardWrite(state, "/a.ts", 5000, digestOf("v1")).ok).toBe(true)
    expect(guardWrite(state, "/a.ts", 1000, digestOf("v2")).ok).toBe(false)
  })

  test("F2-5 FALLBACK PARITY — no digest recorded ⇒ the forward-mtime rule is unchanged", () => {
    const state = new ReadFileState()
    state.record("/a.ts", 1000)
    expect(guardWrite(state, "/a.ts", 1001).ok).toBe(false)
    expect(guardWrite(state, "/a.ts", 1000).ok).toBe(true)
    expect(guardWrite(state, "/a.ts", 999).ok).toBe(true)
  })

  test("F2-5b a digest RECORDED but not SUPPLIED still falls back to mtime", () => {
    const state = new ReadFileState()
    state.record("/a.ts", 1000)
    state.recordContent("/a.ts", digestOf("v1"))
    expect(guardWrite(state, "/a.ts", 1001).ok).toBe(false)
    expect(guardWrite(state, "/a.ts", 1000).ok).toBe(true)
  })

  test("F2-6 an unread file is never stale — creating a new file keeps working", () => {
    const state = new ReadFileState()
    expect(guardWrite(state, "/brand-new.ts", 1, digestOf("anything")).ok).toBe(true)
  })

  test("F2-7 re-recording content re-baselines that state only", () => {
    const a = new ReadFileState()
    const b = new ReadFileState()
    a.record("/a.ts", 1000)
    a.recordContent("/a.ts", digestOf("v1"))
    b.record("/a.ts", 1000)
    b.recordContent("/a.ts", digestOf("v1"))

    a.recordContent("/a.ts", digestOf("v2"))
    // `a` re-read (or wrote) and now holds v2; `b` still believes v1.
    expect(guardWrite(a, "/a.ts", 1000, digestOf("v2")).ok).toBe(true)
    expect(guardWrite(b, "/a.ts", 1000, digestOf("v2")).ok).toBe(false)
  })
})

describe("F2-8 CHILD-LOCAL state — a subagent never shares the parent's observations", () => {
  /** Drive the SHIPPED `buildChildConfig` — the function the subagent runner
   *  calls — rather than an inner helper, so the slot cannot be correct in
   *  isolation and absent in the config the child actually runs with. */
  const childOf = async (parentState: ReadFileState | undefined) => {
    const { buildChildConfig } = await import("@/agent/subagent-runner-child-config")
    const parent = {
      llm: { stream: async function* () {} },
      registry: { get: () => undefined, specs: () => [], isReadOnly: () => true },
      stream: { emit: () => undefined },
      permission: { mode: "acceptEdits" },
      messages: [],
      system: "t",
      cwd: process.cwd(),
      maxTurns: 1,
      signal: new AbortController().signal,
      ...(parentState !== undefined ? { readFileState: parentState } : {}),
    } as never
    return buildChildConfig(parent, { prompt: "do a thing" } as never, process.cwd(), {
      agentId: "a1",
      parentId: "p1",
    } as never)
  }

  test("the child config gets its OWN instance when the parent has one", async () => {
    const parentState = new ReadFileState()
    parentState.record("/a.ts", 1000)
    parentState.recordContent("/a.ts", digestOf("parent saw v1"))

    const child = await childOf(parentState)
    expect(child.readFileState).toBeDefined()
    expect(child.readFileState).not.toBe(parentState)
  })

  test("a parent read does NOT make the child believe it read the file", async () => {
    const parentState = new ReadFileState()
    parentState.record("/a.ts", 1000)
    parentState.recordContent("/a.ts", digestOf("parent saw v1"))

    const child = await childOf(parentState)
    const childState = child.readFileState
    if (childState === undefined) throw new Error("child must have a state")
    // The child never read the file, so it is `unread` there — NOT "fresh
    // because a sibling read it". Inheriting the parent's observation would let
    // a child write over content it has never seen, and a sibling's re-read
    // would launder another sibling's stale baseline back to fresh.
    expect(childState.checkFresh("/a.ts", 1000).kind).toBe("unread")
  })

  test("PAIRED CONTROL — no parent guard ⇒ no child guard (byte-identical OFF)", async () => {
    const child = await childOf(undefined)
    expect(child.readFileState).toBeUndefined()
  })
})

/* ------------------------------------------------------------------------- *
 * F2-9 — the claim that matters, through the REAL read and edit tools.
 *
 * Everything above drives the pure guard. What protects a user is whether the
 * SHIPPED tools issue and compare the observation — a fix that got the state
 * layer right but never wired it would look identical here. So: read a file
 * through the real `read` tool, let an external writer swap its content while
 * moving the mtime BACKWARD (so the old rule would call it fresh), and drive a
 * real `edit`.
 * ------------------------------------------------------------------------- */

import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultTools, ToolRegistry } from "@/tool"

describe("F2-9 end-to-end — the shipped read/edit tools carry the observation", () => {
  const drive = async (
    dir: string,
    state: ReadFileState,
    name: string,
    input: unknown,
  ): Promise<{ ok: boolean; reason?: string }> => {
    const registry = new ToolRegistry(defaultTools)
    const tool = registry.get(name)
    if (tool === undefined) throw new Error(`tool ${name} is not registered`)
    const ctx = {
      cwd: dir,
      readFileState: state,
      signal: new AbortController().signal,
    } as never
    let last: { ok: boolean; failure?: { reason?: string } } | undefined
    for await (const ev of tool.execute(input as never, ctx)) {
      if (ev.type === "result") last = ev.result as typeof last
    }
    if (last === undefined) throw new Error("tool produced no result")
    return {
      ok: last.ok,
      ...(last.failure?.reason !== undefined ? { reason: last.failure.reason } : {}),
    }
  }

  test("a content swap with a BACKWARD mtime is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "f2-e2e-"))
    try {
      const file = join(dir, "a.txt")
      writeFileSync(file, "ORIGINAL\n")
      const before = statSync(file)
      const state = new ReadFileState()

      expect((await drive(dir, state, "read", { path: file })).ok).toBe(true)

      // An external writer changes the CONTENT and leaves the timestamp EARLIER
      // than the read — `cp -p`, `rsync --times`, `tar -x`, a build step that
      // restores mtimes. Under the mtime-only rule this reads as fresh.
      writeFileSync(file, "SWAPPED-BY-SOMEONE-ELSE\n")
      const past = new Date(before.mtimeMs - 60_000)
      utimesSync(file, past, past)
      expect(statSync(file).mtimeMs).toBeLessThan(before.mtimeMs)

      const edit = await drive(dir, state, "edit", {
        path: file,
        old_string: "SWAPPED",
        new_string: "MINE",
      })
      expect({ ok: edit.ok, reason: edit.reason }).toEqual({ ok: false, reason: "stale_read" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("PAIRED CONTROL — an untouched file still edits cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "f2-e2e-ok-"))
    try {
      const file = join(dir, "a.txt")
      writeFileSync(file, "ORIGINAL\n")
      const state = new ReadFileState()
      expect((await drive(dir, state, "read", { path: file })).ok).toBe(true)
      const edit = await drive(dir, state, "edit", {
        path: file,
        old_string: "ORIGINAL",
        new_string: "MINE",
      })
      expect(edit.ok).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
