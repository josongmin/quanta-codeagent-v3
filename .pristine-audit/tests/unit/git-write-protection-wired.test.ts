/**
 * git-write-protection L3 WIRED-PATH coverage (ADR-0091).
 *
 * Proves the detector `gitWriteProtectReason` (`@/permission/git-write-guard`)
 * is actually ENFORCED at runtime through the `write`/`edit` tools via the
 * duck-typed `ToolContext.gitWriteGuard` seam — not merely defined (that is the
 * L2 state covered by `tests/unit/permission/git-write-guard.test.ts`).
 *
 * What is asserted (the L2→L3 promotion contract):
 *   - With the REAL `gitWriteProtectReason` wired into `ctx.gitWriteGuard`
 *     (exactly how `@/agent/dispatch.ts` wires it), a `write`/`edit` to
 *     `.git/hooks/pre-commit` and `.vscode/launch.json` is DENIED (`ok:false`)
 *     with a typed `permission_denied` failure and the model-facing
 *     `git-escape-vector denial` message.
 *   - A denied write performs NO filesystem mutation (hard-stop, never partial):
 *     the injected in-memory port's `writeFile` is never called.
 *   - An ordinary write to `src/index.ts` and `.gitignore` PASSES untouched.
 *   - Default-OFF: with NO `ctx.gitWriteGuard` wired, even a `.git/hooks/...`
 *     write proceeds (byte-identical legacy path) — proving the guard is the
 *     only thing that changed behavior, and only when wired.
 *
 * Uses an injected in-memory FileSystemPort so the test never touches a real
 * `.git` dir and can observe whether a write was attempted.
 */
import { describe, expect, test } from "bun:test"
import { gitWriteProtectReason } from "@/permission"
import type { FileInfo, FileSystemPort } from "@/storage"
import type { GitWriteGuard, ToolContext, ToolResult } from "@/tool"
import { makeEditTool } from "@/tool/edit"
import { makeWriteTool } from "@/tool/write"

/** In-memory FileSystemPort recording every write so a denied path can be
 *  proven to perform zero mutation. Seeded files support the edit read. */
const makeMemPort = (seed: Record<string, string> = {}) => {
  const files = new Map<string, string>(Object.entries(seed))
  const writes: string[] = []
  const port: FileSystemPort = {
    async readFile(path: string): Promise<string> {
      const v = files.get(path)
      if (v === undefined) throw new Error(`File not found: ${path}`)
      return v
    },
    async writeFile(path: string, content: string): Promise<void> {
      writes.push(path)
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

const ctx = (cwd: string, guard?: GitWriteGuard): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
  ...(guard !== undefined ? { gitWriteGuard: guard } : {}),
})

const drain = async (it: AsyncIterable<{ type: string; result?: ToolResult }>) => {
  let result: ToolResult | undefined
  for await (const ev of it) {
    if (ev.type === "result" && ev.result) result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

// The exact value `@/agent/dispatch.ts` wires into ctx.gitWriteGuard. Using the
// real detector (not a stub) is what makes this a WIRED-path proof.
const REAL_GUARD: GitWriteGuard = gitWriteProtectReason

describe("git-write-protection WIRED — write tool denies escape vectors", () => {
  const denied: ReadonlyArray<string> = [
    ".git/hooks/pre-commit",
    ".vscode/launch.json",
    ".git/config",
    ".git/config.worktree",
    ".git/info/attributes",
  ]

  test.each(
    denied.map((p) => [p] as const),
  )("write to %j is denied with a typed permission_denied failure and no mutation", async (path) => {
    const { port, writes } = makeMemPort()
    const tool = makeWriteTool(port)
    const r = await drain(tool.execute({ path, content: "x" } as never, ctx("/repo", REAL_GUARD)))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("git-escape-vector denial")
    expect(r.output).toContain(path)
    expect(r.failure).toEqual({ mode: "permission_denied", path })
    // Hard stop: a denied write must NEVER reach the filesystem port.
    expect(writes).toEqual([])
  })

  const allowed: ReadonlyArray<string> = ["src/index.ts", ".gitignore"]

  test.each(
    allowed.map((p) => [p] as const),
  )("write to %j passes (not an escape vector)", async (path) => {
    const { port, writes } = makeMemPort()
    const tool = makeWriteTool(port)
    const r = await drain(tool.execute({ path, content: "x" } as never, ctx("/repo", REAL_GUARD)))
    expect(r.ok).toBe(true)
    expect(r.failure).toBeUndefined()
    expect(writes).toEqual([path])
  })
})

describe("git-write-protection WIRED — edit tool denies escape vectors", () => {
  test("edit to .git/hooks/pre-commit is denied before the read (no mutation)", async () => {
    // Seed the target so a missing-file failure cannot be confused with the
    // guard deny — the guard must fire FIRST, before readFile.
    const { port, writes } = makeMemPort({ ".git/hooks/pre-commit": "#!/bin/sh\n" })
    const tool = makeEditTool(port)
    const r = await drain(
      tool.execute(
        { path: ".git/hooks/pre-commit", old_string: "sh", new_string: "bash" } as never,
        ctx("/repo", REAL_GUARD),
      ),
    )
    expect(r.ok).toBe(false)
    expect(r.output).toContain("git-escape-vector denial")
    expect(r.failure).toEqual({ mode: "permission_denied", path: ".git/hooks/pre-commit" })
    expect(writes).toEqual([])
  })

  test("edit to .vscode/launch.json is denied", async () => {
    const { port } = makeMemPort({ ".vscode/launch.json": "{}" })
    const tool = makeEditTool(port)
    const r = await drain(
      tool.execute(
        { path: ".vscode/launch.json", old_string: "{}", new_string: "{ }" } as never,
        ctx("/repo", REAL_GUARD),
      ),
    )
    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "permission_denied", path: ".vscode/launch.json" })
  })

  test("edit to a normal source file passes", async () => {
    const { port, writes } = makeMemPort({ "src/index.ts": "const a = 1" })
    const tool = makeEditTool(port)
    const r = await drain(
      tool.execute(
        { path: "src/index.ts", old_string: "1", new_string: "2" } as never,
        ctx("/repo", REAL_GUARD),
      ),
    )
    expect(r.ok).toBe(true)
    expect(writes).toEqual(["src/index.ts"])
  })
})

describe("git-write-protection WIRED — default-OFF when guard is absent", () => {
  test("write to .git/hooks/pre-commit PROCEEDS when ctx.gitWriteGuard is unwired", async () => {
    const { port, writes } = makeMemPort()
    const tool = makeWriteTool(port)
    // No guard injected → byte-identical legacy path (the L2 state).
    const r = await drain(
      tool.execute({ path: ".git/hooks/pre-commit", content: "x" } as never, ctx("/repo")),
    )
    expect(r.ok).toBe(true)
    expect(writes).toEqual([".git/hooks/pre-commit"])
  })
})
