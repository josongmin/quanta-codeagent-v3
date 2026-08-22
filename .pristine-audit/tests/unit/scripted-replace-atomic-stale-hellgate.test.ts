/**
 * HELLGATE — scripted_replace atomic-commit + stale-guard integrity (T-403 /
 * jun-10 silent-failure audit finding #1).
 *
 * BEFORE: the default-ON `scripted_replace` BASE tool committed user source
 * files via a plain truncating `@/storage` writeFile — NO `writeFileAtomic`
 * (a crash mid-write left a torn/zero-length file under the FINAL name) and
 * NO `guardWrite` stale check (a file externally modified between the model's
 * read and the write was silently clobbered). All three sibling mutation tools
 * (edit / write / apply_patch) already had both.
 * AFTER: the commit routes through the SAME FileSystemPort seam the siblings
 * use — `writeFileAtomic` (temp+fsync+rename, mode-preserving) — and a
 * pre-commit `guardWrite` deny yields the typed `stale_read` ToolResult
 * (NO-THROW contract; never a partial write).
 *
 * RED-ON-INJECTION:
 *  A. crash injected at the durability barrier (syncFile rejects, the rename
 *     never runs) ⇒ the original file is BYTE-UNTOUCHED and non-truncated, no
 *     temp residue. Re-routing the commit to a plain truncating writeFile
 *     turns this RED (the injected crash cannot fire and B goes RED first).
 *  B. seam wiring proof — a recording port shows the commit goes through
 *     `writeFileAtomic`, never the truncating `writeFile`. Reverting the
 *     commit path to `fs.writeFile` turns this RED.
 *  C. ordering — a STALE deny happens BEFORE any write attempt: a port whose
 *     write methods throw on contact proves the deny is never a partial write
 *     and surfaces as a typed result, not a throw-out-of-iterator.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultFileSystemPort, type FileSystemPort, writeFileAtomic } from "@/storage"
import type { ToolContext, ToolResult } from "@/tool"
import { makeScriptedReplaceTool } from "@/tool/scripted-replace"
import { ReadFileState } from "@/tool/stale-read-guard"

const root = mkdtempSync(join(tmpdir(), "scripted-replace-hellgate-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ctx = (cwd: string, extra?: Partial<ToolContext>): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
  ...extra,
})

const runWith = async (
  fs: FileSystemPort,
  input: unknown,
  extra?: Partial<ToolContext>,
): Promise<ToolResult> => {
  const tool = makeScriptedReplaceTool(fs)
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx(root, extra))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("[hellgate] scripted_replace crash mid-write cannot truncate the target", () => {
  test("injected crash at the fsync barrier ⇒ original bytes intact, no temp residue", async () => {
    const f = join(root, "crash-target.txt")
    const ORIGINAL = "alpha beta alpha # precious original bytes"
    writeFileSync(f, ORIGINAL)
    // Real ADR-0398 primitive with the durability barrier FAILING — the
    // canonical "power loss between temp write and rename" injection. The
    // rename must never run, so the FINAL name keeps the original bytes.
    const crashyPort: FileSystemPort = {
      ...defaultFileSystemPort,
      writeFileAtomic: (path, content) =>
        writeFileAtomic(path, content, {
          syncFile: () => Promise.reject(new Error("injected crash: power loss before rename")),
          syncDir: async () => undefined,
        }),
    }

    let thrown: unknown
    try {
      await runWith(crashyPort, { file: f, pattern: "alpha", replacement: "GAMMA" })
    } catch (e) {
      thrown = e
    }
    // The injected failure propagates (same posture as edit/write commits)…
    expect(String(thrown)).toContain("injected crash")
    // …and the FINAL name is byte-identical — neither truncated nor torn.
    const after = readFileSync(f, "utf8")
    expect(after).toBe(ORIGINAL)
    expect(statSync(f).size).toBeGreaterThan(0)
    // The aborted temp was cleaned up — nothing survives under the final name.
    const residue = readdirSync(root).filter((n) => n.startsWith("crash-target.txt.quanta-tmp"))
    expect(residue).toEqual([])
  })
})

describe("[hellgate] scripted_replace commit is wired through writeFileAtomic (seam proof)", () => {
  test("successful replace calls the port's writeFileAtomic exactly once; truncating writeFile NEVER", async () => {
    const f = join(root, "seam-target.txt")
    writeFileSync(f, "foo bar foo")
    const atomicCalls: string[] = []
    const plainCalls: string[] = []
    const recordingPort: FileSystemPort = {
      ...defaultFileSystemPort,
      writeFileAtomic: async (path, content, baseDir) => {
        atomicCalls.push(path)
        const real = defaultFileSystemPort.writeFileAtomic
        if (real === undefined) throw new Error("default port lost writeFileAtomic")
        await real(path, content, baseDir)
      },
      writeFile: async (path) => {
        plainCalls.push(path)
        throw new Error("truncating writeFile must not be the scripted_replace commit path")
      },
    }

    const r = await runWith(recordingPort, { file: f, pattern: "foo", replacement: "qux" })

    expect(r.ok).toBe(true)
    expect(atomicCalls).toEqual([f])
    expect(plainCalls).toEqual([])
    // Fresh readback through the REAL filesystem, not the port.
    expect(readFileSync(f, "utf8")).toBe("qux bar qux")
  })
})

describe("[hellgate] stale deny is PRE-commit and typed (never a partial write, never a throw)", () => {
  test("stale target ⇒ typed stale_read result; the port's write methods are never touched", async () => {
    const f = join(root, "stale-precommit.txt")
    writeFileSync(f, "alpha beta")
    const rfs = new ReadFileState()
    // Record a baseline strictly OLDER than the on-disk mtime ⇒ stale.
    rfs.record(f, statSync(f).mtimeMs - 10_000)
    const tripwirePort: FileSystemPort = {
      ...defaultFileSystemPort,
      writeFileAtomic: async () => {
        throw new Error("write attempted on a STALE target")
      },
      writeFile: async () => {
        throw new Error("write attempted on a STALE target")
      },
    }

    const r = await runWith(
      tripwirePort,
      { file: f, pattern: "alpha", replacement: "GAMMA" },
      { readFileState: rfs },
    )

    // Typed result on the NO-THROW path — not a throw out of the iterator.
    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "rejected", reason: "stale_read" })
    // Fresh readback: byte-untouched.
    expect(readFileSync(f, "utf8")).toBe("alpha beta")
  })
})
