import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { fileExists, parentDir, readFile, resolvePath, statFile, writeFile } from "@/storage"

const dir = mkdtempSync(join(tmpdir(), "storage-test-"))

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("resolvePath", () => {
  test("returns an absolute path unchanged", () => {
    const abs = join(dir, "abs.txt")
    expect(resolvePath(abs)).toBe(abs)
    expect(isAbsolute(resolvePath(abs))).toBe(true)
  })

  test("resolves a relative path against process.cwd()", () => {
    expect(resolvePath("a/b.txt")).toBe(resolve(process.cwd(), "a/b.txt"))
  })

  test("resolves a relative path against an explicit baseDir", () => {
    expect(resolvePath("a/b.txt", dir)).toBe(resolve(dir, "a/b.txt"))
  })

  test("an absolute path wins over baseDir (no-op)", () => {
    const abs = join(dir, "abs.txt")
    expect(resolvePath(abs, "/some/other/base")).toBe(abs)
  })

  test("empty baseDir falls back to process.cwd()", () => {
    expect(resolvePath("a/b.txt", "")).toBe(resolve(process.cwd(), "a/b.txt"))
  })
})

describe("parentDir", () => {
  test("returns the directory of a resolved absolute path", () => {
    expect(parentDir(join(dir, "child.txt"))).toBe(dir)
  })

  test("resolves relative input before taking the dirname", () => {
    expect(parentDir("foo/bar.txt")).toBe(resolve(process.cwd(), "foo"))
  })
})

describe("writeFile / readFile round-trip", () => {
  test("writes then reads back identical content", async () => {
    const path = join(dir, "round.txt")
    await writeFile(path, "round-trip ✅ payload")
    expect(await readFile(path)).toBe("round-trip ✅ payload")
  })

  test("writeFile creates missing parent directories", async () => {
    const path = join(dir, "nested", "deep", "file.txt")
    await writeFile(path, "deep")
    expect(await readFile(path)).toBe("deep")
  })

  test("writeFile overwrites existing content", async () => {
    const path = join(dir, "over.txt")
    await writeFile(path, "first")
    await writeFile(path, "second")
    expect(await readFile(path)).toBe("second")
  })

  test("readFile rejects with a 'File not found' error for a missing file", async () => {
    const missing = join(dir, "nope.txt")
    await expect(readFile(missing)).rejects.toThrow(`File not found: ${missing}`)
  })

  test("a relative path is resolved against baseDir, not process.cwd()", async () => {
    await writeFile("rel.txt", "based", dir)
    expect(await fileExists("rel.txt", dir)).toBe(true)
    expect(await readFile("rel.txt", dir)).toBe("based")
    expect((await statFile("rel.txt", dir)).path).toBe(join(dir, "rel.txt"))
    expect(parentDir("sub/rel.txt", dir)).toBe(join(dir, "sub"))
    // The same relative name must NOT exist under process.cwd().
    expect(await fileExists("rel.txt")).toBe(false)
  })
})

describe("fileExists", () => {
  test("true for an existing file, false for a missing one", async () => {
    const path = join(dir, "exists.txt")
    await writeFile(path, "x")
    expect(await fileExists(path)).toBe(true)
    expect(await fileExists(join(dir, "absent.txt"))).toBe(false)
  })
})

describe("statFile", () => {
  test("reports absolute path, byte size, and non-directory for a file", async () => {
    const path = join(dir, "stat.txt")
    const content = "héllo" // multibyte → byte size differs from char length
    await writeFile(path, content)
    const info = await statFile(path)
    expect(info.path).toBe(path)
    expect(isAbsolute(info.path)).toBe(true)
    expect(info.size).toBe(Buffer.byteLength(content, "utf8"))
    expect(info.isDirectory).toBe(false)
  })

  test("isDirectory is true for a directory", async () => {
    const info = await statFile(dir)
    expect(info.isDirectory).toBe(true)
    expect(info.path).toBe(dir)
  })

  test("rejects for a non-existent path", async () => {
    await expect(statFile(join(dir, "ghost.txt"))).rejects.toThrow()
  })
})
