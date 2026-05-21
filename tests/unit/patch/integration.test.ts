import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { applyPatch, type FileSystemPort, parsePatch } from "../../../src/patch/index.js"

// ---------------------------------------------------------------------------
// Real-filesystem integration: drives applyPatch with a thin Node fs adapter
// rooted at a per-test tmpdir.
// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "v4a-int-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

class NodeFs implements FileSystemPort {
  constructor(private readonly root: string) {}

  private resolve(p: string): string {
    return join(this.root, p)
  }

  async readFile(p: string): Promise<string> {
    return readFile(this.resolve(p), "utf8")
  }
  async writeFile(p: string, content: string): Promise<void> {
    const abs = this.resolve(p)
    const dir = dirname(abs)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    await writeFile(abs, content, "utf8")
  }
  async deleteFile(p: string): Promise<void> {
    await rm(this.resolve(p))
  }
  async renameFile(from: string, to: string): Promise<void> {
    await rename(this.resolve(from), this.resolve(to))
  }
  async exists(p: string): Promise<boolean> {
    return existsSync(this.resolve(p))
  }
}

function tmpDir(name: string): string {
  const d = join(root, name)
  mkdirSync(d, { recursive: true })
  return d
}

describe("V4A integration — real filesystem", () => {
  test("full workflow: Add + Update + Delete + Move to (end-to-end)", async () => {
    const dir = tmpDir("e2e-full")
    writeFileSync(join(dir, "obsolete.txt"), "remove me\n")
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(join(dir, "src/app.py"), "def greet():\n    print('Hi')\n")

    const fs = new NodeFs(dir)
    const text = [
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
    const r = await applyPatch(parsePatch(text), fs)

    expect(r.filesAdded).toEqual(["hello.txt"])
    expect(r.filesMoved).toEqual([["src/app.py", "src/main.py"]])
    expect(r.filesDeleted).toEqual(["obsolete.txt"])

    expect(readFileSync(join(dir, "hello.txt"), "utf8")).toBe("Hello world")
    expect(readFileSync(join(dir, "src/main.py"), "utf8")).toBe(
      "def greet():\n    print('Hello, world!')\n",
    )
    expect(existsSync(join(dir, "src/app.py"))).toBe(false)
    expect(existsSync(join(dir, "obsolete.txt"))).toBe(false)
  })

  test("Update File round-trips file bytes exactly outside the hunk", async () => {
    const dir = tmpDir("e2e-bytes")
    const original = "alpha\nbeta\ngamma\ndelta\nepsilon\n"
    writeFileSync(join(dir, "f.txt"), original)
    const fs = new NodeFs(dir)
    const text = [
      "*** Begin Patch",
      "*** Update File: f.txt",
      "@@",
      " beta",
      "-gamma",
      "+GAMMA",
      " delta",
      "*** End Patch",
    ].join("\n")
    await applyPatch(parsePatch(text), fs)
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("alpha\nbeta\nGAMMA\ndelta\nepsilon\n")
  })

  test("End-of-File EOF marker on real file", async () => {
    const dir = tmpDir("e2e-eof")
    writeFileSync(join(dir, "f.txt"), "a\nb\nc\n")
    const fs = new NodeFs(dir)
    const text = [
      "*** Begin Patch",
      "*** Update File: f.txt",
      "@@",
      " b",
      "-c",
      "+C",
      "*** End of File",
      "*** End Patch",
    ].join("\n")
    await applyPatch(parsePatch(text), fs)
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("a\nb\nC\n")
  })

  test("Pre-flight failure leaves source untouched", async () => {
    const dir = tmpDir("e2e-preflight")
    writeFileSync(join(dir, "a.py"), "value = 1\n")
    writeFileSync(join(dir, "b.py"), "already-here\n")
    const fs = new NodeFs(dir)
    const text = [
      "*** Begin Patch",
      "*** Update File: a.py",
      "*** Move to: b.py", // destination already exists -> reject pre-write
      "@@",
      "-value = 1",
      "+value = 2",
      "*** End Patch",
    ].join("\n")
    await expect(applyPatch(parsePatch(text), fs)).rejects.toThrow(/already exists/)
    // Source untouched.
    expect(readFileSync(join(dir, "a.py"), "utf8")).toBe("value = 1\n")
    expect(readFileSync(join(dir, "b.py"), "utf8")).toBe("already-here\n")
  })
})
