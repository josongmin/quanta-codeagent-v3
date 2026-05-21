import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetRuntimeConfig } from "@/shared"
import { FsJailError, readFile, resolvePath, writeFile } from "@/storage"
import type { ToolContext, ToolResult } from "@/tool"
import { editTool } from "@/tool/edit"
import { readTool } from "@/tool/read"
import { writeTool } from "@/tool/write"

// S6 — FS jail acceptance. The jail triggers EXACTLY when a tool passes an
// explicit ctx.cwd as baseDir; no-baseDir callers (state.ts pattern) keep the
// pre-jail behavior. QUANTA_FS_JAIL=off is the documented opt-out.

const jail = mkdtempSync(join(tmpdir(), "fs-jail-"))
const outside = mkdtempSync(join(tmpdir(), "fs-jail-out-"))
writeFileSync(join(outside, "secret.txt"), "TOP-SECRET")
// A symlink INSIDE the jail that points OUTSIDE it (classic escape).
symlinkSync(outside, join(jail, "escape-link"))
// A normal in-jail file.
writeFileSync(join(jail, "ok.txt"), "in-jail content")

afterAll(() => {
  rmSync(jail, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

beforeEach(() => {
  delete process.env.QUANTA_FS_JAIL
  __resetRuntimeConfig()
})
afterEach(() => {
  delete process.env.QUANTA_FS_JAIL
  __resetRuntimeConfig()
})

const ctx = (): ToolContext => ({ cwd: jail, signal: new AbortController().signal })

const drive = async (
  tool: {
    execute: (i: never, c: ToolContext) => AsyncIterable<{ type: string; result?: ToolResult }>
  },
  input: unknown,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx())) {
    if (ev.type === "result" && ev.result) result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("resolvePath jail enforcement", () => {
  test("relative `..` climb above the jail root throws FsJailError", () => {
    expect(() => resolvePath("../../etc/hosts", jail)).toThrow(FsJailError)
  })

  test("absolute path outside the jail throws FsJailError", () => {
    expect(() => resolvePath("/etc/hosts", jail)).toThrow(FsJailError)
  })

  test("symlink that points outside the jail throws FsJailError", () => {
    expect(() => resolvePath("escape-link/secret.txt", jail)).toThrow(FsJailError)
  })

  test("in-jail relative path is allowed and resolved against baseDir", () => {
    expect(resolvePath("ok.txt", jail)).toBe(join(jail, "ok.txt"))
    expect(resolvePath("sub/deep/x.txt", jail)).toBe(join(jail, "sub/deep/x.txt"))
  })

  test("no-baseDir callers (state.ts pattern) are UNAFFECTED by the jail", () => {
    // Absent baseDir ⇒ legacy behavior: absolute path returned unchanged,
    // no jail throw even though it is clearly 'outside' any cwd.
    expect(resolvePath("/etc/hosts")).toBe("/etc/hosts")
    expect(() => resolvePath("../up.txt")).not.toThrow()
  })

  test("QUANTA_FS_JAIL=off restores escape (opt-out works)", () => {
    process.env.QUANTA_FS_JAIL = "off"
    __resetRuntimeConfig()
    expect(resolvePath("/etc/hosts", jail)).toBe("/etc/hosts")
    expect(() => resolvePath("../../etc/hosts", jail)).not.toThrow()
  })
})

describe("storage readFile/writeFile honor the jail", () => {
  test("readFile of an absolute outside path throws FsJailError", async () => {
    await expect(readFile(join(outside, "secret.txt"), jail)).rejects.toThrow(FsJailError)
  })

  test("writeFile escaping the jail throws and writes NOTHING", async () => {
    const target = join(outside, "pwned.txt")
    await expect(writeFile(`../../${join(outside, "pwned.txt")}`, "x", jail)).rejects.toThrow(
      FsJailError,
    )
    expect(existsSync(target)).toBe(false)
  })

  test("in-jail round trip still works", async () => {
    await writeFile("round.txt", "jailed-ok", jail)
    expect(await readFile("round.txt", jail)).toBe("jailed-ok")
  })
})

describe("read/write/edit tools DENY escapes (ok:false, no throw, no write)", () => {
  test.each([
    ["../../etc/hosts", "relative climb"],
    ["/etc/hosts", "absolute outside"],
    ["escape-link/secret.txt", "symlink escape"],
  ])("read denies %s (%s)", async (path) => {
    const r = await drive(readTool, { path })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("jail")
  })

  test("read ALLOWS a normal in-jail relative path", async () => {
    const r = await drive(readTool, { path: "ok.txt" })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("1\tin-jail content")
  })

  test("write denies an escape and writes nothing", async () => {
    const target = join(outside, "via-tool.txt")
    const r = await drive(writeTool, {
      path: `../../${join(outside, "via-tool.txt")}`,
      content: "x",
    })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("jail")
    expect(existsSync(target)).toBe(false)
  })

  test("write ALLOWS a normal in-jail relative path", async () => {
    const r = await drive(writeTool, { path: "written.txt", content: "hi" })
    expect(r.ok).toBe(true)
    expect(readFileSync(join(jail, "written.txt"), "utf8")).toBe("hi")
  })

  test("edit denies an escape on read, writes nothing", async () => {
    const r = await drive(editTool, {
      path: "escape-link/secret.txt",
      old_string: "TOP-SECRET",
      new_string: "HACKED",
    })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("jail")
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("TOP-SECRET")
  })

  test("edit ALLOWS an in-jail file", async () => {
    writeFileSync(join(jail, "editable.txt"), "value=1")
    const r = await drive(editTool, {
      path: "editable.txt",
      old_string: "1",
      new_string: "2",
    })
    expect(r.ok).toBe(true)
    expect(readFileSync(join(jail, "editable.txt"), "utf8")).toBe("value=2")
  })

  test("QUANTA_FS_JAIL=off lets the read tool escape again (opt-out)", async () => {
    process.env.QUANTA_FS_JAIL = "off"
    __resetRuntimeConfig()
    const r = await drive(readTool, { path: join(outside, "secret.txt") })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("1\tTOP-SECRET")
  })
})
