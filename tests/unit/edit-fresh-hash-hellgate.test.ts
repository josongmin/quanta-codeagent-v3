/** jul-13 hellgate — edit-fresh-hash (self-inflicted-staleness root fix).
 *
 *  MEASURED root cause (bench trajectory dedup, django__django-14315 ×2 runs):
 *  ~41% of edits (7 distinct events / 17 edits) hit `stale_precondition`, ALL from
 *  the model's OWN prior edit to the same file (e.g. postgresql/client.py failed 4×
 *  with 4 different current-hashes). `not_found` was 0. A successful edit changes
 *  the file, so the model's read-time `expected_hash` is instantly stale for the
 *  next same-file edit, forcing a full re-read purely to re-hash.
 *
 *  Fix (gated `QUANTA_EDIT_FRESH_HASH`, ctx.editFreshHash): a successful edit
 *  appends the sha256 of the POST-edit bytes so the model chains the next edit's
 *  `expected_hash` WITHOUT a re-read.
 *
 *  Adversarial invariants pinned here:
 *    1. OFF (flag absent) ⇒ success output BYTE-IDENTICAL to legacy (no hash line).
 *    2. ON ⇒ output carries `fresh sha256: <hex>` = digest of the POST-edit bytes
 *       (NOT the pre-edit bytes — red-on-injection catches hashing `before`).
 *    3. The advertised hash equals sha256 of the actual on-disk bytes after commit.
 *    4. E2E ROOT-FIX: feeding the advertised hash as the next same-file edit's
 *       `expected_hash` SUCCEEDS (no stale_precondition) — the re-read is gone.
 *    5. PAIRED CONTROL: without the fix, reusing the model's read-time (pre-edit)
 *       hash for the second edit fails `stale_precondition` — proves the bug is
 *       real and the fix (not the test) is what cures it. */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FileInfo, FileSystemPort } from "@/storage"
import { sha256Hex } from "@/storage"
import type { ToolContext, ToolResult } from "@/tool"
import { makeEditTool } from "@/tool/edit"

const makeFullPort = (seed: Record<string, string>) => {
  const files = new Map<string, string>(Object.entries(seed))
  const port: FileSystemPort = {
    async readFile(path: string): Promise<string> {
      const v = files.get(path)
      if (v === undefined) throw new Error(`File not found: ${path}`)
      return v
    },
    async writeFile(path: string, content: string): Promise<void> {
      files.set(path, content)
    },
    async statFile(path: string): Promise<FileInfo> {
      return {
        path,
        size: files.get(path)?.length ?? 0,
        isDirectory: false,
        mtimeMs: 0,
        isFIFO: false,
        isCharacterDevice: false,
        isBlockDevice: false,
      }
    },
    async fileExists(path: string): Promise<boolean> {
      return files.has(path)
    },
    async writeFileAtomic(path: string, content: string): Promise<void> {
      files.set(path, content)
    },
  }
  return { port, files }
}

const ctx = (cwd: string, freshHash: boolean): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
  ...(freshHash ? { editFreshHash: true } : {}),
})

const run = async (
  tool: ReturnType<typeof makeEditTool>,
  input: unknown,
  cwd: string,
  freshHash: boolean,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx(cwd, freshHash))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

const FRESH_RE = /fresh sha256: ([0-9a-f]{64})/

describe("jul-13 edit-fresh-hash", () => {
  test("1. OFF (flag absent) ⇒ success output byte-identical (no fresh-hash line)", async () => {
    const path = "/in-mem/off.txt"
    const { port } = makeFullPort({ [path]: "const a = 1" })
    const r = await run(
      makeEditTool(port),
      { path, old_string: "1", new_string: "2" },
      "/in-mem",
      false,
    )
    expect(r.ok).toBe(true)
    // Legacy line exactly — no appended hash. Removing the `ctx.editFreshHash` gate
    // (always append) turns this RED.
    expect(r.output).toBe(`${path}: Replaced 1 occurrence(s)`)
    expect(r.output).not.toContain("fresh sha256")
  })

  test("2+3. ON ⇒ advertises sha256 of the POST-edit bytes (not pre-edit)", async () => {
    const path = "/in-mem/on.txt"
    const before = "const a = 1"
    const after = "const a = 2"
    const { port, files } = makeFullPort({ [path]: before })
    const r = await run(
      makeEditTool(port),
      { path, old_string: "1", new_string: "2" },
      "/in-mem",
      true,
    )
    expect(r.ok).toBe(true)
    const m = r.output?.match(FRESH_RE)
    expect(m).not.toBeNull()
    const advertised = m?.[1]
    // Digest is over the POST-edit bytes...
    expect(advertised).toBe(sha256Hex(after))
    // ...and matches what actually landed on disk (invariant 3).
    expect(advertised).toBe(sha256Hex(files.get(path) ?? ""))
    // red-on-injection: hashing `before` instead of `next` would be caught.
    expect(advertised).not.toBe(sha256Hex(before))
  })

  test("4. E2E root-fix: the advertised hash unlocks a chained same-file edit (no stale_precondition)", async () => {
    const path = "/in-mem/chain.txt"
    const { port, files } = makeFullPort({ [path]: "let x = 1\nlet y = 1" })
    const tool = makeEditTool(port)

    // Edit #1 — model reads once, edits, and is HANDED the fresh hash.
    const r1 = await run(tool, { path, old_string: "x = 1", new_string: "x = 2" }, "/in-mem", true)
    expect(r1.ok).toBe(true)
    const freshHash = r1.output?.match(FRESH_RE)?.[1]
    expect(freshHash).toBeDefined()

    // Edit #2 — same file, WITHOUT a re-read, supplying the advertised hash as the
    // precondition. This is the exact sequence that produced ~41% stale in the
    // trajectory; with the fix it MUST pass.
    const r2 = await run(
      tool,
      { path, old_string: "y = 1", new_string: "y = 2", expected_hash: freshHash },
      "/in-mem",
      true,
    )
    expect(r2.ok).toBe(true)
    expect(r2.failure).toBeUndefined()
    expect(files.get(path)).toBe("let x = 2\nlet y = 2")
  })

  test("5. PAIRED CONTROL: reusing the pre-edit (read-time) hash DOES go stale — proves the bug the fix cures", async () => {
    const path = "/in-mem/control.txt"
    const original = "let x = 1\nlet y = 1"
    const { port, files } = makeFullPort({ [path]: original })
    const tool = makeEditTool(port)
    // The hash the model computed at READ time (before any edit).
    const readTimeHash = sha256Hex(original)

    // Edit #1 succeeds and mutates the file (fresh-hash off here — we model the
    // legacy world where the model only has its read-time hash).
    const r1 = await run(tool, { path, old_string: "x = 1", new_string: "x = 2" }, "/in-mem", false)
    expect(r1.ok).toBe(true)

    // Edit #2 reuses the now-STALE read-time hash → precondition must reject.
    const r2 = await run(
      tool,
      { path, old_string: "y = 1", new_string: "y = 2", expected_hash: readTimeHash },
      "/in-mem",
      false,
    )
    expect(r2.ok).toBe(false)
    expect(r2.failure?.mode).toBe("stale_precondition")
    // File is untouched by the rejected second edit (only edit #1 landed).
    expect(files.get(path)).toBe("let x = 2\nlet y = 1")
  })
})

/** hell-audit follow-up: the in-memory port above is READ==WRITE identity, so it
 *  CANNOT prove the advertised hash (computed over `planned.next` in memory)
 *  matches the bytes the precondition will re-hash off DISK. If the FS round-trip
 *  normalized anything (EOL / trailing newline / multibyte / BOM), the advertised
 *  hash would be a lie and the chained edit would go stale anyway. These run the
 *  DEFAULT port against a real tmp file with adversarial byte shapes. */
describe("jul-13 edit-fresh-hash — REAL FS round-trip fidelity", () => {
  const dir = mkdtempSync(join(tmpdir(), "edit-fresh-hash-fs-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const runFs = async (input: unknown): Promise<ToolResult> => {
    let result: ToolResult | undefined
    for await (const ev of makeEditTool().execute(input as never, ctx(dir, true))) {
      if (ev.type === "result") result = ev.result
    }
    if (!result) throw new Error("no result")
    return result
  }

  test("advertised hash == sha256 of the ACTUAL on-disk bytes (CRLF + no trailing newline + multibyte)", async () => {
    // Adversarial content: CRLF terminators, NO final newline, non-ASCII bytes —
    // every shape an EOL/encoding normalizer could silently rewrite.
    const path = join(dir, "roundtrip.txt")
    writeFileSync(path, "let 한 = 1\r\nlet 글 = 1", "utf8") // no trailing newline
    const r = await runFs({ path, old_string: "한 = 1", new_string: "한 = 2" })
    expect(r.ok).toBe(true)
    const advertised = r.output?.match(FRESH_RE)?.[1]
    expect(advertised).toBeDefined()
    // The load-bearing invariant: the hash we handed the model equals what its
    // NEXT precondition will compute by reading the file off disk. Byte-read of
    // the real file, hashed the same way the tool hashes it.
    const onDisk = readFileSync(path, "utf8")
    expect(advertised).toBe(sha256Hex(onDisk))
  })

  test("chained edit with the advertised hash succeeds against the REAL fs (no stale)", async () => {
    const path = join(dir, "chain-fs.txt")
    writeFileSync(path, "a = 1\r\nb = 1", "utf8")
    const r1 = await runFs({ path, old_string: "a = 1", new_string: "a = 2" })
    expect(r1.ok).toBe(true)
    const freshHash = r1.output?.match(FRESH_RE)?.[1]
    // Second edit, no re-read, precondition = advertised hash → MUST pass on disk.
    const r2 = await runFs({
      path,
      old_string: "b = 1",
      new_string: "b = 2",
      expected_hash: freshHash,
    })
    expect(r2.ok).toBe(true)
    expect(r2.failure).toBeUndefined()
    // CRLF preserved end-to-end (edit strategy + write did not coerce terminators).
    expect(readFileSync(path, "utf8")).toBe("a = 2\r\nb = 2")
  })
})
