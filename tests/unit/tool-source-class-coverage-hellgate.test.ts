/**
 * aug-23 audit — Layer-1 SOURCE-CLASS coverage for path-bearing tools.
 *
 * Layer-1 redaction (`applyRedaction` → `deriveSourceClass`) substitutes a
 * tool's ENTIRE output when the tool declares `classifySource` and that
 * classifier answers `"secret"`. It is the only layer that can mask a `.env`
 * body, because Layer-2 is format-based and `.env` values match no format.
 *
 * The audit measured the live default tool surface: **26 tools, exactly 2**
 * (`read`, `bash`) declare `classifySource`. So `grep -r AWS_SECRET .env`,
 * `csv_read .env`, `file_tree_summary` over a secrets dir — every one dumps the
 * bytes with Layer-1 structurally unreachable. The gap was invisible because
 * nothing asserted the correspondence between "takes a path" and "classifies
 * its source".
 *
 * This hellgate pins that correspondence for the tools whose INPUT carries a
 * filesystem path. Deliberately NOT pinned: tools whose input is an opaque
 * handle (`bash_await` `{shell_id}`, `pty_read` `{handle}`) — there is nothing
 * in the input to classify, and the repo already adjudicated them as
 * non-channels in `shell-input-channel-completeness-hellgate.test.ts`.
 */

import { describe, expect, test } from "bun:test"
import { buildDefaultTools } from "@/tool"

interface ToolLike {
  readonly name: string
  readonly classifySource?: unknown
}

const liveTools = (): readonly ToolLike[] =>
  (buildDefaultTools as unknown as (deps: unknown) => readonly ToolLike[])({})

/** Tools whose input carries a filesystem path the classifier can read. */
const PATH_BEARING: readonly string[] = ["read", "write", "edit", "apply_patch", "csv_read"]

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
})
