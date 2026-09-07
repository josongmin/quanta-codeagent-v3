/**
 * aug-23 audit — Layer-1 SOURCE-CLASS coverage for path-bearing tools.
 *
 * Layer-1 redaction (`applyRedaction` → `deriveSourceClass`) substitutes a
 * tool's ENTIRE output when the tool declares `classifySource` and that
 * classifier answers `"secret"`. It is the only layer that can mask a `.env`
 * body, because Layer-2 is format-based and `.env` values match no format.
 *
 * The original audit found only `read` and `bash` classified. This guard now
 * pins the path-bearing and direct-command families that dispatch can classify
 * before execution.
 *
 * This hellgate pins that correspondence for the tools whose INPUT carries a
 * filesystem path. Opaque deferred handles use producer-owned provenance:
 * `bash_await` resolves the registry's original command and also attaches
 * `ToolResult.source`; `pty_read` joins chunk provenance and fails closed for
 * unattributed pre-attach output.
 */

import { describe, expect, test } from "bun:test"
import { buildDefaultTools } from "@/tool"

interface ToolLike {
  readonly name: string
  readonly classifySource?: (input: unknown) => string | null
  readonly inputSchema?: unknown
}

const liveTools = (): readonly ToolLike[] =>
  (buildDefaultTools as unknown as (deps: unknown) => readonly ToolLike[])({})

/** Tools whose input carries a filesystem path the classifier can read.
 *  aug-30 audit (G6-01): the six document readers joined csv_read — the
 *  aug-23 hardening had been applied to one clone of the reader family only,
 *  leaving `yaml_read secrets/.env.yaml` etc. with Layer-1 structurally
 *  unreachable. */
const PATH_BEARING: readonly string[] = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "csv_read",
  "yaml_read",
  "ndjson_read",
  "pdf_read",
  "xlsx_read",
  "docx_read",
  "pptx_read",
]

/**
 * aug-30 audit (G6-01) — DERIVED guard, so the NEXT path-bearing tool cannot
 * ship unclassified without leaving a written adjudication here. A tool whose
 * input schema carries a `path` / `file` / `file_path` string field must
 * either declare `classifySource` or appear below with a reason. Every reason
 * is an honest classification, not a safety verdict: entries marked
 * "residual" are known partial channels awaiting their own adjudication.
 */
const ADJUDICATED_UNCLASSIFIED: Readonly<Record<string, string>> = {
  grep: "path is a search SCOPE (dir/file); output is matched lines, not a whole-file dump — whole-output substitution keyed on the scope would not model the channel; Layer-2 format regexes still apply. Residual.",
  glob: "outputs file NAMES only, never file bodies — nothing for Layer-1 to substitute.",
  localize:
    "path is a scope dir for fault localization; output is ranked paths/snippets, not a whole-file dump. Residual.",
  file_tree_summary:
    "path is an optional scope DIR; output is structure (paths + counts) plus first-line purpose hints, not file bodies. Residual (hints channel).",
  diagnostics:
    "path selects the file to type-check; output is compiler diagnostics that may quote lines, not the body. Residual.",
  read_image:
    "returns decoded image blocks; a secret-classified path (.env family, .pem) cannot decode as an image, so the body cannot reach the model through this tool.",
  scripted_replace:
    "same drift family as write/edit (which DO classify) but a mutation summary, not a reader — outside G6-01's document-reader scope; needs its own adjudication. Residual.",
}

/** Input-schema keys that mark a tool as path-bearing for the derived guard. */
const PATH_KEYS: ReadonlySet<string> = new Set(["path", "file", "file_path"])

const schemaKeys = (t: ToolLike): readonly string[] => {
  const shape = (t.inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape
  return shape === undefined ? [] : Object.keys(shape)
}

describe("Layer-1 source-class coverage (aug-23 audit)", () => {
  test("anti-vacuity: the live tool surface is actually enumerated", () => {
    const tools = liveTools()
    expect(tools.length).toBeGreaterThan(15)
    expect(tools.map((t) => t.name)).toContain("read")
  })

  test("every path-bearing tool declares classifySource", () => {
    const byName = new Map(liveTools().map((t) => [t.name, t]))
    const missing = PATH_BEARING.filter((n) => {
      const t = byName.get(n)
      return t !== undefined && typeof t.classifySource !== "function"
    })
    expect(missing).toEqual([])
  })

  test("PATH_BEARING names all exist on the live surface (no stale entry)", () => {
    const names = new Set(liveTools().map((t) => t.name))
    expect(PATH_BEARING.filter((n) => !names.has(n))).toEqual([])
  })

  test("derived guard: every path-bearing tool (by input schema) classifies its source or carries a written adjudication", () => {
    const offenders: string[] = []
    for (const t of liveTools()) {
      if (!schemaKeys(t).some((k) => PATH_KEYS.has(k))) continue
      if (typeof t.classifySource === "function") continue
      if (ADJUDICATED_UNCLASSIFIED[t.name] !== undefined) continue
      offenders.push(t.name)
    }
    expect(offenders).toEqual([])
  })

  test("derived guard anti-vacuity: schema introspection actually sees path fields", () => {
    // If zod's `.shape` access ever breaks, the derived guard would pass
    // vacuously (no tool looks path-bearing). Pin that `read` is detected.
    const read = liveTools().find((t) => t.name === "read")
    expect(read).toBeDefined()
    expect(schemaKeys(read as ToolLike)).toContain("path")
  })

  test("adjudication hygiene: no stale entry, no overlap with PATH_BEARING, no entry that also classifies", () => {
    const byName = new Map(liveTools().map((t) => [t.name, t]))
    const adjudicated = Object.keys(ADJUDICATED_UNCLASSIFIED)
    expect(adjudicated.filter((n) => !byName.has(n))).toEqual([])
    expect(adjudicated.filter((n) => PATH_BEARING.includes(n))).toEqual([])
    // An entry whose tool now declares classifySource is a stale adjudication.
    expect(adjudicated.filter((n) => typeof byName.get(n)?.classifySource === "function")).toEqual(
      [],
    )
  })

  test("direct-output command tools classify the command that produced their output", () => {
    const runner = liveTools().find((t) => t.name === "test_runner")
    expect(runner).toBeDefined()
    expect(typeof runner?.classifySource).toBe("function")
    expect(runner?.classifySource?.({ command: "cat .env" })).toBe("secret")
    expect(runner?.classifySource?.({ command: "bun test" })).toBe("public")
  })
})
