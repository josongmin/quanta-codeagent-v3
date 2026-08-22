/**
 * code-mode (RFC jun-6-code-mode, Phase 2) — FULL-SURFACE e2e (REAL quickjs +
 * REAL dispatchTool).
 *
 * The make-or-break Phase-2 proof: a cell that calls 3+ DIFFERENT tools in a
 * DATA-FLOW chain (read → grep → write) routes EVERY call through the REAL
 * `dispatchTool` via `buildCodeCellDispatchPort` (the loop's live config /
 * permission), in order, and the chain's result is correct. We also prove:
 *   - a `tools.bash` call whose dispatch DENIES (HARD_DENY analog) is blocked
 *     exactly as a direct call (the cell catches but cannot make it succeed);
 *   - the full surface is driven from the agent's ACTUAL `registry.toolNames()`
 *     surfaced through `AgentConfig.codeCellSurfaceTools`;
 *   - code_mode_only directive is present when gated + absent when off;
 *   - default-OFF byte-identity: the Phase-1 3-tool surface is unchanged when no
 *     surfaceTools is supplied.
 *
 * Stays inside the reliable runtime envelope (the sync native-promise drive
 * handles arbitrary nesting; 3-call chains are well within it).
 */

import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { buildCodeCellDispatchPort } from "@/agent/codemode-wire"
import {
  CODE_MODE_ONLY_DIRECTIVE,
  type DirectiveConfig,
  selectActiveDirectives,
} from "@/agent/prompt-directives"
import type { AgentConfig } from "@/agent/types"
import { runCodeCell } from "@/codemode"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import { type Tool, type ToolEvent, ToolRegistry } from "@/tool"

const LIMITS = {
  memoryBytes: 64 * 1024 * 1024,
  timeoutMs: 2000,
  maxCalls: 64,
  outputCap: 16 * 1024,
}
const now = () => performance.now()
const perm: PermissionContext = { mode: "acceptEdits" }

/** An ordered ledger of every real in-cell dispatch that PASSED the gate (the
 *  tool's execute ran ⇒ admitted). The chain asserts ordering on this. */
type GateLog = Array<{ tool: string; input: unknown }>

const recordingTool = (
  name: string,
  log: GateLog,
  schema: z.ZodType<unknown>,
  reply: (input: unknown) => string,
): Tool => ({
  name,
  description: `recording ${name}`,
  inputSchema: schema,
  isReadOnly: () => name === "read" || name === "grep",
  isConcurrencySafe: () => true,
  execute: async function* (input): AsyncIterable<ToolEvent> {
    log.push({ tool: name, input })
    yield { type: "result", result: { ok: true, output: reply(input) } }
  },
})

const chainTools = (log: GateLog): Tool[] => [
  recordingTool("read", log, z.object({ path: z.string() }), (i) => {
    // The "file" content the read returns (data-flow source).
    const p = (i as { path: string }).path
    return JSON.stringify({ lines: ["alpha TODO", "beta", "gamma TODO"], path: p })
  }),
  recordingTool("grep", log, z.object({ pattern: z.string(), content: z.string() }), (i) => {
    const { pattern, content } = i as { pattern: string; content: string }
    const hits = content.split("\n").filter((l) => l.includes(pattern))
    return JSON.stringify({ count: hits.length })
  }),
  recordingTool(
    "write",
    log,
    z.object({ path: z.string(), content: z.string() }),
    (i) => `wrote ${(i as { content: string }).content.length} bytes`,
  ),
]

const configFor = (tools: Tool[]): AgentConfig =>
  ({
    registry: new ToolRegistry(tools),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: perm,
  }) as AgentConfig

const originalPermissionState = process.env.QUANTA_PERMISSION_STATE
let permRoot: string | null = null
beforeEach(() => {
  permRoot = mkdtempSync(join(tmpdir(), "code-mode-full-surface-"))
  process.env.QUANTA_PERMISSION_STATE = join(permRoot, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})
afterEach(() => {
  if (permRoot !== null) {
    rmSync(permRoot, { recursive: true, force: true })
    permRoot = null
  }
  if (originalPermissionState === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = originalPermissionState
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

test("e2e — a 3-tool data-flow chain (read→grep→write) all gated IN ORDER, correct result", async () => {
  const log: GateLog = []
  const config = configFor(chainTools(log))
  const surface = config.registry.toolNames() // FULL surface = the 3 chain tools
  const port = buildCodeCellDispatchPort({ config, permission: perm, cellId: "chain" })

  const r = await runCodeCell({
    code: `
      // read returns a JSON string; the cell parses it, greps its content for
      // "TODO", then writes a summary keyed on the grep count — true data-flow.
      const fileStr = await tools.read({ path: "notes.txt" });
      const file = JSON.parse(fileStr);
      const grepStr = await tools.grep({ pattern: "TODO", content: file.lines.join("\\n") });
      const grep = JSON.parse(grepStr);
      const summary = "found " + grep.count + " TODOs in " + file.path;
      const res = await tools.write({ path: "summary.txt", content: summary });
      return { summary, res };
    `,
    dispatch: port,
    surfaceTools: surface,
    limits: LIMITS,
    signal: new AbortController().signal,
    now,
  })

  // ORDER: every call passed the REAL dispatchTool gate (execute ran) in the
  // data-flow order read → grep → write.
  expect(log.map((e) => e.tool)).toEqual(["read", "grep", "write"])
  // The grep operated on the read's OUTPUT (data flowed through the cell), and
  // the write recorded the derived summary — chain result correct.
  expect(r.status).toBe("ok")
  expect(r.output).toContain("found 2 TODOs in notes.txt")
  // The grep saw the content the read returned (2 TODO lines).
  expect((log[1]?.input as { content: string }).content).toContain("alpha TODO")
})

test("e2e — a tools.bash HARD_DENY (unknown/denied tool) is BLOCKED exactly as direct", async () => {
  const log: GateLog = []
  // `bash` is bound in the cell surface but NOT registered ⇒ dispatchTool denies
  // ("Unknown tool", the same no-throw ok:false path a HARD_DENY produces).
  const config = configFor(chainTools(log))
  const port = buildCodeCellDispatchPort({ config, permission: perm, cellId: "deny" })
  const r = await runCodeCell({
    code: `
      let blocked = false;
      try { await tools.bash({ command: "rm -rf /" }); }
      catch (e) { blocked = true; }
      return blocked;
    `,
    dispatch: port,
    surfaceTools: ["read", "grep", "write", "bash"], // bash bound but denied at dispatch
    limits: LIMITS,
    signal: new AbortController().signal,
    now,
  })
  // The bash call was DENIED by the real dispatcher; the cell caught the throw
  // but ZERO write/exec happened (the chain log is untouched).
  expect(r.output).toContain("true")
  expect(log.length).toBe(0)
})

test("e2e — default-OFF byte-identity: absent surfaceTools ⇒ Phase-1 3-tool surface only", async () => {
  const log: GateLog = []
  const config = configFor(chainTools(log))
  const port = buildCodeCellDispatchPort({ config, permission: perm, cellId: "default" })
  const r = await runCodeCell({
    // No surfaceTools supplied ⇒ only read/grep/write bound; `bash` is undefined.
    code: `return [typeof tools.read, typeof tools.grep, typeof tools.write, typeof tools.bash].join(",");`,
    dispatch: port,
    limits: LIMITS,
    signal: new AbortController().signal,
    now,
  })
  expect(r.output).toContain("function,function,function,undefined")
})

// ───────────────────── code_mode_only directive presence ────────────────────

const ALL_OFF: DirectiveConfig = {
  directiveAutonomous: false,
  directiveReadComplete: false,
  directiveProgress: false,
  directiveMemoryVerify: false,
  directiveThinkFreq: false,
  directiveAntiPlatitude: false,
  directiveParallelTools: false,
  directiveAdvisorRail: false,
  codeModeOnly: false,
}

test("e2e — code_mode_only directive PRESENT when gated, ABSENT when off", () => {
  expect(selectActiveDirectives({ ...ALL_OFF, codeModeOnly: true })).toBe(CODE_MODE_ONLY_DIRECTIVE)
  expect(selectActiveDirectives(ALL_OFF)).toBe("")
})
