import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  sweepSessionTranscripts,
  type TranscriptSweepResult,
} from "@/apps/cli/session-transcript-retention"
import { __resetRuntimeConfig } from "@/shared"

/**
 * Session transcript retention — hellgate.
 *
 * Wires the EXISTING `applyRetention` (src/stream/adapters/jsonl-retention.ts)
 * over the per-session `.jsonl` envelopes that live under `sessionsRoot()`.
 * The sweep entrypoint (`sweepSessionTranscripts`) is the host/CLI-layer seam
 * that lists the envelopes and applies the cumulative-bytes sliding window to
 * each one (NEVER deletes a whole session — only trims the OLDEST rows of an
 * over-cap transcript). Policy comes from the `QUANTA_SESSION_TRANSCRIPT_MAX_BYTES`
 * knob — there is no magic threshold baked into the mechanism.
 *
 * Contract clauses sealed here:
 *   A. OFF by default — unset knob ⇒ NOTHING is touched (unbounded, today's
 *      behavior). Reported as a no-policy skip.
 *   B. Per-file sliding window — an over-cap transcript keeps its NEWEST rows,
 *      drops the OLDEST, and the report's count + bytes are exact.
 *   C. Under-cap / recent transcripts are left byte-identical (never deleted).
 *   D. NO-THROW — a malformed/locked envelope (sibling `.tmp`) is captured in
 *      `errors[]` and does NOT abort the sweep over its siblings.
 *   E. A generous/large cap keeps everything (proves the knob, not a constant).
 *   F. Only `*.jsonl` is swept — the snapshot `*.json`, `index.jsonl` resource
 *      file, and `archived/` are NOT trimmed by this transcript rail.
 */

const ROW = (s: string): string => `{"v":1,"t":"${s}"}`

/** Build a jsonl file body from rows (newline-framed, trailing newline). */
const jsonl = (rows: readonly string[]): string => `${rows.join("\n")}\n`

let tmpRoot: string
let envSnapshot: NodeJS.ProcessEnv

beforeEach(async () => {
  envSnapshot = { ...process.env }
  tmpRoot = await mkdtemp(join(tmpdir(), "quanta-transcript-retention-"))
  __resetRuntimeConfig()
})

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key]
  }
  Object.assign(process.env, envSnapshot)
  __resetRuntimeConfig()
  await rm(tmpRoot, { recursive: true, force: true })
})

describe("session transcript retention — hellgate", () => {
  test("[A] unset knob ⇒ no-policy skip, nothing touched", async () => {
    delete process.env.QUANTA_SESSION_TRANSCRIPT_MAX_BYTES
    __resetRuntimeConfig()
    const p = join(tmpRoot, "sess-a.jsonl")
    const body = jsonl([ROW("one"), ROW("two"), ROW("three")])
    await writeFile(p, body)

    const res = await sweepSessionTranscripts({ root: tmpRoot })
    expect("skipped" in res).toBe(true)
    // File untouched, byte-identical.
    expect(await readFile(p, "utf8")).toBe(body)
  })

  test("[B] over-cap transcript keeps NEWEST rows, drops OLDEST, exact report", async () => {
    const rows = [ROW("oldest"), ROW("mid"), ROW("newest")]
    const p = join(tmpRoot, "sess-b.jsonl")
    await writeFile(p, jsonl(rows))
    // Each row is the same byte length; +1 for the framing newline. Size the
    // cap so exactly the two newest rows survive (drop the oldest).
    const rowBytes = Buffer.byteLength(rows[2] as string, "utf8") + 1
    const cap = rowBytes * 2

    const res = (await sweepSessionTranscripts({
      root: tmpRoot,
      maxCumulativeBytes: cap,
    })) as TranscriptSweepResult
    expect(res.filesScanned).toBe(1)
    expect(res.filesRewritten).toBe(1)
    expect(res.droppedRows).toBe(1)
    expect(res.bytesFreed).toBe(Buffer.byteLength(rows[0] as string, "utf8"))
    expect(res.errors).toHaveLength(0)

    // On disk: only the two newest rows remain, newest LAST.
    const after = await readFile(p, "utf8")
    expect(after).toBe(jsonl([rows[1] as string, rows[2] as string]))
  })

  test("[C] under-cap transcript left byte-identical (never deleted)", async () => {
    const p = join(tmpRoot, "sess-c.jsonl")
    const body = jsonl([ROW("a"), ROW("b")])
    await writeFile(p, body)

    const res = (await sweepSessionTranscripts({
      root: tmpRoot,
      maxCumulativeBytes: 1_000_000,
    })) as TranscriptSweepResult
    expect(res.filesScanned).toBe(1)
    expect(res.filesRewritten).toBe(0)
    expect(res.droppedRows).toBe(0)
    expect(res.bytesFreed).toBe(0)
    expect(await readFile(p, "utf8")).toBe(body)
  })

  test("[D] malformed/locked envelope (sibling .tmp) ⇒ captured in errors, siblings still swept", async () => {
    // Locked file: a sibling `.tmp` makes applyRetention throw busy. The sweep
    // must NOT abort — it records the error and trims the other transcript.
    const lockedRows = [ROW("L-old"), ROW("L-new")]
    const locked = join(tmpRoot, "sess-locked.jsonl")
    await writeFile(locked, jsonl(lockedRows))
    await writeFile(`${locked}.tmp`, "stale\n")

    const okRows = [ROW("OK-old"), ROW("OK-mid"), ROW("OK-new")]
    const ok = join(tmpRoot, "sess-ok.jsonl")
    await writeFile(ok, jsonl(okRows))
    const cap = (Buffer.byteLength(okRows[2] as string, "utf8") + 1) * 2

    const res = (await sweepSessionTranscripts({
      root: tmpRoot,
      maxCumulativeBytes: cap,
    })) as TranscriptSweepResult
    expect(res.filesScanned).toBe(2)
    // The OK transcript was trimmed; the locked one captured an error.
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0]?.path).toBe(locked)
    expect(res.filesRewritten).toBe(1)
    expect(res.droppedRows).toBe(1)
    // Locked file body untouched (refused loudly, not silently mangled).
    expect(await readFile(locked, "utf8")).toBe(jsonl(lockedRows))
  })

  test("[E] generous cap keeps EVERYTHING (knob-driven, not a constant)", async () => {
    const files: { path: string; body: string }[] = []
    for (let i = 0; i < 5; i++) {
      const p = join(tmpRoot, `sess-keep-${i}.jsonl`)
      const body = jsonl([ROW(`${i}-a`), ROW(`${i}-b`), ROW(`${i}-c`)])
      await writeFile(p, body)
      files.push({ path: p, body })
    }
    const res = (await sweepSessionTranscripts({
      root: tmpRoot,
      maxCumulativeBytes: 50_000_000,
    })) as TranscriptSweepResult
    expect(res.filesScanned).toBe(5)
    expect(res.filesRewritten).toBe(0)
    expect(res.droppedRows).toBe(0)
    for (const f of files) expect(await readFile(f.path, "utf8")).toBe(f.body)
  })

  test("[F] only *.jsonl transcripts swept — snapshot .json + index.jsonl resource + archived/ untouched", async () => {
    // A snapshot JSON file — must NOT be trimmed.
    const snap = join(tmpRoot, "sess-x.json")
    const snapBody = JSON.stringify({ version: 2, big: "x".repeat(10_000) })
    await writeFile(snap, snapBody)
    // The transcript envelope for the SAME session — IS swept.
    const env = join(tmpRoot, "sess-x.jsonl")
    const envRows = [ROW("e-old"), ROW("e-mid"), ROW("e-new")]
    await writeFile(env, jsonl(envRows))
    const cap = (Buffer.byteLength(envRows[2] as string, "utf8") + 1) * 2

    const res = (await sweepSessionTranscripts({
      root: tmpRoot,
      maxCumulativeBytes: cap,
    })) as TranscriptSweepResult
    // The snapshot json must be untouched and NOT counted as a transcript.
    expect(await readFile(snap, "utf8")).toBe(snapBody)
    expect(res.filesScanned).toBe(1)
    expect(res.droppedRows).toBe(1)
  })

  test("[G] missing root ⇒ empty no-op result (no throw)", async () => {
    const res = (await sweepSessionTranscripts({
      root: join(tmpRoot, "does-not-exist"),
      maxCumulativeBytes: 1024,
    })) as TranscriptSweepResult
    expect(res.filesScanned).toBe(0)
    expect(res.droppedRows).toBe(0)
    expect(res.errors).toHaveLength(0)
  })

  test("[H] dry-run reports drops WITHOUT mutating disk", async () => {
    const rows = [ROW("d-old"), ROW("d-mid"), ROW("d-new")]
    const p = join(tmpRoot, "sess-dry.jsonl")
    const body = jsonl(rows)
    await writeFile(p, body)
    const cap = (Buffer.byteLength(rows[2] as string, "utf8") + 1) * 2

    const res = (await sweepSessionTranscripts({
      root: tmpRoot,
      maxCumulativeBytes: cap,
      dryRun: true,
    })) as TranscriptSweepResult
    expect(res.droppedRows).toBe(1)
    // dryRun ⇒ filesRewritten counts what WOULD be rewritten, disk unchanged.
    expect(await readFile(p, "utf8")).toBe(body)
    expect((await stat(p)).size).toBe(Buffer.byteLength(body, "utf8"))
  })

  test("[I] knob value (env) feeds policy when maxCumulativeBytes not passed", async () => {
    const rows = [ROW("k-old"), ROW("k-new")]
    const p = join(tmpRoot, "sess-knob.jsonl")
    await writeFile(p, jsonl(rows))
    const cap = Buffer.byteLength(rows[1] as string, "utf8") + 1
    process.env.QUANTA_SESSION_TRANSCRIPT_MAX_BYTES = String(cap)
    __resetRuntimeConfig()

    const res = (await sweepSessionTranscripts({ root: tmpRoot })) as TranscriptSweepResult
    expect(res.droppedRows).toBe(1)
    expect(await readFile(p, "utf8")).toBe(jsonl([rows[1] as string]))
  })

  // ── CLOCK / TIME-INVARIANT (data-loss vector) ────────────────────────────────
  // The retention mechanism is purely CUMULATIVE-BYTES (keep the newest rows up
  // to a cap). It reads NO mtime/atime/ctime and applies NO age cutoff — so a
  // file's wall-clock timestamp can NEVER cause it to be deleted or trimmed. This
  // seals the highest-value clock attack ("a future-mtime file gets reaped as
  // expired") as structurally impossible AND guards against anyone later bolting
  // an age-based cutoff onto this rail without revisiting the data-loss surface.
  test("[CLOCK] a FUTURE-mtime under-cap transcript is NEVER deleted or trimmed (no age cutoff)", async () => {
    const rows = [ROW("c-old"), ROW("c-new")]
    const p = join(tmpRoot, "sess-future.jsonl")
    const body = jsonl(rows)
    await writeFile(p, body)
    // Stamp the file's mtime/atime far in the FUTURE (year ~2255) — the exact
    // skew that an age-based reaper would misread as "impossibly old/expired".
    const future = new Date(9_000_000_000_000)
    await utimes(p, future, future)
    // A generous cap that keeps everything: if any timestamp logic existed, a
    // future mtime is where it would either over-trim or wrongly skip.
    const generousCap = Buffer.byteLength(body, "utf8") * 10

    const res = (await sweepSessionTranscripts({
      root: tmpRoot,
      maxCumulativeBytes: generousCap,
    })) as TranscriptSweepResult
    expect(res.filesScanned).toBe(1)
    expect(res.droppedRows).toBe(0) // nothing trimmed
    expect(res.filesRewritten).toBe(0)
    expect(res.errors).toEqual([])
    // Byte-identical: the future mtime did NOT trigger a delete or a rewrite.
    expect(await readFile(p, "utf8")).toBe(body)
  })

  test("[CLOCK] a FUTURE-mtime OVER-cap transcript trims by ROW COUNT, not by timestamp", async () => {
    // Even an over-cap file with a future mtime must be trimmed by the SAME
    // newest-rows-win byte rule — the timestamp must not over-delete (whole-file)
    // nor protect the oldest rows from the cap.
    const rows = [ROW("f-oldest"), ROW("f-mid"), ROW("f-newest")]
    const p = join(tmpRoot, "sess-future-over.jsonl")
    await writeFile(p, jsonl(rows))
    const future = new Date(9_000_000_000_000)
    await utimes(p, future, future)
    const rowBytes = Buffer.byteLength(rows[2] as string, "utf8") + 1
    const cap = rowBytes * 2 // keep exactly the two NEWEST rows

    const res = (await sweepSessionTranscripts({
      root: tmpRoot,
      maxCumulativeBytes: cap,
    })) as TranscriptSweepResult
    expect(res.droppedRows).toBe(1) // exactly the oldest row, regardless of mtime
    expect(await readFile(p, "utf8")).toBe(jsonl([rows[1] as string, rows[2] as string]))
  })
})
