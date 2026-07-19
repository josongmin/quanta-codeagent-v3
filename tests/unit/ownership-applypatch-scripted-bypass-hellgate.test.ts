/**
 * SECURITY HELLGATE (jul-19, 3-round audit finding): the subagent FS-ownership
 * fence (`QUANTA_FS_OWNERSHIP_ENFORCE=1`) was a FALSE FENCE for the primary edit
 * tools. `extractWriteEffects` only duck-reads a top-level `path` (later `file`),
 * but `apply_patch`/`apply_patch_structured` carry their targets INSIDE
 * `input.patch`, and `scripted_replace` uses `input.file`. So a fenced subagent
 * (owned=["src"]) could write ANYWHERE in cwd (docs/, .github/…) via apply_patch
 * or scripted_replace — the fence never fired.
 *
 * FIX: `patchWriteEffects` (src/agent/ownership-policy.ts) parses the CLOSED V4A
 * op set (add/delete/update + moveTo) → one effect per touched path, unioned into
 * the ownership consult at dispatch.ts:consultOwnership; and `extractWriteEffects`
 * now duck-reads `file`. Heuristic-free (closed tool + op + literal fields).
 *
 * RED-first: revert the union in dispatch.ts OR the `patchWriteEffects` parse ⇒
 * the apply_patch/scripted_replace DENY cases flip back to `ok:true` (escape).
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { buildOwnershipPolicy, patchWriteEffects } from "@/agent/ownership-policy"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

const addPatch = (path: string): string =>
  `*** Begin Patch\n*** Add File: ${path}\n+malicious\n*** End Patch`
const deletePatch = (path: string): string =>
  `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch`
const movePatch = (from: string, to: string): string =>
  `*** Begin Patch\n*** Update File: ${from}\n*** Move to: ${to}\n@@\n-old\n+new\n*** End Patch`

// ── UNIT: patchWriteEffects extracts every touched path (heuristic-free) ──
describe("patchWriteEffects — closed V4A op extraction", () => {
  test("apply_patch Add File → the added path is an effect", () => {
    const eff = patchWriteEffects("apply_patch", { patch: addPatch("docs/leak.md") }, "/repo")
    expect(eff.map((e) => e.path)).toEqual(["/repo/docs/leak.md"])
  })

  test("apply_patch Delete File → the deleted path is an effect", () => {
    const eff = patchWriteEffects("apply_patch", { patch: deletePatch("docs/gone.md") }, "/repo")
    expect(eff.map((e) => e.path)).toEqual(["/repo/docs/gone.md"])
  })

  test("apply_patch Update+Move → BOTH the source AND the move destination are effects", () => {
    const eff = patchWriteEffects(
      "apply_patch",
      { patch: movePatch("src/a.ts", ".github/workflows/evil.yml") },
      "/repo",
    )
    const paths = eff.map((e) => e.path)
    // LOAD-BEARING: the move destination is a write target too — a fence that
    // only saw the source would let a subagent smuggle a file OUT of owned via
    // moveTo. Both must surface.
    expect(paths).toContain("/repo/src/a.ts")
    expect(paths).toContain("/repo/.github/workflows/evil.yml")
  })

  test("apply_patch_structured is also covered (same closed set)", () => {
    const eff = patchWriteEffects(
      "apply_patch_structured",
      { patch: addPatch("docs/x.md") },
      "/repo",
    )
    expect(eff.map((e) => e.path)).toEqual(["/repo/docs/x.md"])
  })

  test("a non-patch tool ⇒ [] (no over-reach); unparseable patch ⇒ [] (no-throw)", () => {
    expect(patchWriteEffects("write", { patch: addPatch("x") }, "/repo")).toEqual([])
    expect(patchWriteEffects("apply_patch", { patch: "garbage not a patch" }, "/repo")).toEqual([])
    expect(patchWriteEffects("apply_patch", { notpatch: 1 }, "/repo")).toEqual([])
  })
})

// ── DISPATCH E2E: the fence actually fires in the real pipeline ──
const patchTool = (name: string): Tool => ({
  name,
  description: "patch test tool",
  inputSchema: z.object({ patch: z.string() }) as z.ZodType<unknown>,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute(): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: "applied" } } satisfies ToolEvent
  },
})
const scriptedTool = (): Tool => ({
  name: "scripted_replace",
  description: "scripted replace test tool",
  inputSchema: z.object({ file: z.string() }) as z.ZodType<unknown>,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute(): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: "replaced" } } satisfies ToolEvent
  },
})

const perm: PermissionContext = { mode: "acceptEdits" }
const baseCfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry: new ToolRegistry([patchTool("apply_patch"), scriptedTool()]),
    cwd: "/repo",
    signal: new AbortController().signal,
    permission: perm,
    ...over,
  }) as AgentConfig
const enforced = buildOwnershipPolicy({ owned: ["src"], cwd: "/repo", enforced: true })
const patchCall = (patch: string): ToolUseBlock => ({
  type: "tool_use",
  id: "c1",
  name: "apply_patch",
  input: { patch },
})
const scriptedCall = (file: string): ToolUseBlock => ({
  type: "tool_use",
  id: "c2",
  name: "scripted_replace",
  input: { file },
})

describe("§20.4 dispatch E2E — apply_patch / scripted_replace no longer bypass the fence", () => {
  test("ENFORCED: apply_patch to an UNOWNED path ⇒ HARD-DENIED (was a silent escape)", async () => {
    const res = await dispatchTool(
      patchCall(addPatch("docs/leak.md")),
      baseCfg(enforced ? { ownershipPolicy: enforced } : {}),
      perm,
    )
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected deny")
    expect(res.preview).toBe("ownership-policy-denied")
    expect(res.block.content.toLowerCase()).toContain("ownership boundary")
  })

  test("ENFORCED: apply_patch Move-to an UNOWNED destination ⇒ DENIED (moveTo covered)", async () => {
    const res = await dispatchTool(
      patchCall(movePatch("src/a.ts", ".github/workflows/evil.yml")),
      baseCfg(enforced ? { ownershipPolicy: enforced } : {}),
      perm,
    )
    expect(res.ok).toBe(false)
  })

  test("ENFORCED: scripted_replace {file} OUTSIDE owned ⇒ DENIED (file duck-read)", async () => {
    const res = await dispatchTool(
      scriptedCall("/repo/docs/leak.md"),
      baseCfg(enforced ? { ownershipPolicy: enforced } : {}),
      perm,
    )
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected deny")
    expect(res.preview).toBe("ownership-policy-denied")
  })

  test("ENFORCED: apply_patch INSIDE owned ⇒ RUNS (no over-block)", async () => {
    const res = await dispatchTool(
      patchCall(addPatch("src/new.ts")),
      baseCfg(enforced ? { ownershipPolicy: enforced } : {}),
      perm,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error("expected run")
    expect(res.preview).toBe("applied")
  })

  test("DEFAULT-OFF: enforced:false ⇒ apply_patch outside owned RUNS (byte-identical)", async () => {
    const off = buildOwnershipPolicy({ owned: ["src"], cwd: "/repo", enforced: false })
    const res = await dispatchTool(
      patchCall(addPatch("docs/x.md")),
      baseCfg(off ? { ownershipPolicy: off } : {}),
      perm,
    )
    expect(res.ok).toBe(true)
  })
})
