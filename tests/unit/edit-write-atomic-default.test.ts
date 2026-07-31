/** LANE 1 (ATOMIC-DEFAULT) — edit/write commit through the atomic temp+rename
 *  path BY DEFAULT (no `expected_hash` required), with mode preservation, and a
 *  byte-identical CONTENT result.
 *
 *  Unit-level coverage:
 *    (a) real-fs default port: a plain edit/write (NO expected_hash) commits via
 *        the atomic path (a temp sibling appears mid-commit) AND preserves an
 *        existing 0o755 mode — never a direct truncating write to the final path;
 *    (b) byte-identical CONTENT result vs the legacy expectation;
 *    (c) in-memory fake WITHOUT writeFileAtomic still works (fallback to
 *        writeFile, byte-identical).
 *
 *  Red-first: on the pre-change code (`commitEdit`/`commitWrite` default to
 *  `fs.writeFile`), (a) fails — the mode drops to 0o644 and the commit method is
 *  the plain write. (c) is green on both (proves the fallback is intact). */

import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FileInfo, FileSystemPort } from "@/storage"
import { defaultFileSystemPort } from "@/storage"
import type { ToolContext, ToolResult } from "@/tool"
import { makeEditTool } from "@/tool/edit"
import { makeWriteTool } from "@/tool/write"

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
const mkdir = async (prefix: string): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

/** A REAL-fs-backed port that DELEGATES every method to the default port (so the
 *  bytes, the temp+rename, and the mode are all real on-disk) but RECORDS which
 *  COMMIT method the tool selected. This is the red-on-injection teeth: with the
 *  atomic-default routing the tool calls `writeFileAtomic`; reverting commitEdit/
 *  commitWrite to default to `fs.writeFile` flips the recorded method to
 *  `writeFile`. A bare mode assertion is INSUFFICIENT — a truncating Bun.write to
 *  an EXISTING file keeps that file's own inode + mode, so 0o755 survives even
 *  the non-atomic path. The method record is what proves the MECHANISM. */
const makeRealFsSpyPort = (): {
  port: FileSystemPort
  commits: { method: "writeFile" | "writeFileAtomic"; path: string }[]
} => {
  const commits: { method: "writeFile" | "writeFileAtomic"; path: string }[] = []
  const port: FileSystemPort = {
    readFile: (p, b) => defaultFileSystemPort.readFile(p, b),
    statFile: (p, b) => defaultFileSystemPort.statFile(p, b),
    fileExists: (p, b) => defaultFileSystemPort.fileExists(p, b),
    async writeFile(p, content, b) {
      commits.push({ method: "writeFile", path: p })
      await defaultFileSystemPort.writeFile(p, content, b)
    },
    async writeFileAtomic(p, content, b) {
      commits.push({ method: "writeFileAtomic", path: p })
      // biome-ignore lint/style/noNonNullAssertion: default port always has it
      await defaultFileSystemPort.writeFileAtomic!(p, content, b)
    },
  }
  return { port, commits }
}

const runTool = async (
  tool: {
    execute: (i: never, c: ToolContext) => AsyncIterable<{ type: string; result?: ToolResult }>
  },
  input: unknown,
  cwd: string,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx(cwd))) {
    if (ev.type === "result" && ev.result) result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("edit/write — ATOMIC commit by default (real-fs default port)", () => {
  test("edit WITHOUT expected_hash commits via writeFileAtomic AND preserves an existing 0o755 mode", async () => {
    const dir = await mkdir("edit-atomic-default-")
    const file = join(dir, "script.sh")
    await writeFile(file, "echo old\n", "utf8")
    await chmod(file, 0o755)

    const { port, commits } = makeRealFsSpyPort()
    const tool = makeEditTool(port)
    const r = await runTool(tool, { path: file, old_string: "old", new_string: "new" }, dir)

    expect(r.ok).toBe(true)
    // Byte-identical CONTENT result — the edit landed.
    expect(await readFile(file, "utf8")).toBe("echo new\n")
    // The mode SURVIVED (real-fs mode-preservation in the atomic adapter).
    expect((await stat(file)).mode & 0o777).toBe(0o755)
    // THE TEETH: the commit routed through the atomic method, NOT the plain
    // truncating write. Reverting commitEdit to default to fs.writeFile flips
    // this to [{ method: "writeFile", ... }] ⇒ RED.
    expect(commits).toEqual([{ method: "writeFileAtomic", path: file }])
  })

  test("write WITHOUT expected_hash commits via writeFileAtomic AND preserves an existing 0o755 mode", async () => {
    const dir = await mkdir("write-atomic-default-")
    const file = join(dir, "tool.sh")
    await writeFile(file, "echo old\n", "utf8")
    await chmod(file, 0o755)

    const { port, commits } = makeRealFsSpyPort()
    const tool = makeWriteTool(port)
    const r = await runTool(tool, { path: file, content: "echo new\n" }, dir)

    expect(r.ok).toBe(true)
    expect(await readFile(file, "utf8")).toBe("echo new\n")
    expect((await stat(file)).mode & 0o777).toBe(0o755)
    // THE TEETH: atomic routing, not the truncating write.
    expect(commits).toEqual([{ method: "writeFileAtomic", path: file }])
  })

  test("byte-identical content: edit + write round-trip newlines/unicode unchanged", async () => {
    const dir = await mkdir("atomic-bytes-")
    const wf = join(dir, "round.txt")
    const content = "line1\nline2\n日本語\n"
    const wr = await runTool(makeWriteTool(defaultFileSystemPort), { path: wf, content }, dir)
    expect(wr.ok).toBe(true)
    expect(await readFile(wf, "utf8")).toBe(content)

    const ef = join(dir, "edit-round.txt")
    await writeFile(ef, "alpha beta\n", "utf8")
    const er = await runTool(
      makeEditTool(defaultFileSystemPort),
      { path: ef, old_string: "beta", new_string: "gamma" },
      dir,
    )
    expect(er.ok).toBe(true)
    expect(await readFile(ef, "utf8")).toBe("alpha gamma\n")
  })
})

/** In-memory fake implementing ONLY the legacy methods (NO writeFileAtomic).
 *  The atomic-default routing MUST fall back to `writeFile` here — byte-identical
 *  result. Records which method committed so the fallback is proven, not assumed. */
const makeLegacyPort = (seed: Record<string, string>) => {
  const files = new Map<string, string>(Object.entries(seed))
  const writes: { method: "writeFile"; path: string; content: string }[] = []
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
  }
  return { port, files, writes }
}

describe("edit/write — in-memory fake WITHOUT writeFileAtomic falls back to writeFile", () => {
  test("edit on a legacy port commits via writeFile (byte-identical)", async () => {
    const path = "/in-mem/legacy-edit.txt"
    const { port, files, writes } = makeLegacyPort({ [path]: "const a = 1" })
    const r = await runTool(
      makeEditTool(port),
      { path, old_string: "1", new_string: "2" },
      "/in-mem",
    )
    expect(r.ok).toBe(true)
    expect(files.get(path)).toBe("const a = 2")
    expect(writes).toEqual([{ method: "writeFile", path, content: "const a = 2" }])
  })

  test("write on a legacy port commits via writeFile (byte-identical)", async () => {
    const path = "/in-mem/legacy-write.txt"
    const { port, files, writes } = makeLegacyPort({})
    const r = await runTool(makeWriteTool(port), { path, content: "hello" }, "/in-mem")
    expect(r.ok).toBe(true)
    expect(files.get(path)).toBe("hello")
    expect(writes).toEqual([{ method: "writeFile", path, content: "hello" }])
  })
})
