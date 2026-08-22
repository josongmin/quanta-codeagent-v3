/** LANE 1 (ATOMIC-DEFAULT) HELLGATE — drive the REAL exported `editTool` and
 *  `writeTool` (default `@/storage` port) END-TO-END through their async-generator
 *  `execute` against a REAL temp-dir filesystem, with NO `expected_hash`, editing
 *  an EXISTING `0o755` file, and prove the commit reached the final path via a
 *  rename-FROM-A-TEMP (the crash-safe atomic mechanism), NEVER a truncating
 *  direct write.
 *
 *  Two independent, deterministic, real-fs teeth distinguish the mechanisms:
 *
 *    1. INODE IDENTITY — a POSIX `rename(temp, path)` promotes a FRESH temp inode,
 *       so the final path's inode CHANGES across the commit. A truncating
 *       `Bun.write` to an EXISTING file keeps the SAME inode (verified: truncate
 *       in place). So inode-changed ⇒ temp+rename; inode-same ⇒ direct write.
 *    2. MODE PRESERVATION — the atomic adapter re-applies the original mode to the
 *       temp before the rename, so `0o755` survives. (On the legacy in-place write
 *       the mode survives too — that is why inode identity is the PRIMARY tooth and
 *       mode is the secondary one; together they nail the atomic, mode-preserving
 *       path.)
 *
 *  Plus: no temp straggler is left beside the target after a successful commit,
 *  and the file CONTENT is byte-identical to the requested bytes.
 *
 *  RED-ON-INJECTION: reverting commitEdit/commitWrite to default to the plain
 *  `fs.writeFile` (truncating) keeps the SAME inode ⇒ tooth 1 fails RED. */

import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { editTool } from "@/tool/edit"
import { writeTool } from "@/tool/write"

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

const drive = async (
  tool: typeof editTool | typeof writeTool,
  input: unknown,
  cwd: string,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx(cwd))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result from tool execute")
  return result
}

/** Count temp siblings (`<name>.quanta-tmp-...`) left beside `file` in `dir`. */
const tempStragglers = async (dir: string, name: string): Promise<string[]> =>
  (await readdir(dir)).filter((n) => n.startsWith(`${name}.quanta-tmp-`))

describe("HELLGATE — edit/write commit atomically by default (real exported tools, real fs)", () => {
  test("editTool.execute (no expected_hash) on an existing 0o755 file: rename-from-temp (inode changes) + mode survives", async () => {
    const dir = await mkdir("hellgate-edit-atomic-")
    const file = join(dir, "deploy.sh")
    await writeFile(file, "#!/bin/sh\necho old\n", "utf8")
    await chmod(file, 0o755)
    const inoBefore = (await stat(file)).ino

    const r = await drive(editTool, { path: file, old_string: "old", new_string: "new" }, dir)

    expect(r.ok).toBe(true)
    // Byte-identical CONTENT result — the edit landed.
    expect(await readFile(file, "utf8")).toBe("#!/bin/sh\necho new\n")
    // TOOTH 1 — the final path's inode CHANGED ⇒ a rename promoted a fresh temp
    // inode (atomic). A truncating direct write keeps the SAME inode ⇒ on the
    // reverted code this assertion fails RED.
    expect((await stat(file)).ino).not.toBe(inoBefore)
    // TOOTH 2 — the executable mode survived the temp+rename.
    expect((await stat(file)).mode & 0o777).toBe(0o755)
    // No temp straggler beside the target after a clean commit.
    expect(await tempStragglers(dir, "deploy.sh")).toEqual([])
  })

  test("writeTool.execute (overwrite an existing 0o755 file): rename-from-temp (inode changes) + mode survives", async () => {
    const dir = await mkdir("hellgate-write-atomic-")
    const file = join(dir, "run.sh")
    await writeFile(file, "echo old\n", "utf8")
    await chmod(file, 0o755)
    const inoBefore = (await stat(file)).ino

    const r = await drive(writeTool, { path: file, content: "echo new\n" }, dir)

    expect(r.ok).toBe(true)
    expect(r.output).toContain("Overwrote")
    expect(await readFile(file, "utf8")).toBe("echo new\n")
    // TOOTH 1 — inode changed ⇒ rename-from-temp (atomic); reverting to the
    // truncating write keeps the same inode ⇒ RED.
    expect((await stat(file)).ino).not.toBe(inoBefore)
    // TOOTH 2 — mode preserved.
    expect((await stat(file)).mode & 0o777).toBe(0o755)
    expect(await tempStragglers(dir, "run.sh")).toEqual([])
  })

  test("writeTool.execute on a NEW file still creates it correctly (atomic path, default perms, no straggler)", async () => {
    const dir = await mkdir("hellgate-write-new-")
    const file = join(dir, "fresh.txt")
    const r = await drive(writeTool, { path: file, content: "brand new\n" }, dir)
    expect(r.ok).toBe(true)
    expect(r.output).toContain("Created")
    expect(await readFile(file, "utf8")).toBe("brand new\n")
    // New file → default perms (no spurious exec bit).
    expect((await stat(file)).mode & 0o111).toBe(0)
    expect(await tempStragglers(dir, "fresh.txt")).toEqual([])
  })
})
