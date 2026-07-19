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
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitWriteProtectReason } from "@/permission"
import {
  buildDefaultTools,
  seedEnvVarsForSurface,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "@/tool"
import { guardWrite, ReadFileState } from "@/tool/stale-read-guard"

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

const run = async (
  tool: Tool,
  patch: string,
  cwd: string,
  context: Omit<Partial<ToolContext>, "cwd" | "signal"> = {},
): Promise<ToolResult> => {
  const ctx: ToolContext = { cwd, signal: new AbortController().signal, ...context }
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

  test("stale preflight turns a real jail escape into a no-throw zero-write rejection", async () => {
    const root = workspace("stale-jail")
    const outside = workspace("stale-jail-outside")
    writeFileSync(join(outside, "secret.txt"), "TOP-SECRET\n")
    symlinkSync(outside, join(root, "escape"))

    const result = await run(
      structuredTool(),
      v4a(
        "*** Add File: safe.txt",
        "+must-not-land",
        "*** Update File: escape/secret.txt",
        "@@",
        "-TOP-SECRET",
        "+EXFILTRATED",
      ),
      root,
      { readFileState: new ReadFileState(), editFreshHash: true },
    )

    expect(result.ok).toBe(false)
    expect(result.failure).toEqual({ mode: "rejected", reason: "stale_read_check_failed" })
    expect(result.output).toContain("cannot safely verify freshness")
    expect(existsSync(join(root, "safe.txt"))).toBe(false)
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("TOP-SECRET\n")
  })

  test("wired git-write guard hard-denies protected paths before any sibling mutation", async () => {
    const root = workspace("git-guard")

    const result = await run(
      structuredTool(),
      v4a(
        "*** Add File: safe.txt",
        "+must-not-land",
        "*** Add File: .git/hooks/pre-commit",
        "+#!/bin/sh",
      ),
      root,
      { gitWriteGuard: gitWriteProtectReason },
    )

    expect(result.ok).toBe(false)
    expect(result.failure).toEqual({
      mode: "permission_denied",
      path: ".git/hooks/pre-commit",
    })
    expect(existsSync(join(root, "safe.txt"))).toBe(false)
    expect(existsSync(join(root, ".git/hooks/pre-commit"))).toBe(false)
  })

  test("wired stale-read guard rejects an externally drifted target with zero mutation", async () => {
    const root = workspace("stale-guard")
    const target = join(root, "a.txt")
    writeFileSync(target, "model-read-v1\n")
    const readMtime = statSync(target).mtimeMs
    const state = new ReadFileState()
    state.record(target, readMtime)

    writeFileSync(target, "external-v2\n")
    const advanced = new Date(readMtime + 5_000)
    utimesSync(target, advanced, advanced)
    expect(guardWrite(state, target, statSync(target).mtimeMs).ok).toBe(false)

    const result = await run(
      structuredTool(),
      v4a("*** Update File: a.txt", "@@", "-external-v2", "+agent-v3"),
      root,
      { readFileState: state, editFreshHash: true },
    )

    expect(result.ok).toBe(false)
    expect(result.failure).toEqual({ mode: "rejected", reason: "stale_read" })
    expect(readFileSync(target, "utf8")).toBe("external-v2\n")
  })

  test("partial success refreshes stale-read baselines for every successful sibling", async () => {
    const root = workspace("baseline")
    const updated = join(root, "updated.txt")
    writeFileSync(updated, "before\n")
    writeFileSync(join(root, "drifted.txt"), "actual\n")
    const state = new ReadFileState()
    state.record(updated, statSync(updated).mtimeMs)

    const result = await run(
      structuredTool(),
      v4a(
        "*** Update File: updated.txt",
        "@@",
        "-before",
        "+after",
        "*** Update File: drifted.txt",
        "@@",
        "-missing-anchor",
        "+replacement",
        "*** Add File: created.txt",
        "+created",
      ),
      root,
      { readFileState: state, editFreshHash: true },
    )

    const created = join(root, "created.txt")
    expect(result.ok).toBe(false)
    expect(readFileSync(updated, "utf8")).toBe("after\n")
    expect(readFileSync(created, "utf8")).toBe("created")
    expect(guardWrite(state, updated, statSync(updated).mtimeMs).ok).toBe(true)
    expect(state.has(created)).toBe(true)
    expect(guardWrite(state, created, statSync(created).mtimeMs).ok).toBe(true)
  })
})
