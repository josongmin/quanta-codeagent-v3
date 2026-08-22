/**
 * STRUCTURAL DRIFT HELLGATE (jul-27) — the anti-whack-a-mole ratchet.
 *
 * BACKGROUND: the subagent FS-ownership fence was patched TWICE for incomplete
 * coverage (jul-19 apply_patch, jul-26 field/fail-closed) because nothing tied
 * its closed tool-sets back to the registry's actual write-capable universe — a
 * new write tool silently escaped until someone remembered it. This test closes
 * that class of regression: it cross-checks `OWNERSHIP_WRITE_CLASSIFICATION`
 * (the SSOT) against BOTH machine-readable universes, so a NEW write-capable
 * tool that isn't classified FAILS CI.
 *
 *   Universe 1 — `MUTATING_TOOL_TABLE` (mode.ts): every tool whose kind is
 *     write_filesystem / bash_mutating / git_mutating (can touch host FS).
 *   Universe 2 — gated tool-surface manifest (`GATED_TOOLS`): every entry (and
 *     its group members) with risk:"mutating" (gated write tools invisible to
 *     the mutating table, e.g. lsp_rename_apply).
 *
 * Plus internal consistency: the runtime fence sets (FIELD/UNFENCEABLE/PATCH)
 * MUST equal the classification's field/fail-closed/patch buckets — so the map
 * and the code that reads it cannot drift apart.
 *
 * RED-first proof: delete any classification entry (or any runtime-set member)
 * ⇒ a cross-check below goes RED naming the exact unclassified tool.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { planModeMutatingTable } from "@/agent/mode"
import type { OwnershipWriteClass } from "@/agent/ownership-policy"
import {
  buildOwnershipPolicy,
  OWNERSHIP_WRITE_CLASSIFICATION,
  ownershipWriteSets,
} from "@/agent/ownership-policy"
import type { PermissionContext } from "@/permission"
import type { Tool, ToolEvent } from "@/tool"
import { buildDefaultTools, GATED_TOOLS, ToolRegistry } from "@/tool"

const CLASSIFIED = new Set(Object.keys(OWNERSHIP_WRITE_CLASSIFICATION))

// FS-touchable mutating kinds — the kinds whose members CAN write a host FS path.
const FS_TOUCHABLE_KINDS = new Set(["write_filesystem", "bash_mutating", "git_mutating"])

describe("ownership fence — SSOT covers Universe 1 (MUTATING_TOOL_TABLE FS kinds)", () => {
  test("every write_filesystem/bash_mutating/git_mutating tool is classified", () => {
    const table = planModeMutatingTable()
    const unclassified = Object.entries(table)
      .filter(([, kind]) => kind !== null && FS_TOUCHABLE_KINDS.has(kind))
      .map(([name]) => name)
      .filter((name) => !CLASSIFIED.has(name))
    // If this fails, add the named tool(s) to OWNERSHIP_WRITE_CLASSIFICATION with
    // the correct class (leaf/patch/field/shell/fail-closed/non-fs).
    expect(unclassified).toEqual([])
  })
})

describe("ownership fence — SSOT covers Universe 2 (gated risk:mutating manifest)", () => {
  test("every gated risk:mutating tool (and group member) is classified", () => {
    const gatedMutating = new Set<string>()
    for (const entry of GATED_TOOLS) {
      if (entry.risk !== "mutating") continue
      gatedMutating.add(entry.name)
      for (const g of entry.group ?? []) gatedMutating.add(g)
    }
    const unclassified = [...gatedMutating].filter((name) => !CLASSIFIED.has(name)).sort()
    expect(unclassified).toEqual([])
  })
})

describe("ownership fence — SSOT covers Universe 3 (live BASE registry isReadOnly)", () => {
  test("every BASE tool with isReadOnly()===false is classified", () => {
    // Closes residual-limit #2 for the ALWAYS-PRESENT base tools: risk-tag drift
    // (manifest `risk` vs live `isReadOnly()`) can't hide a base write tool from
    // the fence — the runtime SSOT (`isReadOnly()`) is checked directly. Base
    // tools need no ports, so this instantiates the real registry with none.
    const unclassified = buildDefaultTools()
      .filter((t) => !t.isReadOnly())
      .map((t) => t.name)
      .filter((name) => !CLASSIFIED.has(name))
      .sort()
    expect(unclassified).toEqual([])
  })
})

describe("ownership fence — runtime sets equal the classification buckets (no drift)", () => {
  const bucket = (cls: string): string[] =>
    Object.entries(OWNERSHIP_WRITE_CLASSIFICATION)
      .filter(([, c]) => c === cls)
      .map(([n]) => n)
      .sort()

  test("FIELD_WRITE_TOOLS keys === classification 'field'", () => {
    expect([...ownershipWriteSets().field].sort()).toEqual(bucket("field"))
  })
  test("UNFENCEABLE_WRITE_TOOLS === classification 'fail-closed'", () => {
    expect([...ownershipWriteSets().failClosed].sort()).toEqual(bucket("fail-closed"))
  })
  test("PATCH_WRITE_TOOLS === classification 'patch'", () => {
    expect([...ownershipWriteSets().patch].sort()).toEqual(bucket("patch"))
  })
})

describe("ownership fence — no classification is a dead/unknown tool name", () => {
  test("every classified name exists in Universe 1 ∪ Universe 2 (no typos/stale)", () => {
    const table = planModeMutatingTable()
    const universe = new Set<string>(Object.keys(table))
    for (const entry of GATED_TOOLS) {
      universe.add(entry.name)
      for (const g of entry.group ?? []) universe.add(g)
    }
    const orphan = [...CLASSIFIED].filter((name) => !universe.has(name)).sort()
    expect(orphan).toEqual([])
  })
})

// ── the classification is not just bookkeeping: prove the buckets actually fence ──
/**
 * TEETH (aug-22 test-quality audit). This block's NAME promised "every
 * non-'non-fs' class DENIES an out-of-owned write" but its BODY never called the
 * fence once — it only counted map entries. Measured vacuity: forcing
 * `isPathAllowed` to always return `{allowed:true}` (fence fully disabled) left
 * this file at 9 pass / 0 fail.
 *
 * It now DISPATCHES a class-representative escape call for EVERY non-'non-fs'
 * entry through the REAL `dispatchTool` pipeline — the seam `consultOwnership`
 * actually lives on — and requires an `ownership-policy-denied` verdict, with
 * two anti-vacuity controls:
 *   · IN-OWNED control — the same call at an owned target must NOT be
 *     ownership-denied (proves the deny is path-specific, not a blanket block).
 *   · DEFAULT-OFF control — with `enforced:false` the same escapes must RUN
 *     (attributes the deny to the fence, not to some other dispatch gate).
 * 'non-fs' tools are intentionally NOT asserted (out of the content-authoring
 * threat model this fence enforces).
 */
describe("ownership fence — every non-'non-fs' class DENIES an out-of-owned write", () => {
  const CWD = "/repo"
  const OUTSIDE = "/repo/docs/leak.md" // outside owned ["src"]
  const INSIDE = "/repo/src/ok.ts" // inside owned
  const enforced = buildOwnershipPolicy({ owned: ["src"], cwd: CWD, enforced: true })
  const advisory = buildOwnershipPolicy({ owned: ["src"], cwd: CWD, enforced: false })
  test("policy built", () => expect(enforced?.enforced).toBe(true))

  // one representative escape input per non-safe class → all must be fence-relevant
  // (either extracted-and-denied or fail-closed).
  const nonSafe = Object.entries(OWNERSHIP_WRITE_CLASSIFICATION).filter(
    ([, c]) => c !== "non-fs",
  ) as [string, OwnershipWriteClass][]
  test("classification has a non-trivial number of FENCED (non-'non-fs') tools", () => {
    // guards against an accident that flips everything to 'non-fs' (vacuous pass).
    expect(nonSafe.length).toBeGreaterThanOrEqual(15)
  })

  /** The representative ESCAPE input per class — the shape the fence must see
   *  THROUGH to reach `target`: leaf duck-read (`path`), V4A patch body, the
   *  literal field names of the three field writers, a shell redirect. The
   *  switch is exhaustive over {@link OwnershipWriteClass}, so a NEW class
   *  cannot be added without giving it a representative input here. */
  const inputFor = (cls: OwnershipWriteClass, target: string): Record<string, unknown> => {
    switch (cls) {
      case "leaf":
        return { path: target }
      case "patch":
        return { patch: `*** Begin Patch\n*** Add File: ${target}\n+escape\n*** End Patch` }
      case "field":
        // union of the three literal field names — each field tool reads its own.
        return { outputPath: target, paths: [target], out_dir: target }
      case "shell":
        return { command: `echo escape > ${target}` }
      case "fail-closed":
        // benign-looking leaf input on purpose: denial must come from tool
        // IDENTITY, not from anything extractable out of the input.
        return { path: target }
      case "non-fs":
        return {}
    }
  }

  /** Stub standing in for the real (often gated/port-requiring) tool: same NAME,
   *  write-capable (`isReadOnly:false`), and — for the `shell` class — the same
   *  `extractShellCommand` hook the registry uses to hand dispatch a command
   *  string. Executes trivially, so ANY non-ok verdict comes from a gate. */
  const stub = (name: string, cls: OwnershipWriteClass): Tool => ({
    name,
    description: `ownership fence probe stub for ${name}`,
    inputSchema: z.record(z.unknown()) as z.ZodType<unknown>,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async *execute(): AsyncIterable<ToolEvent> {
      yield { type: "result", result: { ok: true, output: "ran" } } satisfies ToolEvent
    },
    ...(cls === "shell"
      ? {
          extractShellCommand: (input: unknown): string =>
            String((input as { command?: string }).command ?? ""),
        }
      : {}),
  })

  const perm: PermissionContext = { mode: "acceptEdits" }
  const registry = new ToolRegistry(nonSafe.map(([name, cls]) => stub(name, cls)))
  const cfg = (policy: ReturnType<typeof buildOwnershipPolicy>): AgentConfig =>
    ({
      registry,
      cwd: CWD,
      signal: new AbortController().signal,
      permission: perm,
      ...(policy ? { ownershipPolicy: policy } : {}),
    }) as AgentConfig

  /** `"ran"` when the tool executed, else the deny's `preview` tag. */
  const verdict = async (
    name: string,
    cls: OwnershipWriteClass,
    target: string,
    policy: ReturnType<typeof buildOwnershipPolicy>,
  ): Promise<string> => {
    const res = await dispatchTool(
      { type: "tool_use", id: `probe-${name}`, name, input: inputFor(cls, target) },
      cfg(policy),
      perm,
    )
    return res.ok ? "ran" : `denied:${String(res.preview ?? "?")}`
  }

  const DENIED = "denied:ownership-policy-denied"

  test("ESCAPE: every non-'non-fs' tool's out-of-owned write is ownership-DENIED", async () => {
    const offenders: string[] = []
    let checked = 0
    for (const [name, cls] of nonSafe) {
      checked += 1
      const v = await verdict(name, cls, OUTSIDE, enforced)
      if (v !== DENIED) offenders.push(`${name} (${cls}) ⇒ ${v}`)
    }
    // floor: the loop cannot go vacuous (an empty classification would pass every
    // `toEqual([])` below).
    expect(checked).toBe(nonSafe.length)
    expect(checked).toBeGreaterThanOrEqual(15)
    // If this fails, the named tool's class does NOT actually fence its escape —
    // either the class is wrong or the class's extractor lost the target.
    expect(offenders).toEqual([])
  })

  test("CONTROL (in-owned): the same call at an OWNED target is not ownership-denied", async () => {
    // Kills the "the fence denies everything" false pass — a broken extractor
    // that denied unconditionally would light this up.
    const offenders: string[] = []
    let checked = 0
    for (const [name, cls] of nonSafe) {
      if (cls === "fail-closed") continue // denied by identity, by design (below)
      checked += 1
      const v = await verdict(name, cls, INSIDE, enforced)
      if (v === DENIED) offenders.push(`${name} (${cls})`)
    }
    expect(checked).toBeGreaterThanOrEqual(10)
    expect(offenders).toEqual([])
  })

  test("fail-closed tools are denied even for an IN-owned target (identity, not path)", async () => {
    const failClosed = nonSafe.filter(([, c]) => c === "fail-closed")
    expect(failClosed.length).toBeGreaterThanOrEqual(6)
    const verdicts = await Promise.all(
      failClosed.map(([name, cls]) => verdict(name, cls, INSIDE, enforced)),
    )
    expect(verdicts).toEqual(failClosed.map(() => DENIED))
  })

  test("CONTROL (default-OFF): enforced:false ⇒ the SAME escapes run (deny is the fence's)", async () => {
    const offenders: string[] = []
    let checked = 0
    for (const [name, cls] of nonSafe) {
      checked += 1
      const v = await verdict(name, cls, OUTSIDE, advisory)
      if (v !== "ran") offenders.push(`${name} (${cls}) ⇒ ${v}`)
    }
    expect(checked).toBe(nonSafe.length)
    expect(offenders).toEqual([])
  })
})
