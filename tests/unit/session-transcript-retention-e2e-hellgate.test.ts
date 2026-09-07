import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sessionRegistryCmd } from "@/apps/cli/session-registry-cmd"
import type { SlashContext } from "@/apps/cli/slash-contract"
import { __resetRuntimeConfig } from "@/shared"

/**
 * Session transcript retention — e2e hellgate.
 *
 * Drives the ACTUAL `/session-registry cleanup --transcripts` slash handler
 * (`sessionRegistryCmd.run`) against a planted `QUANTA_SESSIONS_DIR` so the
 * full wiring — runtime-config knob → `sweepSessionTranscripts` →
 * `sessionsRoot()` → `applyRetention` → operator-facing report — is exercised
 * end-to-end. This complements the unit hellgate (which targets the sweep
 * entrypoint directly) by proving the CLI seam + the knob resolution.
 *
 * Clauses:
 *   1. Default path (knob unset) ⇒ "retention OFF" notice, recent transcripts
 *      left intact (byte-identical).
 *   2. Knob ON ⇒ over-cap envelope trimmed; report shows scanned/trimmed/rows/
 *      bytes; the registry-cleanup no-backend result is still present
 *      (additive rail, without falsely claiming a durable sweep).
 *   3. `--dry-run --transcripts` ⇒ "would trim" preview, disk unchanged.
 *   4. Plain `cleanup` (no `--transcripts`) ⇒ transcripts NOT swept (opt-in),
 *      even when the knob is set.
 *   5. NO-THROW: a locked envelope (sibling `.tmp`) does not crash the command.
 */

const ROW = (s: string): string => `{"v":1,"t":"${s}"}`
const jsonl = (rows: readonly string[]): string => `${rows.join("\n")}\n`

interface CapturedCtx extends SlashContext {
  readonly outBuf: string[]
  readonly errBuf: string[]
}

const makeCtx = (): CapturedCtx => {
  const outBuf: string[] = []
  const errBuf: string[] = []
  return {
    outBuf,
    errBuf,
    out: (s: string) => {
      outBuf.push(s)
    },
    err: (s: string) => {
      errBuf.push(s)
    },
    cwd: process.cwd(),
  }
}

let tmpRoot: string
let envSnapshot: NodeJS.ProcessEnv

beforeEach(async () => {
  envSnapshot = { ...process.env }
  tmpRoot = await mkdtemp(join(tmpdir(), "quanta-transcript-e2e-"))
  // Point the live session root at our tmp dir + clear any backend registry
  // env so the resource-registry sweep is a fast in-memory no-op.
  process.env.QUANTA_SESSIONS_DIR = tmpRoot
  delete process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  delete process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
  delete process.env.QUANTA_SESSION_TRANSCRIPT_MAX_BYTES
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

describe("session transcript retention — e2e hellgate", () => {
  test("[1] default (knob unset) ⇒ OFF notice, transcript untouched", async () => {
    const p = join(tmpRoot, "sess-1.jsonl")
    const body = jsonl([ROW("a"), ROW("b"), ROW("c")])
    await writeFile(p, body)

    const ctx = makeCtx()
    const code = await sessionRegistryCmd.run(["cleanup", "--transcripts"], ctx)
    expect(code).toBe(0)
    const out = ctx.outBuf.join("")
    expect(out).toContain("retention OFF")
    // Recent transcript intact.
    expect(await readFile(p, "utf8")).toBe(body)
  })

  test("[2] knob ON ⇒ over-cap envelope trimmed + report; registry output still present", async () => {
    const rows = [ROW("old"), ROW("mid"), ROW("new")]
    const p = join(tmpRoot, "sess-2.jsonl")
    await writeFile(p, jsonl(rows))
    const cap = (Buffer.byteLength(rows[2] as string, "utf8") + 1) * 2
    process.env.QUANTA_SESSION_TRANSCRIPT_MAX_BYTES = String(cap)
    __resetRuntimeConfig()

    const ctx = makeCtx()
    const code = await sessionRegistryCmd.run(["cleanup", "--transcripts"], ctx)
    expect(code).toBe(0)
    const out = ctx.outBuf.join("")
    // Transcript report present.
    expect(out).toContain("Transcripts:")
    expect(out).toContain("rows dropped:        1")
    // Additive: the resource-registry result is still emitted, and an
    // in-memory/no-backend run must not falsely claim a durable sweep.
    expect(out).toContain("No durable backend configured — nothing swept.")
    expect(out).not.toContain("Sweep complete.")
    // On disk: oldest row trimmed, newest two kept.
    expect(await readFile(p, "utf8")).toBe(jsonl([rows[1] as string, rows[2] as string]))
  })

  test("[3] --dry-run --transcripts ⇒ preview, disk unchanged", async () => {
    const rows = [ROW("d-old"), ROW("d-mid"), ROW("d-new")]
    const p = join(tmpRoot, "sess-3.jsonl")
    const body = jsonl(rows)
    await writeFile(p, body)
    const cap = (Buffer.byteLength(rows[2] as string, "utf8") + 1) * 2
    process.env.QUANTA_SESSION_TRANSCRIPT_MAX_BYTES = String(cap)
    __resetRuntimeConfig()

    const ctx = makeCtx()
    const code = await sessionRegistryCmd.run(["cleanup", "--dry-run", "--transcripts"], ctx)
    expect(code).toBe(0)
    const out = ctx.outBuf.join("")
    expect(out).toContain("would trim")
    expect(out).toContain("rows dropped:        1")
    // Disk unchanged — dry-run.
    expect(await readFile(p, "utf8")).toBe(body)
  })

  test("[4] plain cleanup (no --transcripts) ⇒ transcripts NOT swept even with knob set", async () => {
    const rows = [ROW("p-old"), ROW("p-mid"), ROW("p-new")]
    const p = join(tmpRoot, "sess-4.jsonl")
    const body = jsonl(rows)
    await writeFile(p, body)
    process.env.QUANTA_SESSION_TRANSCRIPT_MAX_BYTES = String(
      Buffer.byteLength(rows[2] as string, "utf8") + 1,
    )
    __resetRuntimeConfig()

    const ctx = makeCtx()
    const code = await sessionRegistryCmd.run(["cleanup"], ctx)
    expect(code).toBe(0)
    const out = ctx.outBuf.join("")
    // No transcript block; the transcript rail is OPT-IN.
    expect(out).not.toContain("Transcripts")
    // Transcript untouched.
    expect(await readFile(p, "utf8")).toBe(body)
  })

  test("[5] NO-THROW: a locked envelope (sibling .tmp) does not crash the command", async () => {
    const rows = [ROW("L-old"), ROW("L-new")]
    const p = join(tmpRoot, "sess-5.jsonl")
    await writeFile(p, jsonl(rows))
    await writeFile(`${p}.tmp`, "stale\n")
    process.env.QUANTA_SESSION_TRANSCRIPT_MAX_BYTES = String(
      Buffer.byteLength(rows[1] as string, "utf8") + 1,
    )
    __resetRuntimeConfig()

    const ctx = makeCtx()
    const code = await sessionRegistryCmd.run(["cleanup", "--transcripts"], ctx)
    // Command still exits 0 — per-file error is captured, not thrown.
    expect(code).toBe(0)
    const out = ctx.outBuf.join("")
    expect(out).toContain("skipped (errors):    1")
    // Locked file untouched.
    expect(await readFile(p, "utf8")).toBe(jsonl(rows))
  })
})
