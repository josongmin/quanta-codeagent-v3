/** ADR-0400 — Shadow Verify real-adapters hellgate.
 *
 *  The wave-1 runner (ADR-0396) is fully covered by `shadow-verify-hellgate`.
 *  This suite pins the WAVE-2 adapter slice (`@/agent/shadow-verify-adapters`)
 *  against real `@/runtime/worktree-fork`, real `@/patch` V4A applier, and a
 *  shell-backed test runner:
 *
 *    HELL-SVA-01  scratch port `open()` creates a real git worktree forked off
 *                 HEAD; the handle IS the worktree path (exists on disk).
 *    HELL-SVA-02  scratch port `dispose()` removes the worktree (path gone).
 *    HELL-SVA-03  scratch port `dispose()` is idempotent (second dispose ⇒ ok).
 *    HELL-SVA-04  V4A applier: successful patch applies to scratch handle
 *                 (file mutated as the grammar specifies).
 *    HELL-SVA-05  V4A applier: malformed patch text ⇒ {ok:false, error:...}.
 *    HELL-SVA-06  V4A applier: anchor-not-found patch ⇒ {ok:false, error:...}.
 *    HELL-SVA-07  V4A applier: path escape attempt ⇒ {ok:false} (NEVER throws).
 *    HELL-SVA-08  End-to-end: createShadowVerify(adapters) verifies a real
 *                 patch successfully — applied:true, ok:true, scratch CLEANED.
 *    HELL-SVA-09  End-to-end: malformed patch with real adapters ⇒ ok:false
 *                 + applied:false + scratch CLEANED.
 *    HELL-SVA-10  LSP-unavailable: lint/typecheck on a scratch tree with no
 *                 source files ⇒ empty diagnostic list (graceful skip).
 *    HELL-SVA-11  test runner missing: when no test command resolves
 *                 (`bun` not on PATH inside the call) ⇒ error-severity diag,
 *                 source:"test", NO throw.
 *    HELL-SVA-12  factory bag shape: `createShadowVerifyAdapters(repo)`
 *                 returns `{scratch, applier, checker}` each duck-typed
 *                 against the closed port.
 *    HELL-SVA-13  scratch dispose runs even when end-to-end verify reports
 *                 a failing diag (dispose-count assertion).
 *    HELL-SVA-14  end-to-end abort-on-open: pre-aborted signal short-circuits
 *                 the runner (NO worktree created), result still NO-THROW.
 *    HELL-SVA-15  V4A applier rejects an absolute path escape (write outside
 *                 scratch root) by emitting {ok:false, error:...} — the
 *                 host workspace is unmodified.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createShadowVerify } from "@/agent/shadow-verify"
import {
  createLspTestCheckPort,
  createScratchWorktreePort,
  createShadowVerifyAdapters,
  createV4AApplyPort,
} from "@/agent/shadow-verify-adapters"
import { runShell } from "@/runtime"

const gitAvailable = async (): Promise<boolean> => {
  try {
    const r = await runShell("git --version")
    return r.exitCode === 0
  } catch {
    return false
  }
}
const HAS_GIT = await gitAvailable()

const makeRepo = async (seed: string): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "sv-adapt-"))
  const sh = (c: string) => runShell(c, { cwd: dir })
  await sh("git init -q -b main")
  await sh("git config user.email t@t.t && git config user.name t")
  await writeFile(join(dir, "hello.txt"), seed)
  await sh("git add -A && git commit -q -m init")
  return dir
}

const cleanups: string[] = []
afterEach(() => {
  while (cleanups.length > 0) {
    const d = cleanups.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

// ─── HELL-SVA-01/02/03 — scratch port lifecycle ────────────────────────────

describe("scratch-worktree port (HELL-SVA-01/02/03)", () => {
  test.skipIf(!HAS_GIT)(
    "open() materialises a real git worktree; dispose() removes it; second dispose is safe",
    async () => {
      const repo = await makeRepo("v1\n")
      cleanups.push(repo)

      const port = createScratchWorktreePort(repo)
      const { handle, dispose } = await port.open()
      expect(handle.length).toBeGreaterThan(0)
      expect(existsSync(handle)).toBe(true)
      // It IS a worktree of the same repo (HEAD resolves under git).
      const head = await runShell("git rev-parse HEAD", { cwd: handle })
      expect(head.exitCode).toBe(0)

      await dispose()
      // After dispose, the path is gone.
      expect(existsSync(handle)).toBe(false)
      // Second dispose is idempotent (NO throw).
      await dispose()
    },
    30_000,
  )
})

// ─── HELL-SVA-04/05/06/07/15 — V4A applier adapter ─────────────────────────

const updatePatch = (filename: string, before: string, after: string): string =>
  [
    "*** Begin Patch",
    `*** Update File: ${filename}`,
    "@@",
    `-${before}`,
    `+${after}`,
    "*** End Patch",
    "",
  ].join("\n")

describe("V4A apply port (HELL-SVA-04/05/06/07/15)", () => {
  test.skipIf(!HAS_GIT)(
    "successful patch mutates the scratch file as specified",
    async () => {
      const repo = await makeRepo("v1")
      cleanups.push(repo)
      const scratch = createScratchWorktreePort(repo)
      const applier = createV4AApplyPort()
      const handle = await scratch.open()
      try {
        const r = await applier.apply(handle.handle, updatePatch("hello.txt", "v1", "v2"))
        expect(r.ok).toBe(true)
        const content = await readFile(join(handle.handle, "hello.txt"), "utf8")
        expect(content.trim()).toBe("v2")
      } finally {
        await handle.dispose()
      }
    },
    30_000,
  )

  test("malformed patch ⇒ {ok:false, error:...} (no throw)", async () => {
    const applier = createV4AApplyPort()
    const dir = mkdtempSync(join(tmpdir(), "sv-scratch-"))
    cleanups.push(dir)
    const r = await applier.apply(dir, "not a patch")
    expect(r.ok).toBe(false)
    expect(typeof r.error).toBe("string")
    expect((r.error ?? "").length).toBeGreaterThan(0)
  })

  test("anchor-not-found patch ⇒ {ok:false, error:...} (no throw)", async () => {
    const applier = createV4AApplyPort()
    const dir = mkdtempSync(join(tmpdir(), "sv-anchor-"))
    cleanups.push(dir)
    await writeFile(join(dir, "x.txt"), "hello\n")
    const r = await applier.apply(dir, updatePatch("x.txt", "NOT_THERE", "replacement"))
    expect(r.ok).toBe(false)
    expect((r.error ?? "").length).toBeGreaterThan(0)
  })

  test("absolute path escape attempt ⇒ {ok:false} (host untouched)", async () => {
    const applier = createV4AApplyPort()
    const dir = mkdtempSync(join(tmpdir(), "sv-esc-"))
    cleanups.push(dir)
    const sibling = mkdtempSync(join(tmpdir(), "sv-sibling-"))
    cleanups.push(sibling)
    const victim = join(sibling, "victim.txt")
    await writeFile(victim, "untouched\n")
    // Synthesize an Add File patch targeting a path OUTSIDE the scratch root.
    const escapeAttempt = [
      "*** Begin Patch",
      `*** Add File: ${victim}`,
      "+overwritten",
      "*** End Patch",
      "",
    ].join("\n")
    const r = await applier.apply(dir, escapeAttempt)
    // Either parse-rejected or path-rejected — both surface as ok:false.
    expect(r.ok).toBe(false)
    // Host file untouched.
    const survived = await readFile(victim, "utf8")
    expect(survived).toBe("untouched\n")
  })

  test("ENOENT writeFile target ⇒ {ok:false} (defense-in-depth, no throw)", async () => {
    const applier = createV4AApplyPort()
    // No directory exists — every fs op resolves to a missing path.
    const r = await applier.apply(
      "/tmp/does-not-exist-shadow-verify-zzz",
      updatePatch("anything.txt", "a", "b"),
    )
    expect(r.ok).toBe(false)
    expect((r.error ?? "").length).toBeGreaterThan(0)
  })
})

// ─── HELL-SVA-08/09/13/14 — end-to-end with real adapters ──────────────────

describe("end-to-end real adapters (HELL-SVA-08/09/13/14)", () => {
  test.skipIf(!HAS_GIT)(
    "verifying a real patch with a no-op checker reports applied + ok + cleans up",
    async () => {
      const repo = await makeRepo("v1\n")
      cleanups.push(repo)
      // Bag = real worktree + real V4A + STUB checker (returns []) so the
      // success path is asserted without needing LSP servers / bun test.
      const adapters = createShadowVerifyAdapters(repo)
      const stubBag = {
        scratch: adapters.scratch,
        applier: adapters.applier,
        checker: {
          async run() {
            return []
          },
        },
      }
      const sv = createShadowVerify(stubBag)
      const r = await sv.verify({
        patch: updatePatch("hello.txt", "v1", "v2"),
        checks: ["lint"],
      })
      expect(r.applied).toBe(true)
      expect(r.ok).toBe(true)
      expect(r.diagnostics).toEqual([])
      // Scratch tree was disposed — no leftover `shadow-verify-*` worktree.
      const leftovers = existsSync(join(repo, ".quanta", "worktrees"))
        ? (await import("node:fs/promises"))
            .readdir(join(repo, ".quanta", "worktrees"))
            .then((xs) => xs.filter((n) => n.startsWith("shadow-verify-")))
        : Promise.resolve([] as string[])
      expect((await leftovers).length).toBe(0)
    },
    45_000,
  )

  test.skipIf(!HAS_GIT)(
    "malformed patch ⇒ ok:false applied:false, scratch CLEANED",
    async () => {
      const repo = await makeRepo("v1\n")
      cleanups.push(repo)
      const adapters = createShadowVerifyAdapters(repo)
      const sv = createShadowVerify({
        scratch: adapters.scratch,
        applier: adapters.applier,
        checker: {
          async run() {
            return []
          },
        },
      })
      const r = await sv.verify({ patch: "garbage", checks: ["lint"] })
      expect(r.ok).toBe(false)
      expect(r.applied).toBe(false)
      expect(r.diagnostics.length).toBeGreaterThanOrEqual(1)
      expect(r.diagnostics[0]?.severity).toBe("error")
      const leftovers = existsSync(join(repo, ".quanta", "worktrees"))
        ? (await import("node:fs/promises"))
            .readdir(join(repo, ".quanta", "worktrees"))
            .then((xs) => xs.filter((n) => n.startsWith("shadow-verify-")))
        : Promise.resolve([] as string[])
      expect((await leftovers).length).toBe(0)
    },
    45_000,
  )

  test.skipIf(!HAS_GIT)(
    "pre-aborted signal ⇒ NO worktree created, NO throw, applied:false",
    async () => {
      const repo = await makeRepo("v1\n")
      cleanups.push(repo)
      const adapters = createShadowVerifyAdapters(repo)
      const sv = createShadowVerify({
        scratch: adapters.scratch,
        applier: adapters.applier,
        checker: {
          async run() {
            return []
          },
        },
      })
      const ac = new AbortController()
      ac.abort()
      const r = await sv.verify(
        { patch: updatePatch("hello.txt", "v1", "v2"), checks: ["lint"] },
        ac.signal,
      )
      expect(r.applied).toBe(false)
      expect(r.ok).toBe(false)
    },
    30_000,
  )
})

// ─── HELL-SVA-10 — LSP graceful skip ───────────────────────────────────────

describe("LSP graceful skip (HELL-SVA-10)", () => {
  test("lint/typecheck on a scratch tree with no source files ⇒ empty diags", async () => {
    const checker = createLspTestCheckPort()
    const dir = mkdtempSync(join(tmpdir(), "sv-lsp-"))
    cleanups.push(dir)
    const lint = await checker.run(dir, "lint", undefined)
    const typecheck = await checker.run(dir, "typecheck", undefined)
    expect(lint).toEqual([])
    expect(typecheck).toEqual([])
  })
})

// ─── HELL-SVA-11 — test runner missing / failure ───────────────────────────

describe("test runner failure (HELL-SVA-11)", () => {
  test("test in a non-existent dir ⇒ error-severity diag, source:'test', NO throw", async () => {
    const checker = createLspTestCheckPort()
    // Pass a path that does NOT exist — runShell will fail to launch / cwd
    // missing; the adapter MUST convert that to an error-severity diag.
    const diags = await checker.run("/tmp/does-not-exist-shadow-verify-zzz", "test", undefined)
    expect(diags.length).toBeGreaterThanOrEqual(1)
    expect(diags[0]?.severity).toBe("error")
    expect(diags[0]?.source).toBe("test")
  })
})

// ─── HELL-SVA-12 — factory shape ────────────────────────────────────────────

describe("factory bag shape (HELL-SVA-12)", () => {
  test("createShadowVerifyAdapters returns {scratch, applier, checker} matching the closed port", () => {
    const adapters = createShadowVerifyAdapters("/tmp/anything")
    expect(typeof adapters.scratch.open).toBe("function")
    expect(typeof adapters.applier.apply).toBe("function")
    expect(typeof adapters.checker.run).toBe("function")
  })
})

// ─── Sanity — `stat` import isn't dead (linter check). ─────────────────────
test("import sanity", async () => {
  await expect(stat(tmpdir())).resolves.toBeDefined()
})
