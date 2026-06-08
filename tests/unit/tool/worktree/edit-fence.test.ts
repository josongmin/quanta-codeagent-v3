/**
 * ticket-11 (P8) — bash/edit edit-fence integration + default-OFF byte-identical.
 *
 * Drives the REAL `bash` and `edit` tools with/without an active worktree to
 * prove:
 *   - default-OFF: no `activeWorktree` on ctx ⇒ cwd unchanged (relative write
 *     lands in the session cwd, exactly as today).
 *   - active worktree: a RELATIVE bash command + a RELATIVE edit land inside the
 *     worktree dir; an ABSOLUTE edit still jails to the SESSION root.
 *   - the tool registration is NOT affected — these are the same tool objects
 *     either way (the gate only adds/omits the `activeWorktree` ctx field).
 */

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ActiveWorktree, ToolContext, ToolEvent, ToolResult } from "@/tool"
import { bashTool } from "@/tool/bash"
import { editTool } from "@/tool/edit"
import { readTool } from "@/tool/read"

const dirs: string[] = []
const makeDir = async (label: string): Promise<string> => {
  const d = await mkdtemp(path.join(tmpdir(), `wt-fence-${label}-`))
  dirs.push(d)
  return d
}

/** Production layout: the worktree lives UNDER the session dir
 *  (`<session>/.quanta/worktrees/wt`), so it is inside the session FS jail. The
 *  edit-fence invariant (relative→worktree, absolute→session) only makes sense
 *  for this layout — a worktree OUTSIDE the session jail is (correctly) refused
 *  by the storage jail. */
const makeSessionWithWorktree = async (
  label: string,
): Promise<{ session: string; worktree: string }> => {
  const session = await makeDir(label)
  const worktree = path.join(session, ".quanta", "worktrees", "wt")
  await mkdir(worktree, { recursive: true })
  return { session, worktree }
}

const ctx = (sessionCwd: string, active?: ActiveWorktree): ToolContext => ({
  cwd: sessionCwd,
  signal: new AbortController().signal,
  ...(active !== undefined ? { activeWorktree: active } : {}),
})

const drain = async (
  tool: { execute: (i: never, c: ToolContext) => AsyncIterable<ToolEvent> },
  input: unknown,
  c: ToolContext,
): Promise<ToolResult> => {
  let r: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c)) {
    if (ev.type === "result") r = ev.result
  }
  if (!r) throw new Error("no terminal result")
  return r
}

const activeFor = (session: string, worktree: string): ActiveWorktree => ({
  worktreePath: worktree,
  branch: "fork-test",
  isPersistent: true,
  repoRoot: session,
  branchFrom: "head",
})

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => undefined)
})

describe("bash edit-fence", () => {
  test("DEFAULT-OFF: no active worktree ⇒ bash runs in the session cwd", async () => {
    const session = await makeDir("bash-off")
    const r = await drain(bashTool, { command: "pwd" }, ctx(session))
    expect(r.ok).toBe(true)
    // bash -lc pwd prints the spawn cwd; with no worktree it is the session cwd.
    expect(r.output).toContain(session)
  })

  test("active worktree ⇒ a RELATIVE bash command runs INSIDE the worktree", async () => {
    const { session, worktree } = await makeSessionWithWorktree("bash-on")
    const r = await drain(
      bashTool,
      { command: "pwd && echo hi > rel.txt" },
      ctx(session, activeFor(session, worktree)),
    )
    expect(r.ok).toBe(true)
    expect(r.output).toContain(worktree)
    // the relative write landed in the worktree, NOT the session cwd.
    expect(existsSync(path.join(worktree, "rel.txt"))).toBe(true)
    expect(existsSync(path.join(session, "rel.txt"))).toBe(false)
  })
})

describe("edit edit-fence", () => {
  test("DEFAULT-OFF: no active worktree ⇒ edit resolves against the session cwd", async () => {
    const session = await makeDir("edit-off")
    await writeFile(path.join(session, "f.txt"), "alpha\n")
    const r = await drain(
      editTool,
      { path: "f.txt", old_string: "alpha", new_string: "beta" },
      ctx(session),
    )
    expect(r.ok).toBe(true)
    expect(await readFile(path.join(session, "f.txt"), "utf8")).toBe("beta\n")
  })

  test("active worktree ⇒ a RELATIVE edit lands inside the WORKTREE", async () => {
    const { session, worktree } = await makeSessionWithWorktree("edit-on")
    // The SAME relative filename exists in BOTH dirs with DIFFERENT content; the
    // edit must touch the WORKTREE copy, proving the relative-cwd override.
    await writeFile(path.join(session, "shared.txt"), "session-original\n")
    await writeFile(path.join(worktree, "shared.txt"), "worktree-original\n")
    const r = await drain(
      editTool,
      { path: "shared.txt", old_string: "worktree-original", new_string: "worktree-edited" },
      ctx(session, activeFor(session, worktree)),
    )
    expect(r.ok).toBe(true)
    expect(await readFile(path.join(worktree, "shared.txt"), "utf8")).toBe("worktree-edited\n")
    // the session copy is UNTOUCHED.
    expect(await readFile(path.join(session, "shared.txt"), "utf8")).toBe("session-original\n")
  })

  // RED-ON-INJECTION: an ABSOLUTE path must STILL jail to the SESSION root, never
  // be re-based onto the worktree. We edit a file by its ABSOLUTE session path
  // while a worktree is active — it must edit the SESSION file.
  test("active worktree ⇒ an ABSOLUTE edit STILL targets the SESSION jail", async () => {
    const { session, worktree } = await makeSessionWithWorktree("edit-abs")
    await writeFile(path.join(session, "abs.txt"), "abs-original\n")
    const abs = path.join(session, "abs.txt")
    const r = await drain(
      editTool,
      { path: abs, old_string: "abs-original", new_string: "abs-edited" },
      ctx(session, activeFor(session, worktree)),
    )
    expect(r.ok).toBe(true)
    // the absolute path resolved to the SESSION file, not the worktree.
    expect(await readFile(abs, "utf8")).toBe("abs-edited\n")
    expect(existsSync(path.join(worktree, "abs.txt"))).toBe(false)
  })
})
