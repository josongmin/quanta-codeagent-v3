/**
 * ROUND-4 concurrency hellgate — pty tmux-adapter `lastCapture` state machine.
 *
 * The `read(handle)` critical section is:
 *     const r = await exec.run(["capture-pane", ...])   // ← AWAIT (yields)
 *     const { chunk, seq } = diffCapture(lastCapture.get(handle), r.stdout)
 *     lastCapture.set(handle, { text: r.stdout, seq })
 *
 * Two concurrent `read`s both await capture-pane. Captures can RESOLVE OUT OF
 * ORDER (a slow capture started earlier can land after a fast capture started
 * later) OR return STALE text (the pane shrank/scrolled between the two
 * captures). When the LAST-to-resolve read carries an OLDER pane than the one
 * already stored, the naive code:
 *   - sets `lastCapture.text` BACKWARD to the older snapshot, and
 *   - re-emits the whole older text as a "fresh" chunk (a duplicate the caller
 *     already consumed), and
 *   - the NEXT read then re-diffs against the rewound text and re-emits the
 *     tail AGAIN.
 * => CORRUPT STATE + DOUBLE-EMIT.
 *
 * We drive the interleaving with a deferred-resolution exec so read-B observes
 * read-A's already-committed `lastCapture`, then assert the post-state is
 * monotone (seq never goes backward, text never rewinds, no chunk re-emitted).
 */

import { describe, expect, test } from "bun:test"
import { createTmuxAdapter, type PtySessionPort, type TmuxExec } from "@/tool/pty"

/** A controllable exec: each `capture-pane` call parks on a deferred the test
 *  resolves by hand, so we choose the exact interleaving. Non-capture calls
 *  (has-session, etc.) answer synchronously. */
const mkDeferredExec = () => {
  type Pending = { resolve: (stdout: string) => void }
  const captures: Pending[] = []
  const exec: TmuxExec = {
    run: async (args) => {
      if (args[0] === "capture-pane") {
        return new Promise<{ ok: boolean; stdout: string }>((res) => {
          captures.push({ resolve: (stdout) => res({ ok: true, stdout }) })
        })
      }
      return { ok: true, stdout: "" }
    },
  }
  return { exec, captures }
}

const adapterOf = (exec: TmuxExec): PtySessionPort =>
  createTmuxAdapter({ exec, allowForeign: true })

describe("ROUND-4 pty diffCapture — concurrent read interleaving", () => {
  test("late-resolving read with an OLDER pane must NOT rewind seq/text or re-emit", async () => {
    const { exec, captures } = mkDeferredExec()
    const adapter = adapterOf(exec)
    const h = "tmux:quanta-race"

    // First, an uncontested read establishes a baseline. We resolve its capture
    // immediately so subsequent reads diff against a known prev. (No trailing
    // newline mid-string, so a grown pane is a clean prefix-extension and the
    // diff emits ONLY the appended tail — isolating the race from the unrelated
    // line-buffer diff fallback.)
    const r0p = adapter.read(h, 0)
    // wait a microtask for the capture to be enqueued
    await Promise.resolve()
    captures[0]?.resolve("abc")
    const r0 = await r0p
    expect(r0.ok).toBe(true)
    if (r0.ok) {
      expect(r0.value.chunks.map((c) => c.data).join("")).toBe("abc")
      expect(r0.value.nextSeq).toBe(1)
    }

    // Now two concurrent reads. Read-A's capture sees the GROWN pane "abcXYZ";
    // Read-B's capture (started concurrently, slow) sees the OLDER pane "abc".
    const rAp = adapter.read(h, 0)
    const rBp = adapter.read(h, 0)
    await Promise.resolve()
    // captures[1] = A, captures[2] = B (enqueue order). Resolve A first (newer),
    // then B last (older) — B is the late writer carrying stale text.
    captures[1]?.resolve("abcXYZ")
    const rA = await rAp
    captures[2]?.resolve("abc")
    const rB = await rBp

    expect(rA.ok && rB.ok).toBe(true)
    if (!rA.ok || !rB.ok) return

    // A advanced to seq 2 emitting the tail "XYZ".
    expect(rA.value.nextSeq).toBe(2)
    expect(rA.value.chunks.map((c) => c.data).join("")).toBe("XYZ")

    // B carried OLDER text. It must NOT corrupt the stored state. The invariant:
    // after both complete, a follow-up read against the TRUE-latest pane must
    // produce a correct forward diff, never re-emitting already-seen output.
    //
    // Drive a 3rd read seeing the same true-latest pane "abcXYZ": since the
    // caller already consumed "abcXYZ", there must be NO new chunk.
    const rCp = adapter.read(h, rA.value.nextSeq)
    await Promise.resolve()
    captures[3]?.resolve("abcXYZ")
    const rC = await rCp
    expect(rC.ok).toBe(true)
    if (rC.ok) {
      // BUG (pre-fix): B rewound lastCapture to {text:"abc", seq:3}, so read-C
      // diffs "abcXYZ" vs "abc" and RE-EMITS "XYZ" (a duplicate) at seq 4.
      // Correct: no rewind ⇒ read-C sees no change ⇒ no chunk.
      expect(rC.value.chunks.length).toBe(0)
    }
  })

  test("seq is monotone non-decreasing across an out-of-order capture pair", async () => {
    const { exec, captures } = mkDeferredExec()
    const adapter = adapterOf(exec)
    const h = "tmux:quanta-mono"

    // baseline
    const r0p = adapter.read(h, 0)
    await Promise.resolve()
    captures[0]?.resolve("a")
    await r0p

    const rAp = adapter.read(h, 0)
    const rBp = adapter.read(h, 0)
    await Promise.resolve()
    captures[1]?.resolve("ab") // A newer
    const rA = await rAp
    captures[2]?.resolve("a") // B stale/older
    const rB = await rBp

    if (rA.ok && rB.ok) {
      // The stored seq after the whole episode must be >= the max emitted seq,
      // and a subsequent read must not observe a seq earlier than rA's.
      const rNp = adapter.read(h, 0)
      await Promise.resolve()
      captures[3]?.resolve("ab")
      const rN = await rNp
      if (rN.ok) {
        // post-state seq must be monotone: never below A's advanced seq (2).
        expect(rN.value.nextSeq).toBeGreaterThanOrEqual(rA.value.nextSeq)
      }
    }
  })
})
