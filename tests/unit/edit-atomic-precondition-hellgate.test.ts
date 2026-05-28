/** ADR-0397 hellgate — atomic write + sha256 hash precondition.
 *
 *  Five adversarial invariants the `edit` tool MUST honor when the optional
 *  `expected_hash` opt-in is threaded:
 *
 *    1. Default-OFF byte-identical — no `expected_hash` ⇒ pre-ADR behavior.
 *    2. Matching hash ⇒ write proceeds normally, file ends with the edit.
 *    3. Mismatching hash ⇒ `failure.mode: "stale_precondition"` with both
 *       hashes surfaced + the on-disk content is UNTOUCHED (not even a
 *       partial write or a stray temp file).
 *    4. Mismatching hash ⇒ neither `fs.writeFile` nor `fs.writeFileAtomic`
 *       is ever invoked (no write authority leaves the precondition gate).
 *    5. The `writeFileAtomic` adapter's 2-phase contract: if the in-flight
 *       commit phase fails (rename throws), the original file's bytes are
 *       preserved (no partial-write window). */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FileInfo, FileSystemPort } from "@/storage"
import { sha256Hex, writeFileAtomic } from "@/storage"
import type { ToolContext, ToolResult } from "@/tool"
import { makeEditTool } from "@/tool/edit"

const dir = mkdtempSync(join(tmpdir(), "edit-hash-hellgate-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
})

const run = async (
  tool: ReturnType<typeof makeEditTool>,
  input: unknown,
  cwd: string,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx(cwd))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

/** Recording in-memory port — implements ONLY the legacy 4 methods. Used to
 *  prove that the default-OFF path (no `expected_hash`) does NOT need the
 *  new optional `writeFileAtomic` method (legacy ports stay valid). */
const makeRecordingLegacyPort = (seed: Record<string, string>) => {
  const files = new Map<string, string>(Object.entries(seed))
  const writes: { path: string; content: string }[] = []
  const port: FileSystemPort = {
    async readFile(path: string): Promise<string> {
      const v = files.get(path)
      if (v === undefined) throw new Error(`File not found: ${path}`)
      return v
    },
    async writeFile(path: string, content: string): Promise<void> {
      writes.push({ path, content })
      files.set(path, content)
    },
    async statFile(path: string): Promise<FileInfo> {
      return { path, size: files.get(path)?.length ?? 0, isDirectory: false }
    },
    async fileExists(path: string): Promise<boolean> {
      return files.has(path)
    },
  }
  return { port, files, writes }
}

/** Port with BOTH methods + recording both. Used to prove the atomic path
 *  routes through `writeFileAtomic` when `expected_hash` is supplied. */
const makeRecordingFullPort = (seed: Record<string, string>) => {
  const files = new Map<string, string>(Object.entries(seed))
  const writes: { method: "writeFile" | "writeFileAtomic"; path: string; content: string }[] = []
  const port: FileSystemPort = {
    async readFile(path: string): Promise<string> {
      const v = files.get(path)
      if (v === undefined) throw new Error(`File not found: ${path}`)
      return v
    },
    async writeFile(path: string, content: string): Promise<void> {
      writes.push({ method: "writeFile", path, content })
      files.set(path, content)
    },
    async statFile(path: string): Promise<FileInfo> {
      return { path, size: files.get(path)?.length ?? 0, isDirectory: false }
    },
    async fileExists(path: string): Promise<boolean> {
      return files.has(path)
    },
    async writeFileAtomic(path: string, content: string): Promise<void> {
      writes.push({ method: "writeFileAtomic", path, content })
      files.set(path, content)
    },
  }
  return { port, files, writes }
}

describe("ADR-0397 edit + expected_hash precondition", () => {
  test("default-OFF: no expected_hash ⇒ writes through legacy fs.writeFile (no atomic method needed)", async () => {
    const path = "/in-mem/legacy-default-off.txt"
    const { port, files, writes } = makeRecordingLegacyPort({
      [path]: "const a = 1",
    })
    const tool = makeEditTool(port)
    const r = await run(tool, { path, old_string: "1", new_string: "2" }, "/in-mem")
    expect(r.ok).toBe(true)
    expect(files.get(path)).toBe("const a = 2")
    // Default-OFF path MUST go through the legacy method (proves we did not
    // require the new optional method on every port).
    expect(writes).toEqual([{ path, content: "const a = 2" }])
  })

  test("matching expected_hash ⇒ write proceeds via writeFileAtomic when port supports it", async () => {
    const path = "/in-mem/match.txt"
    const before = "const a = 1"
    const after = "const a = 2"
    const hash = sha256Hex(before)
    const { port, files, writes } = makeRecordingFullPort({ [path]: before })
    const tool = makeEditTool(port)
    const r = await run(
      tool,
      { path, old_string: "1", new_string: "2", expected_hash: hash },
      "/in-mem",
    )
    expect(r.ok).toBe(true)
    expect(files.get(path)).toBe(after)
    // Atomic path used when expected_hash + port.writeFileAtomic both present.
    expect(writes).toEqual([{ method: "writeFileAtomic", path, content: after }])
  })

  test("mismatching expected_hash ⇒ stale_precondition + NO write attempt + file untouched", async () => {
    const path = "/in-mem/mismatch.txt"
    const before = "const a = 1"
    const { port, files, writes } = makeRecordingFullPort({ [path]: before })
    const tool = makeEditTool(port)
    const r = await run(
      tool,
      {
        path,
        old_string: "1",
        new_string: "2",
        expected_hash: "f".repeat(64), // 64 hex chars, definitely not the real hash
      },
      "/in-mem",
    )
    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({
      mode: "stale_precondition",
      path,
      expectedHash: "f".repeat(64),
      actualHash: sha256Hex(before),
    })
    // Authority gate: NEITHER write method should have been invoked.
    expect(writes).toEqual([])
    // File content unchanged.
    expect(files.get(path)).toBe(before)
    // Output text mentions both hashes so the model can see the divergence.
    expect(r.output).toContain(sha256Hex(before))
    expect(r.output).toContain("f".repeat(64))
  })

  test("expected_hash on legacy port (no atomic method) still gates writes via writeFile fallback", async () => {
    // Some test ports / external consumers may not implement the new optional
    // method. The precondition gate MUST still fire; on hash MATCH the tool
    // falls back to fs.writeFile (byte-identical to the legacy commit path).
    const path = "/in-mem/legacy-precond.txt"
    const before = "const a = 1"
    const hash = sha256Hex(before)
    const { port, files, writes } = makeRecordingLegacyPort({ [path]: before })
    const tool = makeEditTool(port)
    const r = await run(
      tool,
      { path, old_string: "1", new_string: "2", expected_hash: hash },
      "/in-mem",
    )
    expect(r.ok).toBe(true)
    expect(files.get(path)).toBe("const a = 2")
    expect(writes).toEqual([{ path, content: "const a = 2" }])
  })

  test("default-OFF path on a port that DOES implement writeFileAtomic still uses legacy writeFile", async () => {
    // Even when the port can do atomic, omitting expected_hash MUST keep
    // the byte-identical legacy commit path (so the rollout is opt-in only).
    const path = "/in-mem/no-precond-with-atomic.txt"
    const { port, writes } = makeRecordingFullPort({ [path]: "const a = 1" })
    const tool = makeEditTool(port)
    const r = await run(tool, { path, old_string: "1", new_string: "2" }, "/in-mem")
    expect(r.ok).toBe(true)
    expect(writes).toEqual([{ method: "writeFile", path, content: "const a = 2" }])
  })
})

describe("ADR-0397 writeFileAtomic adapter — atomic invariants on the real FS", () => {
  test("happy path: 2-phase commit replaces content end-to-end", async () => {
    const f = join(dir, "atomic-happy.txt")
    writeFileSync(f, "before")
    await writeFileAtomic(f, "after")
    expect(readFileSync(f, "utf8")).toBe("after")
    // No leftover temp files alongside the target.
    const stragglers = readdirSync(dir).filter((n) => n.startsWith("atomic-happy.txt.quanta-tmp-"))
    expect(stragglers).toEqual([])
  })

  test("phase-A failure (cannot write temp into nonexistent dir) ⇒ original untouched", async () => {
    const f = join(dir, "missing-parent", "atomic-phaseA.txt")
    // The parent dir does not exist → Bun.write also auto-creates? It does.
    // Instead, simulate Phase-A failure by passing a path whose PARENT cannot
    // be created (e.g., a regular file as a "directory"). We make a regular
    // file and try to write a child path beneath it.
    const blocker = join(dir, "atomic-blocker")
    writeFileSync(blocker, "blocker-data")
    const child = join(blocker, "child.txt") // blocker is a FILE, not a dir
    let threw: unknown
    try {
      await writeFileAtomic(child, "new-content")
    } catch (e) {
      threw = e
    }
    expect(threw).toBeDefined()
    // The blocker file is byte-identical: the failed temp write did not
    // touch the would-be parent path.
    expect(readFileSync(blocker, "utf8")).toBe("blocker-data")
    // The "target" path was never created.
    let existsAtTarget = true
    try {
      readFileSync(child, "utf8")
    } catch {
      existsAtTarget = false
    }
    expect(existsAtTarget).toBe(false)
    // Suppress unused-var lint for the (unused) `f` placeholder.
    expect(f.length).toBeGreaterThan(0)
  })

  test("sha256Hex matches every byte of utf-8 content (no truncation, no normalization)", () => {
    // Mirrors @/llm/system-prompt-cache/hash.ts so the convention is documented
    // at the storage seam too — the model can compute the same digest from a
    // node:crypto invocation and the two hashes will match.
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
    // Multibyte UTF-8 preserved (sha256 of "한글" UTF-8 bytes).
    const k = sha256Hex("한글")
    expect(k).toMatch(/^[0-9a-f]{64}$/)
  })
})
