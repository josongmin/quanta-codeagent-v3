/**
 * ADR-0464 CLI promotion rail.
 *
 * This is the authoritative non-unit proof for the explicit CLI default-ON
 * decision. It exercises the real tool registry and real jailed filesystem:
 *
 * - the tool-surface SSOT seeds QUANTA_ENABLE_STRUCTURED_PATCH for CLI;
 * - the real registry emits apply_patch_structured only with the promoted slot;
 * - partial success is the product contract: successful sibling ops persist,
 *   while the failed op remains byte-identical and is reported to the model;
 * - the real FsJailFileSystemPort blocks a symlink escape without suppressing
 *   an independent in-workspace sibling op.
 *
 * An operator can still restore the legacy menu with
 * QUANTA_ENABLE_STRUCTURED_PATCH=0.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildDefaultTools,
  seedEnvVarsForSurface,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "@/tool"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const workspace = (label: string): string => {
  const root = mkdtempSync(join(tmpdir(), `structured-promotion-${label}-`))
  roots.push(root)
  return root
}

const structuredTool = (): Tool => {
  const tool = buildDefaultTools({ structuredPatch: true }).find(
    (candidate) => candidate.name === "apply_patch_structured",
  )
  if (tool === undefined) throw new Error("promoted registry omitted apply_patch_structured")
  return tool
}

const run = async (tool: Tool, patch: string, cwd: string): Promise<ToolResult> => {
  const ctx: ToolContext = { cwd, signal: new AbortController().signal }
  let result: ToolResult | undefined
  for await (const event of tool.execute({ patch } as never, ctx)) {
    if (event.type === "result") result = event.result
  }
  if (result === undefined) throw new Error("apply_patch_structured returned no result")
  return result
}

const v4a = (...body: string[]): string => ["*** Begin Patch", ...body, "*** End Patch"].join("\n")

describe("apply_patch_structured — explicit CLI promotion", () => {
  test("tool-surface SSOT explicitly seeds the promoted CLI gate", () => {
    expect(seedEnvVarsForSurface("cli")).toContain("QUANTA_ENABLE_STRUCTURED_PATCH")
    expect(buildDefaultTools().some((tool) => tool.name === "apply_patch_structured")).toBe(false)
    expect(structuredTool().isReadOnly()).toBe(false)
  })

  test("real FS: partial success persists siblings and preserves the failed file", async () => {
    const root = workspace("partial")
    writeFileSync(join(root, "before.txt"), "before\n")
    writeFileSync(join(root, "drifted.txt"), "actual content\n")

    const result = await run(
      structuredTool(),
      v4a(
        "*** Update File: before.txt",
        "@@",
        "-before",
        "+after",
        "*** Update File: drifted.txt",
        "@@",
        "-stale anchor",
        "+replacement",
        "*** Add File: after-failure.txt",
        "+landed",
      ),
      root,
    )

    expect(result.ok).toBe(false)
    expect(result.output).toContain("PARTIAL")
    expect(result.output).toContain("[FAILED] modified drifted.txt")
    expect(readFileSync(join(root, "before.txt"), "utf8")).toBe("after\n")
    expect(readFileSync(join(root, "drifted.txt"), "utf8")).toBe("actual content\n")
    expect(readFileSync(join(root, "after-failure.txt"), "utf8")).toBe("landed")
  })

  test("real jail: symlink escape fails in isolation and outside bytes stay intact", async () => {
    const root = workspace("jail")
    const outside = workspace("outside")
    writeFileSync(join(outside, "secret.txt"), "TOP-SECRET\n")
    symlinkSync(outside, join(root, "escape"))

    const result = await run(
      structuredTool(),
      v4a(
        "*** Update File: escape/secret.txt",
        "@@",
        "-TOP-SECRET",
        "+EXFILTRATED",
        "*** Add File: safe.txt",
        "+inside",
      ),
      root,
    )

    expect(result.ok).toBe(false)
    expect(result.output).toContain("outside the workspace")
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("TOP-SECRET\n")
    expect(existsSync(join(root, "safe.txt"))).toBe(true)
    expect(readFileSync(join(root, "safe.txt"), "utf8")).toBe("inside")
  })
})
