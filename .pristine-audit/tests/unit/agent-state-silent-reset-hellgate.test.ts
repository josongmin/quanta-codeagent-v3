import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { chmod, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { loadSession, saveSession } from "@/agent"
import { SessionStateLoadError } from "@/agent/state"
import type { Message } from "@/llm"
import type { AtomicWriteSync } from "@/storage"

/**
 * jun-10 silent-failure audit — findings #2 (P1) + #14 (P2), src/agent/state.ts.
 *
 * #2  saveSession claimed tmp+rename atomicity but did truncate-then-COPY with
 *     a SILENT plain-write fallback: a crash mid-write left torn JSON that
 *     loadSession swallowed → the `--state` transcript silently reset.
 * #14 loadSession validated only the envelope and cast message elements
 *     through (the S19 defect class already fixed in src/session/store.ts).
 *
 * Hellgate contract sealed here:
 *  (a) torn/truncated JSON on an EXISTING file → typed SessionStateLoadError
 *      naming the file — never a silent `null` fresh-start;
 *  (b) valid JSON whose message ELEMENTS fail the shared S19 schema → typed
 *      rejection carrying the first invalid index;
 *  (c) atomic write shape — temp staged in the SAME directory then renamed
 *      (observed via the injected AtomicWriteSync seam), file mode preserved,
 *      and a failure BEFORE the rename (simulated crash point) propagates
 *      loudly while the previous on-disk payload survives byte-identical
 *      (fresh readback) with no fallback artifacts left behind.
 */

const seedMessages: Message[] = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
  { role: "assistant", content: [{ type: "text", text: "hi there" }] },
]

describe("agent state — silent-reset hellgate (audit #2/#14)", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-state-hellgate-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // ── (a) torn/truncated JSON → loud, attributed — NOT a silent reset ──────
  test("torn JSON (real save truncated mid-file) → SessionStateLoadError naming the file; corrupt bytes left untouched", async () => {
    const path = join(dir, "torn.json")
    await saveSession(path, {
      sessionId: "torn-victim",
      messages: seedMessages,
      reason: "completed",
      turns: 2,
    })
    // Simulate the crash artifact the old truncate-then-copy path could leave:
    // the file holds only the FIRST HALF of the JSON payload.
    const whole = readFileSync(path, "utf8")
    const torn = whole.slice(0, Math.floor(whole.length / 2))
    writeFileSync(path, torn)

    let thrown: unknown
    try {
      await loadSession(path)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SessionStateLoadError)
    // Attribution: the error must NAME the file so the operator knows which
    // transcript refused to load (vs a generic parse error).
    expect((thrown as Error).message).toContain(path)
    // Loud ≠ destructive: the loader must not "heal" by resetting — fresh
    // readback shows the torn bytes exactly as they were.
    expect(readFileSync(path, "utf8")).toBe(torn)
  })

  test("empty file (zero-byte torn artifact) → typed rejection, not silent fresh start", async () => {
    const path = join(dir, "empty.json")
    writeFileSync(path, "")
    await expect(loadSession(path)).rejects.toBeInstanceOf(SessionStateLoadError)
  })

  test("missing file is the ONLY silent-null path (legitimate fresh conversation)", async () => {
    expect(await loadSession(join(dir, "never-written.json"))).toBeNull()
  })

  // ── (b) valid JSON, wrong-shape message elements → typed S19 rejection ───
  test("valid envelope + invalid message element → SessionStateLoadError with firstInvalidIndex (no silent cast-through)", async () => {
    const path = join(dir, "bad-element.json")
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        sessionId: "forged",
        reason: "completed",
        turns: 1,
        messages: [
          { role: "user", content: [{ type: "text", text: "ok" }] },
          // Element 1 is valid JSON but NOT a Message: bogus role, content
          // is a bare string instead of a ContentBlock[].
          { role: "alien", content: "not-blocks" },
        ],
      }),
    )
    let thrown: unknown
    try {
      await loadSession(path)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SessionStateLoadError)
    const err = thrown as SessionStateLoadError
    expect(err.firstInvalidIndex).toBe(1)
    expect(err.message).toContain(path)
    expect(err.message).toContain("1")
  })

  test("envelope-shape mismatch (messages not an array) → typed rejection", async () => {
    const path = join(dir, "bad-envelope.json")
    writeFileSync(path, JSON.stringify({ sessionId: "x", messages: { not: "an array" } }))
    await expect(loadSession(path)).rejects.toBeInstanceOf(SessionStateLoadError)
  })

  // Paired control: the SAME validator must keep accepting a genuinely valid
  // file (guards against an over-strict schema that refuses real saves).
  test("paired control: a real saveSession round-trip still loads (validator is not over-strict)", async () => {
    const path = join(dir, "good.json")
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "echo", input: { x: 1 } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }],
      },
    ]
    await saveSession(path, { sessionId: "good", messages, reason: "completed", turns: 1 })
    const loaded = await loadSession(path)
    expect(loaded?.sessionId).toBe("good")
    expect(loaded?.messages).toEqual(messages)
  })

  // ── (c) atomic shape: same-dir temp + rename, observed via the sync seam ─
  test("save stages its temp in the SAME directory as the target (rename is same-fs atomic), temp is gone after commit", async () => {
    const path = join(dir, "atomic.json")
    const syncedFiles: string[] = []
    const spy: AtomicWriteSync = {
      syncFile: async (p) => {
        syncedFiles.push(p)
      },
      syncDir: async () => {},
    }
    await saveSession(
      path,
      { sessionId: "atomic", messages: seedMessages, reason: "completed", turns: 2 },
      spy,
    )
    // The durability barrier ran on a temp file staged NEXT TO the target —
    // proof the commit is a same-filesystem rename, not a copy.
    expect(syncedFiles.length).toBe(1)
    const temp = syncedFiles[0] ?? ""
    expect(temp).not.toBe(path)
    expect(dirname(temp)).toBe(dirname(path))
    // The temp was consumed by the rename — nothing left behind.
    expect(readdirSync(dir)).toEqual(["atomic.json"])
    // Fresh readback: the committed file is the complete new payload.
    const loaded = await loadSession(path)
    expect(loaded?.sessionId).toBe("atomic")
  })

  test("simulated crash point (fsync fails before rename) → save REJECTS loudly and the OLD payload survives byte-identical", async () => {
    const path = join(dir, "crash.json")
    await saveSession(path, {
      sessionId: "old-transcript",
      messages: seedMessages,
      reason: "completed",
      turns: 2,
    })
    const before = readFileSync(path, "utf8")

    const failing: AtomicWriteSync = {
      syncFile: async () => {
        throw new Error("EIO: injected crash before rename")
      },
      syncDir: async () => {},
    }
    // Red-on-injection: the OLD code silently fell back to a plain truncating
    // write here — the save "succeeded" and the target was torn-at-crash. The
    // fixed contract: a failed atomic commit PROPAGATES.
    await expect(
      saveSession(
        path,
        { sessionId: "NEW-MUST-NOT-LAND", messages: [], reason: "completed", turns: 3 },
        failing,
      ),
    ).rejects.toThrow("EIO")

    // Fresh readback: target untouched, still the old complete transcript.
    expect(readFileSync(path, "utf8")).toBe(before)
    const reloaded = await loadSession(path)
    expect(reloaded?.sessionId).toBe("old-transcript")
    // No silent-fallback artifacts (no `.tmp` sidecar, no torn target).
    expect(readdirSync(dir)).toEqual(["crash.json"])
  })

  test("mode preservation: an existing 0o600 state file keeps its mode across the atomic rewrite", async () => {
    const path = join(dir, "mode.json")
    await saveSession(path, {
      sessionId: "mode-v1",
      messages: seedMessages,
      reason: "completed",
      turns: 1,
    })
    await chmod(path, 0o600)
    await saveSession(path, {
      sessionId: "mode-v2",
      messages: seedMessages,
      reason: "completed",
      turns: 2,
    })
    const mode = (await stat(path)).mode & 0o777
    expect(mode).toBe(0o600)
    const loaded = await loadSession(path)
    expect(loaded?.sessionId).toBe("mode-v2")
  })
})
