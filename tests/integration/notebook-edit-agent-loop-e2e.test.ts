/**
 * H8 — `notebook_edit` AGENT-LOOP integration e2e (REAL `dispatchTool` + REAL
 * `@/storage` FS jail + REAL temp-dir `.ipynb`).
 *
 * The unit hellgate (`notebook-edit-tool-hellgate.test.ts`) drives the wrapper
 * against an IN-MEMORY port; the pure-core unit (`notebook-edit.test.ts`) drives
 * `editNotebook`. NEITHER exercises the LOOP DISPATCH path: the registry lookup,
 * the plan-mode collaboration gate, the admissibility/permission gate, and the
 * real atomic write-back — all wired exactly as the live agent loop runs them.
 * This file closes that gap by routing every notebook edit through the SAME
 * `dispatchTool` the loop calls, with the tool registered the SAME way
 * `buildToolRegistry` registers it (`makeNotebookEditTool(<real fs port>)`),
 * onto REAL `.ipynb` files in a tmpdir.
 *
 * SOTA++ teeth (all deterministic, no timing assertions):
 *   · str_replace / insert / delete land on disk and the notebook ROUND-TRIPS
 *     through `JSON.parse` with sibling cells + notebook-level metadata intact;
 *   · the write-back is ATOMIC (temp→rename) — the target file's INODE CHANGES
 *     across the commit, and NO `.quanta-tmp-*` straggler is left behind;
 *   · str_replace UNIQUENESS is enforced through the loop path (ambiguous match
 *     ⇒ ok:false, file BYTE-UNCHANGED);
 *   · a malformed `.ipynb` is handled gracefully (ok:false, no throw, no write);
 *   · PLAN-mode blocks the (mutating) notebook edit before any write;
 *   · the PERMISSION gate (default mode + `onConfirm:false`) denies before any
 *     write;
 *   · the stale-read guard (real `ReadFileState`) refuses a write over a
 *     notebook that changed since the recorded read — before any write.
 *
 * RED-ON-INJECTION:
 *   · drop the uniqueness guard in `editNotebook` ⇒ the ambiguous-match test
 *     writes (file changes) ⇒ RED;
 *   · drop the plan-mode / permission deny ⇒ the gate tests see a write ⇒ RED;
 *   · revert the atomic write to a truncating in-place write ⇒ inode-unchanged ⇒
 *     the atomicity tooth fails RED.
 *
 * HERMETIC: every notebook lives in a fresh tmpdir; permission-store path is
 * redirected into the tmpdir and reset around each test so order cannot leak.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import {
  __resetDefaultPermissionStore,
  type PermissionContext,
  type ToolAction,
} from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import { defaultFileSystemPort } from "@/storage"
import { ToolRegistry } from "@/tool"
import { makeNotebookEditTool } from "@/tool/notebook-edit/tool"
import { ReadFileState } from "@/tool/stale-read-guard"

/* ─────────────────────────────── fixtures ──────────────────────────────── */

// A real nbformat 4.5 notebook with two cells (a code cell + a markdown cell),
// notebook-level metadata, and per-cell metadata/ids we assert survive a round
// trip. `x = 1` appears ONCE in cell 0 (the uniqueness happy path); `print`
// appears twice (the ambiguous-match adversarial path).
const NB = JSON.stringify(
  {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: "python3", display_name: "Python 3" },
      language_info: { name: "python", version: "3.11" },
    },
    cells: [
      {
        cell_type: "code",
        id: "cell-a",
        source: ["x = 1\n", "print(x)\n", "print(x + 1)\n"],
        metadata: { tags: ["keep"] },
        execution_count: null,
        outputs: [],
      },
      {
        cell_type: "markdown",
        id: "cell-b",
        source: ["# notes\n", "do not touch\n"],
        metadata: {},
      },
    ],
  },
  null,
  1,
)

interface ParsedNb {
  nbformat: number
  nbformat_minor: number
  metadata: { kernelspec?: { name?: string }; language_info?: { name?: string } }
  cells: Array<{
    cell_type: string
    id?: string
    source: string | string[]
    metadata?: { tags?: string[] }
    execution_count?: number | null
    outputs?: unknown[]
  }>
}
const sourceOf = (c: ParsedNb["cells"][number]): string =>
  typeof c.source === "string" ? c.source : c.source.join("")

/* ─────────────────────── tmpdir + permission isolation ─────────────────── */

let dir: string
const originalPermState = process.env.QUANTA_PERMISSION_STATE

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nb-edit-loop-e2e-"))
  process.env.QUANTA_PERMISSION_STATE = join(dir, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (originalPermState === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = originalPermState
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

/** Seed `<dir>/<name>` with `body` and return the ABSOLUTE path (so the real
 *  `statFile` path matches what the stale guard records). */
const seed = (name: string, body: string): string => {
  const p = join(dir, name)
  writeFileSync(p, body, "utf8")
  return p
}

/** Build the registry EXACTLY like the host's `buildToolRegistry` does when
 *  `QUANTA_NOTEBOOK_EDIT` is on: the cell editor bound to the REAL `@/storage`
 *  jailed FS port (atomic write-back), nothing in-memory. */
const registryWithNotebook = (): ToolRegistry =>
  new ToolRegistry([makeNotebookEditTool(defaultFileSystemPort)])

const cfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    cwd: dir,
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "bypass" } as PermissionContext,
    registry: registryWithNotebook(),
    ...over,
  }) as AgentConfig

const call = (input: unknown, id = "nb1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name: "notebook_edit",
  input,
})

/** Drive ONE notebook edit through the REAL loop dispatcher. */
const dispatch = (input: unknown, config: AgentConfig) =>
  dispatchTool(call(input), config, config.permission as PermissionContext)

/** Count `<name>.quanta-tmp-*` stragglers left beside the target. */
const tempStragglers = (name: string): string[] =>
  readdirSync(dir).filter((n) => n.startsWith(`${name}.quanta-tmp-`))

const readFileUtf8 = (p: string): string => readFileSync(p, "utf8")

/* ───────────────────────────── happy paths ─────────────────────────────── */

describe("notebook_edit — agent-loop dispatch e2e (real fs, real dispatchTool)", () => {
  test("str_replace through dispatch ⇒ disk edited, ATOMIC (inode changes), round-trips, siblings intact", async () => {
    const file = seed("nb.ipynb", NB)
    const inoBefore = statSync(file).ino

    const res = await dispatch(
      { path: file, mode: "str_replace", cell: 0, old_string: "x = 1", new_string: "x = 99" },
      cfg(),
    )

    expect(res.ok).toBe(true)
    expect(res.block.content).toContain("notebook_edit:")

    // ROUND-TRIP: the written file re-parses as a valid notebook.
    const parsed = JSON.parse(readFileUtf8(file)) as ParsedNb
    // Edited cell got the replacement; the rest of cell 0 is preserved.
    expect(sourceOf(parsed.cells[0]!)).toBe("x = 99\nprint(x)\nprint(x + 1)\n")
    // Sibling markdown cell BYTE-untouched.
    expect(sourceOf(parsed.cells[1]!)).toBe("# notes\ndo not touch\n")
    // Notebook-level metadata + per-cell metadata/ids survive the round trip.
    expect(parsed.nbformat).toBe(4)
    expect(parsed.metadata.kernelspec?.name).toBe("python3")
    expect(parsed.metadata.language_info?.name).toBe("python")
    expect(parsed.cells[0]!.id).toBe("cell-a")
    expect(parsed.cells[0]!.metadata?.tags).toEqual(["keep"])
    expect(parsed.cells[1]!.id).toBe("cell-b")

    // ATOMIC WRITE TOOTH: a temp→rename promotes a fresh inode (a truncating
    // in-place write would keep the SAME inode ⇒ this fails RED on revert).
    expect(statSync(file).ino).not.toBe(inoBefore)
    // No temp straggler beside the target after a clean commit.
    expect(tempStragglers("nb.ipynb")).toEqual([])
  })

  test("insert through dispatch ⇒ new cell at index, every other cell preserved, round-trips", async () => {
    const file = seed("nb.ipynb", NB)
    const res = await dispatch(
      { path: file, mode: "insert", index: 1, cell_type: "code", source: "y = 2\n" },
      cfg(),
    )
    expect(res.ok).toBe(true)

    const parsed = JSON.parse(readFileUtf8(file)) as ParsedNb
    expect(parsed.cells).toHaveLength(3)
    expect(sourceOf(parsed.cells[0]!)).toBe("x = 1\nprint(x)\nprint(x + 1)\n") // before
    expect(parsed.cells[1]!.cell_type).toBe("code")
    expect(sourceOf(parsed.cells[1]!)).toBe("y = 2\n") // inserted
    expect(parsed.cells[1]!.execution_count).toBeNull() // code-cell shape
    expect(sourceOf(parsed.cells[2]!)).toBe("# notes\ndo not touch\n") // shifted, intact
  })

  test("delete through dispatch ⇒ cell removed, remaining cell preserved, round-trips", async () => {
    const file = seed("nb.ipynb", NB)
    const res = await dispatch({ path: file, mode: "delete", cell: 0 }, cfg())
    expect(res.ok).toBe(true)

    const parsed = JSON.parse(readFileUtf8(file)) as ParsedNb
    expect(parsed.cells).toHaveLength(1)
    expect(parsed.cells[0]!.cell_type).toBe("markdown")
    expect(parsed.cells[0]!.id).toBe("cell-b")
    expect(sourceOf(parsed.cells[0]!)).toBe("# notes\ndo not touch\n")
  })

  test("replace_all through dispatch ⇒ every occurrence in the cell changed, round-trips", async () => {
    const file = seed("nb.ipynb", NB)
    const res = await dispatch(
      {
        path: file,
        mode: "str_replace",
        cell: 0,
        old_string: "print",
        new_string: "log",
        replace_all: true,
      },
      cfg(),
    )
    expect(res.ok).toBe(true)
    const parsed = JSON.parse(readFileUtf8(file)) as ParsedNb
    expect(sourceOf(parsed.cells[0]!)).toBe("x = 1\nlog(x)\nlog(x + 1)\n")
  })

  /* ─────────────────────────── adversarial ──────────────────────────────── */

  test("ADVERSARIAL: ambiguous str_replace (2× match, no replace_all) ⇒ ok:false, file BYTE-UNCHANGED", async () => {
    const file = seed("nb.ipynb", NB)
    const before = readFileUtf8(file)
    const inoBefore = statSync(file).ino

    // `print` matches twice in cell 0 ⇒ uniqueness guard must refuse.
    const res = await dispatch(
      { path: file, mode: "str_replace", cell: 0, old_string: "print", new_string: "log" },
      cfg(),
    )
    expect(res.ok).toBe(false)
    expect(res.block.content.toLowerCase()).toContain("matches")
    // RED-ON-INJECTION: dropping the uniqueness guard would write here.
    expect(readFileUtf8(file)).toBe(before)
    expect(statSync(file).ino).toBe(inoBefore) // no write happened at all
    expect(tempStragglers("nb.ipynb")).toEqual([])
  })

  test("ADVERSARIAL: malformed .ipynb ⇒ ok:false (no throw), file BYTE-UNCHANGED", async () => {
    const file = seed("bad.ipynb", "{ this is not valid json")
    const before = readFileUtf8(file)
    const res = await dispatch(
      { path: file, mode: "str_replace", cell: 0, old_string: "x", new_string: "y" },
      cfg(),
    )
    expect(res.ok).toBe(false)
    expect(readFileUtf8(file)).toBe(before)
  })

  test("ADVERSARIAL: non-.ipynb path ⇒ ok:false, file BYTE-UNCHANGED", async () => {
    const file = seed("foo.py", "x = 1\n")
    const before = readFileUtf8(file)
    const res = await dispatch({ path: file, mode: "delete", cell: 0 }, cfg())
    expect(res.ok).toBe(false)
    expect(readFileUtf8(file)).toBe(before)
  })

  test("ADVERSARIAL: cell index out of range ⇒ ok:false, file BYTE-UNCHANGED", async () => {
    const file = seed("nb.ipynb", NB)
    const before = readFileUtf8(file)
    const res = await dispatch({ path: file, mode: "delete", cell: 9 }, cfg())
    expect(res.ok).toBe(false)
    expect(readFileUtf8(file)).toBe(before)
  })

  /* ─────────────────────────── gate teeth ───────────────────────────────── */

  test("GATE: plan mode blocks the (mutating) notebook edit ⇒ ok:false, file BYTE-UNCHANGED", async () => {
    const file = seed("nb.ipynb", NB)
    const before = readFileUtf8(file)
    const res = await dispatch(
      { path: file, mode: "str_replace", cell: 0, old_string: "x = 1", new_string: "x = 99" },
      cfg({ planMode: true }),
    )
    // RED-ON-INJECTION: removing the plan-mode dispatch block would let the
    // mutating edit through and write the file.
    expect(res.ok).toBe(false)
    expect(readFileUtf8(file)).toBe(before)
  })

  test("GATE: permission deny (default mode + onConfirm:false) ⇒ ok:false, file BYTE-UNCHANGED", async () => {
    const file = seed("nb.ipynb", NB)
    const before = readFileUtf8(file)
    let confirmCalls = 0
    const config = cfg({
      permission: { mode: "default" } as PermissionContext,
      onConfirm: async (_a: ToolAction) => {
        confirmCalls++
        return false // deny the mutating edit
      },
    })
    const res = await dispatch(
      { path: file, mode: "delete", cell: 0 },
      config,
    )
    expect(confirmCalls).toBe(1) // the ask branch consulted the human seam
    expect(res.ok).toBe(false)
    // RED-ON-INJECTION: a missing permission gate writes the file.
    expect(readFileUtf8(file)).toBe(before)
  })

  test("GATE: permission ALLOW (default mode + onConfirm:true) ⇒ edit lands", async () => {
    const file = seed("nb.ipynb", NB)
    const config = cfg({
      permission: { mode: "default" } as PermissionContext,
      onConfirm: async (_a: ToolAction) => true,
    })
    const res = await dispatch(
      { path: file, mode: "delete", cell: 1 },
      config,
    )
    expect(res.ok).toBe(true)
    const parsed = JSON.parse(readFileUtf8(file)) as ParsedNb
    expect(parsed.cells).toHaveLength(1)
    expect(parsed.cells[0]!.id).toBe("cell-a")
  })

  test("GATE: stale-read guard (real ReadFileState) refuses write over a changed-since-read notebook, file BYTE-UNCHANGED", async () => {
    const file = seed("nb.ipynb", NB)
    const before = readFileUtf8(file)
    // Record a deliberately ANCIENT mtime (1ms) keyed on the ABSOLUTE path the
    // real `statFile` returns; the current mtime is far greater ⇒ the guard
    // sees the file as stale (changed since the recorded read). No timing dep —
    // 1 < any real mtime, deterministically.
    const readFileState = new ReadFileState()
    readFileState.record(file, 1)

    const res = await dispatch(
      { path: file, mode: "delete", cell: 0 },
      cfg({ readFileState }),
    )
    expect(res.ok).toBe(false)
    // The stale-write message tells the model the file changed since its read.
    expect(res.block.content.toLowerCase()).toContain("modified on disk")
    // RED-ON-INJECTION: removing the stale guard writes the deletion.
    expect(readFileUtf8(file)).toBe(before)
  })

  /* ─────────────────────── default-OFF byte-identity ─────────────────────── */

  test("DEFAULT-OFF: notebook_edit absent from a registry that does not opt in ⇒ dispatch denies as unknown tool", async () => {
    // The host registers `notebook_edit` ONLY when `QUANTA_NOTEBOOK_EDIT` is on
    // (ports.notebookEdit === true). A registry WITHOUT it must reject the call
    // as an unknown tool — proving the gate is the sole admission point and the
    // tool menu is byte-identical when the knob is off.
    const file = seed("nb.ipynb", NB)
    const before = readFileUtf8(file)
    const res = await dispatch(
      { path: file, mode: "delete", cell: 0 },
      cfg({ registry: new ToolRegistry([]) }),
    )
    expect(res.ok).toBe(false)
    expect(res.block.content).toContain("Unknown tool")
    expect(readFileUtf8(file)).toBe(before)
  })
})
