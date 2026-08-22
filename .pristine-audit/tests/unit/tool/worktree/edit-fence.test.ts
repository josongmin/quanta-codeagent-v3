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

  // ── ticket-11 finding #5: the HEADLINE jail invariant ───────────────────────
  // The whole point of the edit-fence is that a worktree is a relative-cwd
  // OVERRIDE, NOT a trust-boundary widening. A RELATIVE path that uses `../`×N to
  // climb OUT of the SESSION jail (the worktree is a SUBDIR of the session, so a
  // relative path joined onto the worktree must STILL be jail-checked against the
  // session root) must be REFUSED, and the out-of-jail victim must be byte-
  // identical. Pre-fix the suite only covered in-jail relative writes.
  test("active worktree ⇒ a RELATIVE '../'×N escape OUT of the session jail is REFUSED", async () => {
    const { session, worktree } = await makeSessionWithWorktree("edit-escape-rel")
    // A SIBLING tmpdir OUTSIDE the session jail holds the victim.
    const victimDir = await makeDir("edit-victim-rel")
    const victim = path.join(victimDir, "victim.txt")
    await writeFile(victim, "VICTIM_UNTOUCHED\n")
    // Build the relative climb FROM the worktree dir to the victim. The worktree
    // is `<session>/.quanta/worktrees/wt`, so this necessarily passes through (and
    // past) the session root — the jail must reject it.
    const rel = path.relative(worktree, victim)
    expect(rel.startsWith("..")).toBe(true) // sanity: it really does climb out
    const r = await drain(
      editTool,
      { path: rel, old_string: "VICTIM_UNTOUCHED", new_string: "PWNED" },
      ctx(session, activeFor(session, worktree)),
    )
    expect(r.ok).toBe(false)
    // The victim outside the session jail is byte-identical (no partial write).
    expect(await readFile(victim, "utf8")).toBe("VICTIM_UNTOUCHED\n")
  })

  test("active worktree ⇒ an ABSOLUTE path OUTSIDE the session jail is REFUSED", async () => {
    const { session, worktree } = await makeSessionWithWorktree("edit-escape-abs")
    const victimDir = await makeDir("edit-victim-abs")
    const victim = path.join(victimDir, "victim.txt")
    await writeFile(victim, "VICTIM_UNTOUCHED\n")
    // An ABSOLUTE path outside the session jail jails to the SESSION root (the
    // worktree NEVER widens the absolute trust boundary) → refused.
    const r = await drain(
      editTool,
      { path: victim, old_string: "VICTIM_UNTOUCHED", new_string: "PWNED" },
      ctx(session, activeFor(session, worktree)),
    )
    expect(r.ok).toBe(false)
    expect(await readFile(victim, "utf8")).toBe("VICTIM_UNTOUCHED\n")
  })
})

describe("read edit-fence", () => {
  test("DEFAULT-OFF: no active worktree ⇒ read resolves against the session cwd", async () => {
    const session = await makeDir("read-off")
    await writeFile(path.join(session, "r.txt"), "session-only\n")
    const r = await drain(readTool, { path: "r.txt" }, ctx(session))
    expect(r.ok).toBe(true)
    expect(r.output).toContain("session-only")
  })

  // ticket-11 finding #3: read MUST be fenced to the worktree like edit/bash.
  // Pre-fix `read` resolved against `ctx.cwd` (session) while edit/bash used
  // `ctx.activeWorktree` → a RELATIVE read returned the SESSION copy while a
  // RELATIVE edit touched the WORKTREE copy (divergence + stale-read bypass).
  // The SAME relative filename exists in BOTH dirs with DIFFERENT content; the
  // read must return the WORKTREE copy.
  test("active worktree ⇒ a RELATIVE read returns the WORKTREE copy (not session)", async () => {
    const { session, worktree } = await makeSessionWithWorktree("read-on")
    await writeFile(path.join(session, "foo.ts"), "SESSION_A\n")
    await writeFile(path.join(worktree, "foo.ts"), "WORKTREE_B\n")
    const r = await drain(readTool, { path: "foo.ts" }, ctx(session, activeFor(session, worktree)))
    expect(r.ok).toBe(true)
    expect(r.output).toContain("WORKTREE_B")
    expect(r.output).not.toContain("SESSION_A")
  })

  // RED-ON-INJECTION mirror: an ABSOLUTE read STILL jails to the SESSION root,
  // never re-based onto the worktree (the worktree is a relative-cwd override).
  test("active worktree ⇒ an ABSOLUTE read STILL targets the SESSION jail", async () => {
    const { session, worktree } = await makeSessionWithWorktree("read-abs")
    await writeFile(path.join(session, "abs-r.txt"), "abs-session\n")
    const abs = path.join(session, "abs-r.txt")
    const r = await drain(readTool, { path: abs }, ctx(session, activeFor(session, worktree)))
    expect(r.ok).toBe(true)
    expect(r.output).toContain("abs-session")
    expect(existsSync(path.join(worktree, "abs-r.txt"))).toBe(false)
  })
})
