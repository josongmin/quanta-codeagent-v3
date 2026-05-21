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
import { PatchAnchorNotFoundError, PatchApplyError, PatchParseError } from "@/patch"
import type { ToolContext, ToolResult } from "@/tool"
import { applyPatchTool, FsJailFileSystemPort, FsJailViolationError } from "@/tool/apply-patch"

// ---------------------------------------------------------------------------
// Shared scratch tmpdir. Each block carves a fresh subdir via `tmpSub`.
// ---------------------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "apply-patch-unit-"))
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

/** Drive the tool generator and capture either the terminal result OR the
 *  thrown error. Spec requires that named errors propagate — so we test the
 *  throw path explicitly, not an ok:false channel. */
const run = async (input: unknown, cwd: string): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of applyPatchTool.execute(input as never, ctx(cwd))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

// ===========================================================================
// FsJailFileSystemPort — the boundary-checking concrete port.
// ===========================================================================
describe("FsJailFileSystemPort — constructor invariants", () => {
  test("rejects an empty jailRoot", () => {
    expect(() => new FsJailFileSystemPort({ jailRoot: "" })).toThrow(/non-empty jailRoot/)
  })

  test("rejects a non-absolute jailRoot", () => {
    expect(() => new FsJailFileSystemPort({ jailRoot: "relative/dir" })).toThrow(
      /absolute jailRoot/,
    )
  })

  test("accepts an absolute jailRoot", () => {
    const dir = tmpSub("ctor-ok")
    const port = new FsJailFileSystemPort({ jailRoot: dir })
    expect(port).toBeInstanceOf(FsJailFileSystemPort)
  })
})

describe("FsJailFileSystemPort — in-jail happy path", () => {
  test("writeFile + readFile round-trip on an in-jail relative path", async () => {
    const dir = tmpSub("happy-rw")
    const port = new FsJailFileSystemPort({ jailRoot: dir })
    await port.writeFile("note.txt", "hello")
    expect(await port.readFile("note.txt")).toBe("hello")
    expect(readFileSync(join(dir, "note.txt"), "utf8")).toBe("hello")
  })

  test("writeFile creates nested parent directories", async () => {
    const dir = tmpSub("happy-mkdir")
    const port = new FsJailFileSystemPort({ jailRoot: dir })
    await port.writeFile("deep/sub/leaf.txt", "x")
    expect(readFileSync(join(dir, "deep/sub/leaf.txt"), "utf8")).toBe("x")
  })

  test("deleteFile removes an in-jail file", async () => {
    const dir = tmpSub("happy-delete")
    writeFileSync(join(dir, "doomed.txt"), "")
    const port = new FsJailFileSystemPort({ jailRoot: dir })
    await port.deleteFile("doomed.txt")
    expect(existsSync(join(dir, "doomed.txt"))).toBe(false)
  })

  test("renameFile moves an in-jail file", async () => {
    const dir = tmpSub("happy-rename")
    writeFileSync(join(dir, "src.txt"), "body")
    const port = new FsJailFileSystemPort({ jailRoot: dir })
    await port.renameFile("src.txt", "renamed/dst.txt")
    expect(existsSync(join(dir, "src.txt"))).toBe(false)
    expect(readFileSync(join(dir, "renamed/dst.txt"), "utf8")).toBe("body")
  })

  test("exists() returns true / false correctly inside the jail", async () => {
    const dir = tmpSub("happy-exists")
    writeFileSync(join(dir, "there.txt"), "")
    const port = new FsJailFileSystemPort({ jailRoot: dir })
    expect(await port.exists("there.txt")).toBe(true)
    expect(await port.exists("ghost.txt")).toBe(false)
  })
})

describe("FsJailFileSystemPort — jail violations throw FsJailViolationError", () => {
  test("absolute path outside the jail is rejected on readFile", async () => {
    const dir = tmpSub("violate-abs")
    const port = new FsJailFileSystemPort({ jailRoot: dir })
    await expect(port.readFile("/etc/hosts")).rejects.toBeInstanceOf(FsJailViolationError)
  })

  test("relative climb above the jail is rejected on readFile", async () => {
    const dir = tmpSub("violate-rel")
    const port = new FsJailFileSystemPort({ jailRoot: dir })
    await expect(port.readFile("../../etc/passwd")).rejects.toBeInstanceOf(FsJailViolationError)
  })

  test("relative climb above the jail is rejected on writeFile (no bytes written)", async () => {
    const dir = tmpSub("violate-write")
    const port = new FsJailFileSystemPort({ jailRoot: dir })
    // Compose a target that lexically resolves outside the jail.
    const escapeTarget = `../escape-${Date.now()}.txt`
    await expect(port.writeFile(escapeTarget, "x")).rejects.toBeInstanceOf(FsJailViolationError)
    expect(existsSync(join(dir, "..", escapeTarget))).toBe(false)
  })

  test("symlink pointing outside the jail is rejected", async () => {
    const dir = tmpSub("violate-symlink")
    const outside = mkdtempSync(join(tmpdir(), "apply-patch-outside-"))
    writeFileSync(join(outside, "secret.txt"), "TOP")
    symlinkSync(outside, join(dir, "escape-link"))
    const port = new FsJailFileSystemPort({ jailRoot: dir })
    await expect(port.readFile("escape-link/secret.txt")).rejects.toBeInstanceOf(
      FsJailViolationError,
    )
    rmSync(outside, { recursive: true, force: true })
  })

  test("NUL byte in path is rejected before any I/O", async () => {
    const dir = tmpSub("violate-nul")
    const port = new FsJailFileSystemPort({ jailRoot: dir })
    await expect(port.readFile("ok\0evil.txt")).rejects.toBeInstanceOf(FsJailViolationError)
  })

  test("empty path is rejected", async () => {
    const dir = tmpSub("violate-empty")
    const port = new FsJailFileSystemPort({ jailRoot: dir })
    await expect(port.readFile("")).rejects.toBeInstanceOf(FsJailViolationError)
  })

  test("rename destination outside the jail is rejected (source untouched)", async () => {
    const dir = tmpSub("violate-rename-dst")
    writeFileSync(join(dir, "src.txt"), "body")
    const port = new FsJailFileSystemPort({ jailRoot: dir })
    await expect(port.renameFile("src.txt", "../escape.txt")).rejects.toBeInstanceOf(
      FsJailViolationError,
    )
    // Source intact.
    expect(readFileSync(join(dir, "src.txt"), "utf8")).toBe("body")
  })

  test("delete on an out-of-jail path is rejected", async () => {
    const dir = tmpSub("violate-delete")
    const port = new FsJailFileSystemPort({ jailRoot: dir })
    await expect(port.deleteFile("/etc/passwd")).rejects.toBeInstanceOf(FsJailViolationError)
  })

  test("the sibling '/tmp/jailX' cannot pass a '/tmp/jail' root (separator boundary)", async () => {
    // Create two siblings with overlapping prefixes. The naive `startsWith`
    // without a trailing separator would accept the sibling.
    const base = mkdtempSync(join(tmpdir(), "boundary-"))
    const jail = join(base, "jail")
    const sibling = join(base, "jailX")
    mkdirSync(jail, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, "leak.txt"), "LEAK")
    const port = new FsJailFileSystemPort({ jailRoot: jail })
    await expect(port.readFile(join(sibling, "leak.txt"))).rejects.toBeInstanceOf(
      FsJailViolationError,
    )
    rmSync(base, { recursive: true, force: true })
  })

  test("FsJailViolationError carries attemptedPath + jailRoot fields", async () => {
    const dir = tmpSub("violate-fields")
    const port = new FsJailFileSystemPort({ jailRoot: dir })
    try {
      await port.readFile("/etc/hosts")
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(FsJailViolationError)
      const err = e as FsJailViolationError
      expect(err.attemptedPath).toBe("/etc/hosts")
      expect(err.jailRoot).toBe(dir)
      expect(err.name).toBe("FsJailViolationError")
    }
  })
})

// ===========================================================================
// applyPatchTool — input schema + wiring.
// ===========================================================================
describe("applyPatchTool — metadata + schema", () => {
  test("metadata: name, not read-only, not concurrency-safe, pre-approval-ok", () => {
    expect(applyPatchTool.name).toBe("apply_patch")
    expect(applyPatchTool.isReadOnly()).toBe(false)
    expect(applyPatchTool.isConcurrencySafe({ patch: "" })).toBe(false)
    expect(applyPatchTool.hitlTier?.({ patch: "" })).toBe("pre-approval-ok")
  })

  test("schema rejects missing 'patch'", () => {
    expect(applyPatchTool.inputSchema.safeParse({}).success).toBe(false)
  })

  test("schema rejects a non-string 'patch'", () => {
    expect(applyPatchTool.inputSchema.safeParse({ patch: 42 }).success).toBe(false)
  })
})

describe("applyPatchTool — happy path", () => {
  test("applies an Add op end-to-end and surfaces summary text", async () => {
    const dir = tmpSub("tool-add")
    const patch = [
      "*** Begin Patch",
      "*** Add File: hello.txt",
      "+greetings",
      "*** End Patch",
    ].join("\n")
    const r = await run({ patch }, dir)
    expect(r.ok).toBe(true)
    expect(r.output).toContain("added: hello.txt")
    expect(readFileSync(join(dir, "hello.txt"), "utf8")).toBe("greetings")
  })

  test("applies an Update op", async () => {
    const dir = tmpSub("tool-update")
    writeFileSync(join(dir, "f.txt"), "alpha\nbeta\n")
    const patch = [
      "*** Begin Patch",
      "*** Update File: f.txt",
      "@@",
      "-beta",
      "+BETA",
      "*** End Patch",
    ].join("\n")
    const r = await run({ patch }, dir)
    expect(r.ok).toBe(true)
    expect(r.output).toContain("updated: f.txt")
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("alpha\nBETA\n")
  })
})

// ===========================================================================
// applyPatchTool — error propagation (NEVER caught silently).
// ===========================================================================
describe("applyPatchTool — error propagation", () => {
  test("PatchParseError from parsePatch propagates", async () => {
    const dir = tmpSub("err-parse")
    // Missing 'Begin Patch'.
    const patch = "*** Add File: x.txt\n+nope\n*** End Patch\n"
    await expect(run({ patch }, dir)).rejects.toBeInstanceOf(PatchParseError)
  })

  test("PatchAnchorNotFoundError propagates when context cannot be located", async () => {
    const dir = tmpSub("err-anchor")
    writeFileSync(join(dir, "f.txt"), "alpha\nbeta\n")
    const patch = [
      "*** Begin Patch",
      "*** Update File: f.txt",
      "@@",
      " unrelated context",
      "-not-present",
      "+replacement",
      "*** End Patch",
    ].join("\n")
    await expect(run({ patch }, dir)).rejects.toBeInstanceOf(PatchAnchorNotFoundError)
  })

  test("PatchApplyError propagates when an Add target already exists", async () => {
    const dir = tmpSub("err-apply-exists")
    writeFileSync(join(dir, "already.txt"), "")
    const patch = [
      "*** Begin Patch",
      "*** Add File: already.txt",
      "+new content",
      "*** End Patch",
    ].join("\n")
    await expect(run({ patch }, dir)).rejects.toBeInstanceOf(PatchApplyError)
  })

  test("FsJailViolationError propagates when a patch Add references an out-of-jail path", async () => {
    const dir = tmpSub("err-jail-add")
    const patch = [
      "*** Begin Patch",
      "*** Add File: ../escape.txt",
      "+pwned",
      "*** End Patch",
    ].join("\n")
    await expect(run({ patch }, dir)).rejects.toBeInstanceOf(FsJailViolationError)
    expect(existsSync(join(dir, "..", "escape.txt"))).toBe(false)
  })

  test("FsJailViolationError on an absolute-path patch op (no file written)", async () => {
    const dir = tmpSub("err-jail-abs")
    const target = "/tmp/v4a-should-never-exist.txt"
    const patch = ["*** Begin Patch", `*** Add File: ${target}`, "+x", "*** End Patch"].join("\n")
    await expect(run({ patch }, dir)).rejects.toBeInstanceOf(FsJailViolationError)
    expect(existsSync(target)).toBe(false)
  })

  test("FsJailViolationError on Move-to destination that escapes the jail", async () => {
    const dir = tmpSub("err-jail-move")
    writeFileSync(join(dir, "src.txt"), "body\n")
    const patch = [
      "*** Begin Patch",
      "*** Update File: src.txt",
      "*** Move to: ../escape.txt",
      "@@",
      "-body",
      "+BODY",
      "*** End Patch",
    ].join("\n")
    await expect(run({ patch }, dir)).rejects.toBeInstanceOf(FsJailViolationError)
    // Source untouched (pre-flight `exists` against the destination already
    // throws before any write).
    expect(readFileSync(join(dir, "src.txt"), "utf8")).toBe("body\n")
  })
})
