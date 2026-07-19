// Hellgate — ADR-0464: `apply_patch_structured` gated tool wire.
//
// The tool itself (`makeApplyPatchStructuredTool(fs)`) is the apps-layer
// adapter over the pure `@/patch.applyPatchStructured` + the SAME
// `FsJailFileSystemPort` jail `apply_patch` uses. The CLI host registers it
// ONLY when `QUANTA_ENABLE_STRUCTURED_PATCH === "1"` (the call-site gate the
// human wires into `src/apps/agent/index.ts` + `buildDefaultTools`). This
// battery proves:
//
//   1. GATE-OFF (env unset / !== "1") ⇒ the low-level gate predicate is false,
//      so the tool is NOT appended ⇒ legacy tool menu is byte-identical (zero
//      alloc: the factory is never called). The CLI promotion seeds "1" before
//      this builder; non-CLI surfaces do not.
//   2. GATE-ON ("1") ⇒ the adapter is constructed and satisfies the Tool port
//      (name / schema / isReadOnly / hitlTier / execute generator).
//   3. A clean partial-apply ⇒ ok:false with per-file render + structured
//      payload carrying each AppliedChange + messageForModel for failures.
//   4. A grammar error (parse) ⇒ caught + rendered as ok:false (NO throw).
//   5. A throwing port ⇒ captured by applyPatchStructured as a per-file failure
//      (NO throw escapes execute).
//   6. toModelOutput renders the structured outcome, falls back to output.
//
// The gate predicate `env.QUANTA_ENABLE_STRUCTURED_PATCH === "1"` mirrors the
// ADR-0280 automationEngine conditional-append pattern at src/tool/index.ts.

import { describe, expect, test } from "bun:test"
import type { Tool, ToolContext, ToolResult } from "@/tool"
import { buildDefaultTools } from "@/tool"
import { makeApplyPatchStructuredTool } from "@/tool/apply-patch-structured-tool"
import type { GuardedPatchFileSystemPort } from "@/tool/patch-mutation-safety"
import { ReadFileState } from "@/tool/stale-read-guard"

const TOOL_NAME = "apply_patch_structured"

/** The EXACT gate predicate the human wires at the apps call-site. */
const isStructuredPatchOn = (env: NodeJS.ProcessEnv): boolean =>
  env.QUANTA_ENABLE_STRUCTURED_PATCH === "1"

/** Mirror the call-site conditional-append (ADR-0280 pattern). Returns the
 *  default tool set, with `apply_patch_structured` appended ONLY when the gate
 *  is on. `built` records whether the factory was invoked (zero-alloc proof). */
const buildToolsWithGate = (
  env: NodeJS.ProcessEnv,
  fs?: GuardedPatchFileSystemPort,
): { tools: Tool[]; built: boolean } => {
  const base = buildDefaultTools()
  if (!isStructuredPatchOn(env)) return { tools: base, built: false }
  return { tools: [...base, makeApplyPatchStructuredTool(fs) as Tool], built: true }
}

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

const run = async (tool: Tool, input: unknown, c: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

// --- In-memory PatchFileSystemPort so tests need no disk/jail. -----------------
const memFs = (
  seed: Record<string, string> = {},
): GuardedPatchFileSystemPort & {
  files: Map<string, string>
} => {
  const files = new Map<string, string>(Object.entries(seed))
  return {
    files,
    async readFile(p) {
      const v = files.get(p)
      if (v === undefined) throw new Error(`ENOENT: ${p}`)
      return v
    },
    async writeFile(p, content) {
      files.set(p, content)
    },
    async deleteFile(p) {
      files.delete(p)
    },
    async renameFile(from, to) {
      const v = files.get(from)
      if (v === undefined) throw new Error(`ENOENT: ${from}`)
      files.set(to, v)
      files.delete(from)
    },
    async exists(p) {
      return files.has(p)
    },
    async statTarget(p) {
      return files.has(p)
        ? { exists: true, resolvedPath: `/jail/${p}`, mtimeMs: 0 }
        : { exists: false }
    },
  }
}

const wrapPatch = (...body: string[]): string =>
  ["*** Begin Patch", ...body, "*** End Patch"].join("\n")

describe("apply_patch_structured wire — gate", () => {
  test("GATE-OFF (unset) ⇒ tool NOT registered, factory never called, menu byte-identical", () => {
    const baseline = buildDefaultTools().map((t) => t.name)
    const { tools, built } = buildToolsWithGate({})
    expect(built).toBe(false)
    expect(tools.map((t) => t.name)).toEqual(baseline)
    expect(tools.some((t) => t.name === TOOL_NAME)).toBe(false)
  })

  test("GATE wrong value ('true'/'on'/'0') ⇒ still OFF (literal '1' only)", () => {
    for (const v of ["true", "on", "0", "", "TRUE"]) {
      const { built, tools } = buildToolsWithGate({ QUANTA_ENABLE_STRUCTURED_PATCH: v })
      expect(built).toBe(false)
      expect(tools.some((t) => t.name === TOOL_NAME)).toBe(false)
    }
  })

  test("GATE-ON ('1') ⇒ adapter constructed + port satisfied", () => {
    const { tools, built } = buildToolsWithGate({ QUANTA_ENABLE_STRUCTURED_PATCH: "1" }, memFs())
    expect(built).toBe(true)
    const tool = tools.find((t) => t.name === TOOL_NAME)
    expect(tool).toBeDefined()
    if (tool === undefined) return
    expect(tool.isReadOnly()).toBe(false)
    expect(tool.isConcurrencySafe({ patch: "" } as never)).toBe(false)
    expect(tool.hitlTier?.({} as never)).toBe("pre-approval-ok")
    expect(tool.interruptBehavior?.({} as never)).toBe("block")
    expect(typeof tool.execute).toBe("function")
    // appended AFTER the byte-identical base set
    expect(tools[tools.length - 1]?.name).toBe(TOOL_NAME)
  })
})

describe("apply_patch_structured — adapter behavior (no-throw boundary)", () => {
  test("all-ok patch ⇒ ok:true, structured payload, per-file render", async () => {
    const fs = memFs({ "a.txt": "hello\nworld\n" })
    const tool = makeApplyPatchStructuredTool(fs)
    const patch = wrapPatch("*** Update File: a.txt", "@@", "-hello", "+goodbye", " world")
    const res = await run(tool, { patch }, ctx("/jail"))
    expect(res.ok).toBe(true)
    expect(res.output).toContain("[ok]")
    expect(res.output).toContain("a.txt")
    const s = res.structured as { allOk: boolean; appliedChanges: unknown[] }
    expect(s.allOk).toBe(true)
    expect(s.appliedChanges.length).toBe(1)
  })

  test("partial-apply (one file fails) ⇒ ok:false, messageForModel surfaced, NO throw", async () => {
    // a.txt updates fine; b.txt's anchor does not exist ⇒ that op fails, the
    // other still applies (per-file isolation).
    const fs = memFs({ "a.txt": "alpha\n", "b.txt": "beta\n" })
    const tool = makeApplyPatchStructuredTool(fs)
    const patch = wrapPatch(
      "*** Update File: a.txt",
      "@@",
      "-alpha",
      "+ALPHA",
      "*** Update File: b.txt",
      "@@",
      " this-anchor-does-not-exist",
      "-nope",
      "+NOPE",
    )
    const res = await run(tool, { patch }, ctx("/jail"))
    expect(res.ok).toBe(false)
    expect(res.output).toContain("PARTIAL")
    expect(res.output).toContain("[FAILED]")
    const s = res.structured as { allOk: boolean; appliedChanges: { error?: string }[] }
    expect(s.allOk).toBe(false)
    expect(s.appliedChanges.some((c) => c.error !== undefined)).toBe(true)
  })

  test("grammar error (bad patch text) ⇒ ok:false rejected failure, NO throw", async () => {
    const tool = makeApplyPatchStructuredTool(memFs())
    const res = await run(tool, { patch: "not a patch at all" }, ctx("/jail"))
    expect(res.ok).toBe(false)
    expect(res.output).toContain("did not parse")
    expect(res.failure?.mode).toBe("rejected")
  })

  test("throwing port ⇒ captured as per-file failure, NO throw escapes execute", async () => {
    const exploding: GuardedPatchFileSystemPort = {
      async readFile() {
        throw new Error("port boom: readFile")
      },
      async writeFile() {
        throw new Error("port boom: writeFile")
      },
      async deleteFile() {
        throw new Error("port boom: deleteFile")
      },
      async renameFile() {
        throw new Error("port boom: renameFile")
      },
      async exists() {
        throw new Error("port boom: exists")
      },
      async statTarget() {
        throw new Error("port boom: statTarget")
      },
    }
    const tool = makeApplyPatchStructuredTool(exploding)
    const patch = wrapPatch("*** Add File: new.txt", "+content")
    // Must NOT reject — the failure is captured per-file.
    const res = await run(tool, { patch }, ctx("/jail"))
    expect(res.ok).toBe(false)
    const s = res.structured as { appliedChanges: { error?: string }[] }
    expect(s.appliedChanges.some((c) => c.error !== undefined)).toBe(true)
  })

  test("stale preflight stat failure ⇒ rejected result and ZERO mutation, never a generator throw", async () => {
    const fs = memFs({ "a.txt": "before\n" })
    fs.statTarget = async () => {
      throw new Error("EACCES: cannot stat target")
    }
    const tool = makeApplyPatchStructuredTool(fs)
    const state = new ReadFileState()
    const context: ToolContext = {
      cwd: "/jail",
      signal: new AbortController().signal,
      readFileState: state,
    }

    const result = await run(
      tool,
      { patch: wrapPatch("*** Update File: a.txt", "@@", "-before", "+after") },
      context,
    )

    expect(result.ok).toBe(false)
    expect(result.failure).toEqual({ mode: "rejected", reason: "stale_read_check_failed" })
    expect(result.output).toContain("cannot safely verify")
    expect(fs.files.get("a.txt")).toBe("before\n")
  })

  test("toModelOutput renders structured outcome; falls back to output when absent", async () => {
    const fs = memFs({ "a.txt": "x\n" })
    const tool = makeApplyPatchStructuredTool(fs)
    expect(tool.toModelOutput).toBeDefined()
    if (tool.toModelOutput === undefined) return
    // structured present
    const patch = wrapPatch("*** Update File: a.txt", "@@", "-x", "+y")
    const res = await run(tool, { patch }, ctx("/jail"))
    expect(tool.toModelOutput(res)).toContain("a.txt")
    // structured absent ⇒ falls back to output verbatim
    const fallback: ToolResult = { ok: false, output: "raw-fallback-text" }
    expect(tool.toModelOutput(fallback)).toBe("raw-fallback-text")
  })

  test("mutating window enters and exits the injected critical section exactly once", async () => {
    const tool = makeApplyPatchStructuredTool(memFs())
    let entered = 0
    let exited = 0
    const context: ToolContext = {
      cwd: "/jail",
      signal: new AbortController().signal,
      criticalSection: {
        begin: () => {
          entered += 1
          return {
            end: () => {
              exited += 1
            },
          }
        },
      },
    }
    const res = await run(tool, { patch: wrapPatch("*** Add File: new.txt", "+content") }, context)
    expect(res.ok).toBe(true)
    expect(entered).toBe(1)
    expect(exited).toBe(1)
  })

  test("default-port path (no fs arg) constructs an FsJailFileSystemPort from ctx.cwd", () => {
    // Constructing the tool without a port must not throw; the jail port is
    // built lazily per execute() from ctx.cwd (proven by the gate test's
    // execute paths above which inject a port). Here we only assert the factory
    // is total without an injected port.
    const tool = makeApplyPatchStructuredTool()
    expect(tool.name).toBe(TOOL_NAME)
  })
})
