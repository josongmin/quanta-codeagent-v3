// Red-first regression — [F4] FsJailFileSystemPort.writeFile must be ATOMIC.
//
// The audited defect: `FsJailFileSystemPort.writeFile` did a plain
// `this.fs.writeFile(resolved, content)` — a truncate-then-write that is NOT
// atomic. A crash / throw mid-write tears the file: a reader (or a later op in
// the SAME patch) can observe a zero-length / partial file under the FINAL
// name, and `apply_patch` had NO single-file atomic primitive at all (the
// "multi-file atomic patch" label is only op-level all-or-nothing, never byte-
// level durability for one file).
//
// SOTA++ fix (Codex / Claude Code write atomically): the port writes `content`
// to a unique temp sibling `<resolved>.quanta-tmp-<hex>` and then RENAMES it
// into place (POSIX rename is atomic on the same filesystem). The final path
// is therefore NEVER touched by a truncating write — a reader sees either the
// pre-bytes or the post-bytes, never a torn write.
//
// These assertions are driven through an INJECTED `NodeFsLike` fake that
// records every primitive call, so they pin the IMPLEMENTATION shape, not just
// the end state:
//   (a) the destination is committed via rename-FROM-a-temp, and NEVER via a
//       direct `writeFile` to the final resolved path;
//   (b) if `rename` throws, the final path is left untouched (no torn content)
//       AND the temp is cleaned up (best-effort `unlink`), then the error is
//       rethrown.
//
// On current direct-write code (a) and (b) BOTH fail: there is no temp, the
// write lands on the final path, and a rename never happens.

import { describe, expect, test } from "bun:test"
import { FsJailFileSystemPort, type NodeFsLike } from "@/tool/apply-patch"

const JAIL = "/jail"

type Op =
  | { kind: "mkdir"; path: string }
  | { kind: "writeFile"; path: string; content: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "unlink"; path: string }

/** In-memory NodeFsLike that records the ORDER + shape of every primitive so a
 *  test can assert the temp+rename algorithm — not just the final bytes. The
 *  `renameThrows` hook simulates a failed atomic commit (e.g. EACCES / EXDEV)
 *  to prove the original is left untouched and the temp is cleaned. */
const recordingFs = (
  opts: { seed?: Record<string, string>; renameThrows?: Error } = {},
): NodeFsLike & { ops: Op[]; files: Map<string, string> } => {
  const files = new Map<string, string>(Object.entries(opts.seed ?? {}))
  const ops: Op[] = []
  return {
    ops,
    files,
    async readFile(p) {
      const v = files.get(p)
      if (v === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" })
      return v
    },
    async writeFile(p, content) {
      ops.push({ kind: "writeFile", path: p, content })
      files.set(p, content)
    },
    async unlink(p) {
      ops.push({ kind: "unlink", path: p })
      files.delete(p)
    },
    async rename(from, to) {
      ops.push({ kind: "rename", from, to })
      if (opts.renameThrows !== undefined) throw opts.renameThrows
      const v = files.get(from)
      if (v === undefined) throw Object.assign(new Error(`ENOENT: ${from}`), { code: "ENOENT" })
      files.set(to, v)
      files.delete(from)
    },
    async mkdir(p) {
      ops.push({ kind: "mkdir", path: p })
      return undefined
    },
    async stat(p) {
      if (!files.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" })
      return { isFile: () => true, isDirectory: () => false }
    },
  }
}

describe("[F4] FsJailFileSystemPort.writeFile is atomic (temp + rename)", () => {
  test("commit goes through a temp sibling and a rename — NEVER a direct write to the final path", async () => {
    const fs = recordingFs()
    const port = new FsJailFileSystemPort({ jailRoot: JAIL, fs })
    await port.writeFile("out.txt", "final-bytes")

    const finalPath = `${JAIL}/out.txt`

    // (1) A rename committed the file.
    const rename = fs.ops.find((o): o is Extract<Op, { kind: "rename" }> => o.kind === "rename")
    expect(rename).toBeDefined()
    if (rename === undefined) return
    expect(rename.to).toBe(finalPath)
    // The rename SOURCE is a temp sibling of the final path (not the final path).
    expect(rename.from).not.toBe(finalPath)
    expect(rename.from.startsWith(`${finalPath}.`)).toBe(true)

    // (2) The bytes were written to that temp path, NOT to the final path.
    const writes = fs.ops.filter(
      (o): o is Extract<Op, { kind: "writeFile" }> => o.kind === "writeFile",
    )
    expect(writes.length).toBe(1)
    expect(writes[0]?.path).toBe(rename.from)
    expect(writes[0]?.content).toBe("final-bytes")

    // (3) THE TEETH: there is NO truncating write directly to the final path.
    // Current direct-write code fails here.
    expect(fs.ops.some((o) => o.kind === "writeFile" && o.path === finalPath)).toBe(false)

    // The write must happen BEFORE the rename (write-then-commit ordering).
    const writeIdx = fs.ops.findIndex((o) => o.kind === "writeFile")
    const renameIdx = fs.ops.findIndex((o) => o.kind === "rename")
    expect(writeIdx).toBeGreaterThanOrEqual(0)
    expect(renameIdx).toBeGreaterThan(writeIdx)

    // End state: final path holds the new bytes; no temp is left behind.
    expect(fs.files.get(finalPath)).toBe("final-bytes")
    expect([...fs.files.keys()].some((k) => k.startsWith(`${finalPath}.`))).toBe(false)
  })

  test("each write picks a DISTINCT temp suffix (crypto randomness, non-colliding)", async () => {
    const fs = recordingFs()
    const port = new FsJailFileSystemPort({ jailRoot: JAIL, fs })
    await port.writeFile("out.txt", "one")
    await port.writeFile("out.txt", "two")
    const renames = fs.ops.filter((o): o is Extract<Op, { kind: "rename" }> => o.kind === "rename")
    expect(renames.length).toBe(2)
    expect(renames[0]?.from).not.toBe(renames[1]?.from)
  })

  test("rename failure ⇒ final path UNTOUCHED (no torn write) + temp cleaned + rethrow", async () => {
    const finalPath = `${JAIL}/out.txt`
    const boom = Object.assign(new Error("rename boom"), { code: "EACCES" })
    const fs = recordingFs({ seed: { [finalPath]: "ORIGINAL" }, renameThrows: boom })
    const port = new FsJailFileSystemPort({ jailRoot: JAIL, fs })

    let thrown: unknown
    try {
      await port.writeFile("out.txt", "NEW-CONTENT")
    } catch (e) {
      thrown = e
    }

    // The original error is rethrown (never swallowed).
    expect(thrown).toBe(boom)

    // THE TEETH: the original file is byte-identical — the atomic rename never
    // touched it, so a failed commit cannot tear the committed file.
    expect(fs.files.get(finalPath)).toBe("ORIGINAL")

    // The temp file was cleaned up (best-effort unlink) after the failed rename.
    expect([...fs.files.keys()].some((k) => k.startsWith(`${finalPath}.`))).toBe(false)
    const rename = fs.ops.find((o): o is Extract<Op, { kind: "rename" }> => o.kind === "rename")
    expect(rename).toBeDefined()
    const unlink = fs.ops.find((o): o is Extract<Op, { kind: "unlink" }> => o.kind === "unlink")
    expect(unlink).toBeDefined()
    // The unlinked path is exactly the temp the failed rename tried to promote.
    expect(unlink?.path).toBe(rename?.from)

    // The final path was NEVER the target of a direct write.
    expect(fs.ops.some((o) => o.kind === "writeFile" && o.path === finalPath)).toBe(false)
  })

  test("parent directory is mkdir'd before the write (unchanged behavior)", async () => {
    const fs = recordingFs()
    const port = new FsJailFileSystemPort({ jailRoot: JAIL, fs })
    await port.writeFile("nested/dir/out.txt", "x")
    const mkdir = fs.ops.find((o): o is Extract<Op, { kind: "mkdir" }> => o.kind === "mkdir")
    expect(mkdir).toBeDefined()
    expect(mkdir?.path).toBe(`${JAIL}/nested/dir`)
    // mkdir precedes the write.
    const mkdirIdx = fs.ops.findIndex((o) => o.kind === "mkdir")
    const writeIdx = fs.ops.findIndex((o) => o.kind === "writeFile")
    expect(mkdirIdx).toBeGreaterThanOrEqual(0)
    expect(writeIdx).toBeGreaterThan(mkdirIdx)
  })

  test("an fs fake WITHOUT fsync degrades gracefully (still atomic, no throw)", async () => {
    // The recording fake deliberately has no `fsync` member; the port must not
    // assume it exists. The write still commits via temp + rename.
    const fs = recordingFs()
    expect((fs as unknown as { fsync?: unknown }).fsync).toBeUndefined()
    const port = new FsJailFileSystemPort({ jailRoot: JAIL, fs })
    await port.writeFile("out.txt", "ok")
    expect(fs.files.get(`${JAIL}/out.txt`)).toBe("ok")
  })

  // [F4 follow-up] adversarial-verify finding: the atomic temp+rename creates a
  // FRESH inode with default perms, so an existing executable would silently lose
  // its mode. Driven through the REAL defaultNodeFs (no injected `fs`) against a
  // temp dir, because file mode is an OS concept the in-memory fake has no notion
  // of. RED before the chmod-on-temp fix (file landed 0o644); green after.
  test("preserves the ORIGINAL file mode across the atomic write (no silent 0o755→0o644 drop)", async () => {
    const os = await import("node:os")
    const path = await import("node:path")
    const fsp = await import("node:fs/promises")
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "f4-mode-"))
    try {
      const file = path.join(dir, "script.sh")
      await fsp.writeFile(file, "echo old\n", "utf8")
      await fsp.chmod(file, 0o755)
      // Real port (no injected fs ⇒ real defaultNodeFs incl. chmod), jailed at dir.
      const port = new FsJailFileSystemPort({ jailRoot: dir })
      await port.writeFile("script.sh", "echo new\n")
      // Content updated AND the executable bits survived the temp+rename.
      expect(await fsp.readFile(file, "utf8")).toBe("echo new\n")
      const st = await fsp.stat(file)
      expect(st.mode & 0o777).toBe(0o755)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  // A brand-new file (no original) keeps default perms — byte-identical to the
  // pre-atomic direct write; the mode-preservation path must not force any mode.
  test("a NEW file is created with default perms (mode preservation is a no-op without an original)", async () => {
    const os = await import("node:os")
    const path = await import("node:path")
    const fsp = await import("node:fs/promises")
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "f4-new-"))
    try {
      const port = new FsJailFileSystemPort({ jailRoot: dir })
      await port.writeFile("fresh.txt", "hi")
      const created = path.join(dir, "fresh.txt")
      expect(await fsp.readFile(created, "utf8")).toBe("hi")
      // It is a regular readable/writable file; we do not pin an exact mode
      // (umask-dependent) — only that no executable bit was spuriously added.
      const st = await fsp.stat(dir + "/fresh.txt")
      expect(st.mode & 0o111).toBe(0)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
})
