/**
 * Hellgate — FS-jail containment for LSP **workspace edits** (aug-23).
 *
 * THREAT. `lsp_rename_apply` jails only the ANCHOR path the model supplied
 * (`resolveJailed(input.path, ctx.cwd)`). The workspace edit it then applies is
 * built entirely from what the LANGUAGE SERVER returned, and the writer
 * (`@/lsp` `applyWorkspaceEditAtomic`) does a bare `fileURLToPath(doc.uri)` with
 * NO containment check (`grep -rn "jail" src/lsp` → 0 hits). Repo-owned server
 * configuration is untrusted content in this codebase
 * (`src/agent/run-mode/repo-rules-policy.ts`): a tsconfig `include`/`paths`
 * entry, a project reference, or a rust-analyzer `linkedProjects` entry can
 * steer an honest server at files OUTSIDE the workspace. The same hole sits on
 * `lsp_code_action`'s port `applyEdit`.
 *
 * `@/tool` MUST NOT import `@/lsp` and `@/lsp` MUST NOT import `@/storage`
 * (biome `noRestrictedImports` + `tools/slice-graph/validate.ts`), so the guard
 * cannot live in the writer — it lives on the TOOL side, which already imports
 * `resolveJailed`.
 *
 * Seal:
 *   W. writer witness  — the real `@/lsp` writer happily writes OUTSIDE the
 *                        workspace when handed an out-of-jail URI. This is what
 *                        makes the tool-side guard load-bearing (if this ever
 *                        goes green-by-accident the guard below is untested).
 *   A. rename / escape — a single out-of-jail target ⇒ ok:false, NOTHING written
 *   B. rename / mixed  — one out + one in ⇒ ALL-OR-NOTHING, the IN-jail file is
 *                        NOT written either (a half-applied rename breaks source)
 *   C. rename / control— fully in-jail rename still applies (no over-refusal)
 *   D. rename / message— the refusal names the offending path
 *   E. code_action     — the bridge port's `applyEdit` refuses out-of-jail…
 *   F. code_action ctl — …and lets an IN-jail edit through to server selection
 */

import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { specFor } from "@/agent/lsp-bridge/servers"
import { lspCodeActionPort } from "@/agent/lsp-bridge/tools"
import type { RenameApplyPort, RenameWorkspaceEdit } from "@/lsp"
import { lspRenameApplyTool } from "@/tool/lsp_nav"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

/* ------------------------------------------------------------------ */
/* Fixture: a jail root and a sibling OUTSIDE dir under the same tmp   */
/* ------------------------------------------------------------------ */

interface Fixture {
  readonly jail: string
  readonly outside: string
  readonly anchor: string
  readonly inFile: string
  readonly outFile: string
}

const fixture = (label: string): Fixture => {
  const base = mkdtempSync(join(tmpdir(), `quanta-wsedit-fence-${label}-`))
  const jail = join(base, "workspace")
  const outside = join(base, "outside")
  mkdirSync(jail, { recursive: true })
  mkdirSync(outside, { recursive: true })
  const anchor = join(jail, "anchor.ts")
  const inFile = join(jail, "inside.ts")
  const outFile = join(outside, "victim.ts")
  writeFileSync(anchor, "export const Foo = 1\n")
  writeFileSync(inFile, "export const Foo = 1\n")
  writeFileSync(outFile, "export const Foo = 1\n")
  return { jail, outside, anchor, inFile, outFile }
}

const docEdit = (path: string): RenameWorkspaceEdit["changes"][number] => ({
  uri: pathToFileURL(path).href,
  edits: [
    {
      range: { start: { line: 0, character: 13 }, end: { line: 0, character: 16 } },
      newText: "Bar",
    },
  ],
})

/** A port that ACTUALLY WRITES, mirroring the real `@/lsp` writer's lack of
 *  containment. If the guard is missing, the escape is observable on disk —
 *  not merely "the fake recorded a call". */
const writingPort = (edit: RenameWorkspaceEdit): RenameApplyPort & { applied: number } => {
  const state = { applied: 0 }
  const port: RenameApplyPort = {
    computeRename: async () => edit,
    applyEdit: async (e) => {
      for (const doc of e.changes) {
        const p = new URL(doc.uri).pathname
        writeFileSync(p, readFileSync(p, "utf8").replace("Foo", "Bar"))
        state.applied++
      }
    },
  }
  return Object.assign(port, state, {
    get applied() {
      return state.applied
    },
  }) as RenameApplyPort & { applied: number }
}

interface ExecutableTool {
  execute(input: unknown, c: ToolContext): AsyncIterable<ToolEvent>
}

const run = async (tool: ExecutableTool, input: unknown, cwd: string): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input, { cwd, signal: new AbortController().signal })) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no terminal result")
  return result
}

const renamed = (path: string): boolean => readFileSync(path, "utf8").includes("Bar")

/* ------------------------------------------------------------------ */
/* W. Writer witness — the real @/lsp writer has NO containment        */
/* ------------------------------------------------------------------ */

describe("workspace-edit jail — writer witness", () => {
  test("HELL-W0: the real @/lsp writer writes OUTSIDE the workspace root", async () => {
    const f = fixture("witness")
    const spec = specFor(f.outFile)
    expect(spec).not.toBeNull()
    if (!spec) throw new Error("no spec")
    // `applyWorkspaceEdit` is pure filesystem work (2-phase tmp+rename); it does
    // NOT need the server process. Rooted at the JAIL, handed an OUTSIDE uri.
    const client = spec.create(f.jail)
    await client.applyWorkspaceEdit({ changes: [docEdit(f.outFile)] })
    expect(renamed(f.outFile)).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* A–D. lsp_rename_apply                                               */
/* ------------------------------------------------------------------ */

describe("workspace-edit jail — lsp_rename_apply", () => {
  test("HELL-A1: out-of-jail target ⇒ ok:false and the file is NOT written", async () => {
    const f = fixture("rename-escape")
    const port = writingPort({ changes: [docEdit(f.outFile)] })
    const result = await run(
      lspRenameApplyTool(port),
      { path: "anchor.ts", line: 1, character: 14, newName: "Bar" },
      f.jail,
    )
    expect(renamed(f.outFile)).toBe(false)
    expect(port.applied).toBe(0)
    expect(result.ok).toBe(false)
  })

  test("HELL-B2: mixed in/out ⇒ ALL-OR-NOTHING (in-jail file untouched too)", async () => {
    const f = fixture("rename-mixed")
    const port = writingPort({ changes: [docEdit(f.inFile), docEdit(f.outFile)] })
    const result = await run(
      lspRenameApplyTool(port),
      { path: "anchor.ts", line: 1, character: 14, newName: "Bar" },
      f.jail,
    )
    expect(result.ok).toBe(false)
    expect(renamed(f.outFile)).toBe(false)
    expect(renamed(f.inFile)).toBe(false)
  })

  test("HELL-C3: CONTROL — fully in-jail rename still applies (no over-refusal)", async () => {
    const f = fixture("rename-control")
    const port = writingPort({ changes: [docEdit(f.inFile), docEdit(f.anchor)] })
    const result = await run(
      lspRenameApplyTool(port),
      { path: "anchor.ts", line: 1, character: 14, newName: "Bar" },
      f.jail,
    )
    expect(result.ok).toBe(true)
    expect(renamed(f.inFile)).toBe(true)
    expect(renamed(f.anchor)).toBe(true)
    expect(result.output).toContain("Applied 2 edits across 2 files")
  })

  test("HELL-D4: the refusal names the offending path", async () => {
    const f = fixture("rename-msg")
    const port = writingPort({ changes: [docEdit(f.outFile)] })
    const result = await run(
      lspRenameApplyTool(port),
      { path: "anchor.ts", line: 1, character: 14, newName: "Bar" },
      f.jail,
    )
    expect(result.output).toContain(f.outFile)
    expect(result.output).toMatch(/outside the working-directory jail/i)
  })

  test("HELL-D5: a non-`file:` uri is refused (containment is unverifiable)", async () => {
    const f = fixture("rename-scheme")
    const port = writingPort({
      changes: [{ uri: "untitled:Untitled-1", edits: [] }],
    })
    const result = await run(
      lspRenameApplyTool(port),
      { path: "anchor.ts", line: 1, character: 14, newName: "Bar" },
      f.jail,
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("untitled:Untitled-1")
  })

  test("HELL-D6: a SYMLINK inside the workspace pointing out is refused", async () => {
    const f = fixture("rename-symlink")
    // `jail/escape` → the outside dir. A lexical prefix check would call
    // `jail/escape/victim.ts` in-jail; only the symlink-aware canonicalization
    // in `resolveJailed` sees the real destination.
    symlinkSync(f.outside, join(f.jail, "escape"))
    const viaLink = join(f.jail, "escape", "victim.ts")
    const port = writingPort({ changes: [docEdit(viaLink)] })
    const result = await run(
      lspRenameApplyTool(port),
      { path: "anchor.ts", line: 1, character: 14, newName: "Bar" },
      f.jail,
    )
    expect(result.ok).toBe(false)
    expect(renamed(f.outFile)).toBe(false)
  })

  test("HELL-D7: a `..` traversal inside the uri is refused", async () => {
    const f = fixture("rename-dotdot")
    const traversal = join(f.jail, "..", "outside", "victim.ts")
    const port = writingPort({ changes: [docEdit(traversal)] })
    const result = await run(
      lspRenameApplyTool(port),
      { path: "anchor.ts", line: 1, character: 14, newName: "Bar" },
      f.jail,
    )
    expect(result.ok).toBe(false)
    expect(renamed(f.outFile)).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* E–F. lsp_code_action bridge port                                    */
/* ------------------------------------------------------------------ */

describe("workspace-edit jail — lsp_code_action port", () => {
  test("HELL-E1: applyEdit REFUSES an out-of-jail target", async () => {
    const f = fixture("ca-escape")
    const port = lspCodeActionPort(() => f.jail)
    await expect(port.applyEdit({ changes: [docEdit(f.outFile)] })).rejects.toThrow(
      /outside the working-directory jail/i,
    )
    expect(renamed(f.outFile)).toBe(false)
  })

  test("HELL-F2: CONTROL — an in-jail target passes the jail and reaches server selection", async () => {
    const f = fixture("ca-control")
    const unsupported = join(f.jail, "note.qzz")
    writeFileSync(unsupported, "x")
    const port = lspCodeActionPort(() => f.jail)
    // No language server owns `.qzz`, so the port throws its OWN
    // "no server for" error — proving the edit got PAST the jail guard.
    await expect(port.applyEdit({ changes: [docEdit(unsupported)] })).rejects.toThrow(
      /no server for/,
    )
  })

  test("HELL-F3: the out-of-jail refusal is NOT the 'no server' path", async () => {
    const f = fixture("ca-distinct")
    const outsideUnsupported = join(f.outside, "note.qzz")
    writeFileSync(outsideUnsupported, "x")
    const port = lspCodeActionPort(() => f.jail)
    // Same unsupported extension, but OUTSIDE ⇒ the jail must win, and it must
    // win BEFORE any server lookup / process contact.
    await expect(port.applyEdit({ changes: [docEdit(outsideUnsupported)] })).rejects.toThrow(
      /outside the working-directory jail/i,
    )
  })

  test("HELL-F4: empty edit is a no-op (guard does not manufacture a failure)", async () => {
    const f = fixture("ca-empty")
    const port = lspCodeActionPort(() => f.jail)
    expect(existsSync(f.jail)).toBe(true)
    await expect(port.applyEdit({ changes: [] })).resolves.toBeUndefined()
  })
})
