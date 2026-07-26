/**
 * SECURITY HELLGATE (jul-26 → jul-27, 3-round audit findings): the jul-19
 * apply_patch fence fix ({@link patchWriteEffects}) closed the patch-tool false
 * fence but was INCOMPLETE — GATED write-capable tools still escaped the subagent
 * FS-ownership fence (`QUANTA_FS_OWNERSHIP_ENFORCE=1`). The objective enumeration
 * audit (jul-27) surfaced the full set via the mutating-table + gated-manifest
 * universes (see ownership-fence-drift-hellgate.test.ts — the anti-regression
 * ratchet). This test pins the BEHAVIOR for each closed hole:
 *
 *   STATICALLY EXTRACTABLE (write target is a literal input field the leaf's
 *   `path`/`file` duck-read misses) — now covered by `fieldWriteEffects`:
 *     · image_gen              → `outputPath`  (single destination string)
 *     · shadow_restore_partial → `paths[]`     (repo-relative array)
 *     · appshot_verify         → `out_dir`     (scaffold directory)
 *
 *   UNFENCEABLE (target not statically knowable at dispatch) — now FAIL-CLOSED
 *   under enforcement by `isUnfenceableWriteTool`:
 *     · lsp_rename_apply     (multi-file WorkspaceEdit computed by the LSP server)
 *     · shadow_rewind        (whole-workspace snapshot restore, no path)
 *     · mcp_read_resource    (blob written to a SERVER-derived path; input = uri)
 *     · node_repl            (arbitrary host Node with full `fs`; unparseable)
 *     · skill_create         (`<name>/SKILL.md` at a host-derived skills path)
 *     · mcp_connector_install (`.mcp.json` at a host-derived config path)
 *
 * RED-first: remove the `fieldWriteEffects` union OR the `isUnfenceableWriteTool`
 * guard in dispatch.ts:consultOwnership ⇒ the corresponding DENY cases flip back
 * to `ok:true` (escape). Verified by reverting each in-tree.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import {
  buildOwnershipPolicy,
  fieldWriteEffects,
  isUnfenceableWriteTool,
} from "@/agent/ownership-policy"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

// ── UNIT: fieldWriteEffects extracts the literal field targets (heuristic-free) ──
describe("fieldWriteEffects — closed tool→field extraction", () => {
  test("image_gen → outputPath is a canonical effect", () => {
    const eff = fieldWriteEffects("image_gen", { outputPath: "docs/leak.png" }, "/repo")
    expect(eff.map((e) => e.path)).toEqual(["/repo/docs/leak.png"])
  })

  test("shadow_restore_partial → EVERY entry of paths[] is an effect", () => {
    const eff = fieldWriteEffects(
      "shadow_restore_partial",
      { paths: ["src/a.ts", "docs/evil.md", ""] },
      "/repo",
    )
    // empty strings dropped; both real paths surface
    expect(eff.map((e) => e.path)).toEqual(["/repo/src/a.ts", "/repo/docs/evil.md"])
  })

  test("wrong tool / wrong shape / missing field ⇒ [] (no over-reach, no throw)", () => {
    expect(fieldWriteEffects("write", { outputPath: "x" }, "/repo")).toEqual([])
    expect(fieldWriteEffects("image_gen", { outputPath: 42 }, "/repo")).toEqual([])
    expect(fieldWriteEffects("image_gen", { nope: "x" }, "/repo")).toEqual([])
    expect(fieldWriteEffects("shadow_restore_partial", { paths: "not-array" }, "/repo")).toEqual([])
    expect(fieldWriteEffects("image_gen", null, "/repo")).toEqual([])
  })
})

// ── UNIT: the unfenceable set is exactly the six server/computed/arbitrary tools ──
describe("isUnfenceableWriteTool — closed fail-closed set", () => {
  test("ALL six unfenceable writers are flagged", () => {
    for (const t of [
      "lsp_rename_apply",
      "shadow_rewind",
      "mcp_read_resource",
      "node_repl",
      "skill_create",
      "mcp_connector_install",
    ]) {
      expect(isUnfenceableWriteTool(t)).toBe(true)
    }
  })
  test("fenceable / read-only tools are NOT flagged (no over-block)", () => {
    for (const t of ["write", "apply_patch", "image_gen", "shadow_restore_partial", "read"]) {
      expect(isUnfenceableWriteTool(t)).toBe(false)
    }
  })
})

// ── DISPATCH E2E: the fence fires in the real pipeline ──
const mkTool = (name: string, schema: z.ZodType<unknown>): Tool => ({
  name,
  description: `${name} test tool`,
  inputSchema: schema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute(): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: "ran" } } satisfies ToolEvent
  },
})

const perm: PermissionContext = { mode: "acceptEdits" }
const registry = new ToolRegistry([
  mkTool("image_gen", z.object({ outputPath: z.string() }) as z.ZodType<unknown>),
  mkTool("shadow_restore_partial", z.object({ paths: z.array(z.string()) }) as z.ZodType<unknown>),
  mkTool("appshot_verify", z.object({ out_dir: z.string() }) as z.ZodType<unknown>),
  mkTool("lsp_rename_apply", z.object({ path: z.string() }) as z.ZodType<unknown>),
  mkTool("shadow_rewind", z.object({}) as z.ZodType<unknown>),
  mkTool("mcp_read_resource", z.object({ uri: z.string() }) as z.ZodType<unknown>),
  mkTool("node_repl", z.object({ code: z.string() }) as z.ZodType<unknown>),
  mkTool("skill_create", z.object({ name: z.string() }) as z.ZodType<unknown>),
  mkTool("mcp_connector_install", z.object({ id: z.string() }) as z.ZodType<unknown>),
])
const baseCfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry,
    cwd: "/repo",
    signal: new AbortController().signal,
    permission: perm,
    ...over,
  }) as AgentConfig
const enforced = buildOwnershipPolicy({ owned: ["src"], cwd: "/repo", enforced: true })
const enforcedCfg = () => baseCfg(enforced ? { ownershipPolicy: enforced } : {})
const call = (name: string, input: unknown): ToolUseBlock => ({
  type: "tool_use",
  id: `c-${name}`,
  name,
  input,
})

describe("§20.4 dispatch E2E — field writers no longer bypass the fence", () => {
  test("ENFORCED: image_gen outputPath OUTSIDE owned ⇒ HARD-DENIED (was a silent escape)", async () => {
    const res = await dispatchTool(
      call("image_gen", { outputPath: "docs/leak.png" }),
      enforcedCfg(),
      perm,
    )
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected deny")
    expect(res.preview).toBe("ownership-policy-denied")
  })

  test("ENFORCED: image_gen outputPath INSIDE owned ⇒ RUNS (no over-block)", async () => {
    const res = await dispatchTool(
      call("image_gen", { outputPath: "src/ok.png" }),
      enforcedCfg(),
      perm,
    )
    expect(res.ok).toBe(true)
  })

  test("ENFORCED: shadow_restore_partial with ONE unowned path ⇒ DENIED (any escapes)", async () => {
    const res = await dispatchTool(
      call("shadow_restore_partial", { paths: ["src/a.ts", "docs/evil.md"] }),
      enforcedCfg(),
      perm,
    )
    expect(res.ok).toBe(false)
  })

  test("ENFORCED: shadow_restore_partial all-owned ⇒ RUNS", async () => {
    const res = await dispatchTool(
      call("shadow_restore_partial", { paths: ["src/a.ts", "src/b.ts"] }),
      enforcedCfg(),
      perm,
    )
    expect(res.ok).toBe(true)
  })

  test("ENFORCED: appshot_verify out_dir OUTSIDE owned ⇒ DENIED", async () => {
    const res = await dispatchTool(
      call("appshot_verify", { out_dir: "docs/shots" }),
      enforcedCfg(),
      perm,
    )
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected deny")
    expect(res.preview).toBe("ownership-policy-denied")
  })

  test("ENFORCED: appshot_verify out_dir INSIDE owned ⇒ RUNS", async () => {
    const res = await dispatchTool(
      call("appshot_verify", { out_dir: "src/shots" }),
      enforcedCfg(),
      perm,
    )
    expect(res.ok).toBe(true)
  })
})

describe("§20.4 dispatch E2E — unfenceable writers are FAIL-CLOSED under enforcement", () => {
  for (const [name, input] of [
    ["lsp_rename_apply", { path: "src/a.ts" }], // anchor is INSIDE owned — still denied
    ["shadow_rewind", {}],
    ["mcp_read_resource", { uri: "file:///whatever" }],
    ["node_repl", { code: "require('fs').writeFileSync('../escape', 'x')" }],
    ["skill_create", { name: "evil" }],
    ["mcp_connector_install", { id: "evil" }],
  ] as const) {
    test(`ENFORCED: ${name} ⇒ DENIED (target not statically knowable)`, async () => {
      const res = await dispatchTool(call(name, input), enforcedCfg(), perm)
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error("expected deny")
      expect(res.preview).toBe("ownership-policy-denied")
      expect(res.block.content.toLowerCase()).toContain("unfenceable")
    })
  }

  test("DEFAULT-OFF: enforced:false ⇒ unfenceable writer RUNS (byte-identical legacy)", async () => {
    const off = buildOwnershipPolicy({ owned: ["src"], cwd: "/repo", enforced: false })
    const res = await dispatchTool(
      call("shadow_rewind", {}),
      baseCfg(off ? { ownershipPolicy: off } : {}),
      perm,
    )
    expect(res.ok).toBe(true)
  })
})
