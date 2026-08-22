import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { applyPatchTool, FsJailViolationError } from "@/tool/apply-patch"

// ---------------------------------------------------------------------------
// End-to-end integration: real tmpdir as jail root, real `node:fs/promises`
// via the default port wiring, multi-op patches, symlink-escape attempts.
// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "apply-patch-int-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const tmpSub = (name: string): string => {
  const d = join(root, name)
  mkdirSync(d, { recursive: true })
  return d
}

const ctx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
})

const run = async (input: unknown, cwd: string): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of applyPatchTool.execute(input as never, ctx(cwd))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("apply_patch tool — integration with real filesystem", () => {
  test("Add + Update + Move + Delete in a single atomic patch", async () => {
    const dir = tmpSub("multi-op")
    writeFileSync(join(dir, "obsolete.txt"), "remove me\n")
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(join(dir, "src/app.py"), "def greet():\n    print('Hi')\n")

    const patch = [
      "*** Begin Patch",
      "*** Add File: hello.txt",
      "+Hello world",
      "*** Update File: src/app.py",
      "*** Move to: src/main.py",
      "@@ def greet():",
      "-    print('Hi')",
      "+    print('Hello, world!')",
      "*** Delete File: obsolete.txt",
      "*** End Patch",
    ].join("\n")
    const r = await run({ patch }, dir)
    expect(r.ok).toBe(true)
    expect(r.output).toContain("added: hello.txt")
    expect(r.output).toContain("moved: src/app.py -> src/main.py")
    expect(r.output).toContain("deleted: obsolete.txt")

    expect(readFileSync(join(dir, "hello.txt"), "utf8")).toBe("Hello world")
    expect(readFileSync(join(dir, "src/main.py"), "utf8")).toBe(
      "def greet():\n    print('Hello, world!')\n",
    )
    expect(existsSync(join(dir, "src/app.py"))).toBe(false)
    expect(existsSync(join(dir, "obsolete.txt"))).toBe(false)
  })

  test("Update preserves bytes outside the hunk verbatim", async () => {
    const dir = tmpSub("byte-exact")
    const original = "alpha\nbeta\ngamma\ndelta\nepsilon\n"
    writeFileSync(join(dir, "f.txt"), original)
    const patch = [
      "*** Begin Patch",
      "*** Update File: f.txt",
      "@@",
      " beta",
      "-gamma",
      "+GAMMA",
      " delta",
      "*** End Patch",
    ].join("\n")
    const r = await run({ patch }, dir)
    expect(r.ok).toBe(true)
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("alpha\nbeta\nGAMMA\ndelta\nepsilon\n")
  })

  test("Add into a deep new directory creates intermediate parents", async () => {
    const dir = tmpSub("deep-add")
    const patch = [
      "*** Begin Patch",
      "*** Add File: a/b/c/leaf.txt",
      "+deep",
      "*** End Patch",
    ].join("\n")
    const r = await run({ patch }, dir)
    expect(r.ok).toBe(true)
    expect(readFileSync(join(dir, "a/b/c/leaf.txt"), "utf8")).toBe("deep")
  })

  test("symlink in jail pointing OUTSIDE is rejected (escape attempt)", async () => {
    const dir = tmpSub("symlink-escape")
    const outside = mkdtempSync(join(tmpdir(), "apply-patch-out-"))
    writeFileSync(join(outside, "secret.txt"), "TOP-SECRET")
    symlinkSync(outside, join(dir, "escape-link"))

    // Try to Update the symlink target — should fail at the port boundary.
    const patch = [
      "*** Begin Patch",
      "*** Update File: escape-link/secret.txt",
      "@@",
      "-TOP-SECRET",
      "+HACKED",
      "*** End Patch",
    ].join("\n")
    await expect(run({ patch }, dir)).rejects.toBeInstanceOf(FsJailViolationError)
    // Outside content intact.
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("TOP-SECRET")
    rmSync(outside, { recursive: true, force: true })
  })

  test("Add through an escaping symlink-as-parent is rejected", async () => {
    const dir = tmpSub("symlink-add")
    const outside = mkdtempSync(join(tmpdir(), "apply-patch-out2-"))
    symlinkSync(outside, join(dir, "out"))

    const patch = [
      "*** Begin Patch",
      "*** Add File: out/created.txt",
      "+pwned",
      "*** End Patch",
    ].join("\n")
    await expect(run({ patch }, dir)).rejects.toBeInstanceOf(FsJailViolationError)
    expect(existsSync(join(outside, "created.txt"))).toBe(false)
    rmSync(outside, { recursive: true, force: true })
  })

  test("EOF marker integration on a real file", async () => {
    const dir = tmpSub("int-eof")
    writeFileSync(join(dir, "tail.txt"), "x\ny\nz\n")
    const patch = [
      "*** Begin Patch",
      "*** Update File: tail.txt",
      "@@",
      " y",
      "-z",
      "+Z",
      "*** End of File",
      "*** End Patch",
    ].join("\n")
    const r = await run({ patch }, dir)
    expect(r.ok).toBe(true)
    expect(readFileSync(join(dir, "tail.txt"), "utf8")).toBe("x\ny\nZ\n")
  })

  test("Pre-flight failure (Move destination exists) leaves both files untouched", async () => {
    const dir = tmpSub("preflight")
    writeFileSync(join(dir, "src.py"), "value = 1\n")
    writeFileSync(join(dir, "dst.py"), "already-here\n")
    const patch = [
      "*** Begin Patch",
      "*** Update File: src.py",
      "*** Move to: dst.py",
      "@@",
      "-value = 1",
      "+value = 2",
      "*** End Patch",
    ].join("\n")
    await expect(run({ patch }, dir)).rejects.toThrow(/already exists/)
    // Both files unchanged.
    expect(readFileSync(join(dir, "src.py"), "utf8")).toBe("value = 1\n")
    expect(readFileSync(join(dir, "dst.py"), "utf8")).toBe("already-here\n")
  })

  test("Delete-only patch surfaces deleted: in the output", async () => {
    const dir = tmpSub("delete-only")
    writeFileSync(join(dir, "doomed.txt"), "")
    const patch = ["*** Begin Patch", "*** Delete File: doomed.txt", "*** End Patch"].join("\n")
    const r = await run({ patch }, dir)
    expect(r.ok).toBe(true)
    expect(r.output).toContain("deleted: doomed.txt")
    expect(existsSync(join(dir, "doomed.txt"))).toBe(false)
  })
})
