/**
 * HELLGATE — staleness guard is DEFAULT-ON (SOTA++ / Claude-Code parity upgrade).
 *
 * BEFORE: `QUANTA_STALE_READ_GUARD` was strict opt-in (`=1`). A fresh deployment
 * shipped with ZERO TOCTOU clobber protection — editing a file that drifted on
 * disk since the model read it landed on the drifted bytes silently.
 * AFTER: the guard is DEFAULT-ON (mirrors the fs-jail), torn down ONLY by the
 * deliberate kill-switch `QUANTA_STALE_READ_GUARD=off`.
 *
 * Proven 3 ways:
 *  A. gate contract — unset ⇒ ON; `=off` ⇒ OFF; a stray falsy token stays ON.
 *  B. the REAL host assembler mints a per-session `ReadFileState` by DEFAULT
 *     (no env), and NOT under `=off`.
 *  C. EDIT e2e — drive the REAL `editTool.execute` with a wired `ReadFileState`:
 *     read-record → external mtime bump → edit ⇒ `stale_read` reject, file byte-
 *     untouched. (Fills the edit-tool staleness e2e gap; `apply_patch` already had
 *     `apply-patch-staleness-hellgate`.)
 *
 * RED-ON-INJECTION: reverting `gate.ts` to `gateOnStrict` turns A (unset⇒ON) and
 * B (default mint) RED.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent/types"
import { type AssembleRequest, assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { ToolContext, ToolResult } from "@/tool"
import { editTool } from "@/tool/edit"
import { ReadFileState, STALE_READ_GUARD_ENV, staleReadGuardEnabled } from "@/tool/stale-read-guard"

// ── A. gate contract ────────────────────────────────────────────────────────
describe("[hellgate] staleness DEFAULT-ON gate contract", () => {
  test("unset ⇒ ON (default-on; reverting gate.ts to gateOnStrict makes this RED)", () => {
    expect(staleReadGuardEnabled({})).toBe(true)
  })
  test("exact =off ⇒ OFF (the only kill-switch)", () => {
    expect(staleReadGuardEnabled({ [STALE_READ_GUARD_ENV]: "off" })).toBe(false)
  })
  test("a stray falsy token (=0) does NOT silently disable a safety control", () => {
    expect(staleReadGuardEnabled({ [STALE_READ_GUARD_ENV]: "0" })).toBe(true)
  })
})

// ── B. the real host assembler wires ReadFileState by DEFAULT ────────────────
const inertLLM: LLMPort & { readonly model: string } = {
  model: "gpt-5",
  // biome-ignore lint/correctness/useYield: never invoked
  async *stream(_i: StreamInput): AsyncIterable<StreamEvent> {
    throw new Error("unexpected stream()")
  },
}
const baseReq = (): AssembleRequest => ({
  mode: "interactive",
  base: {
    llm: inertLLM,
    registry: {
      register: () => undefined,
      get: () => undefined,
      list: () => [],
    } as unknown as AgentConfig["registry"],
    stream: { emit: () => undefined },
    permission: { mode: "default" },
    messages: [],
    system: "test",
    cwd: "/repo",
    maxTurns: 1,
    signal: new AbortController().signal,
    sessionId: "sess-staleness-default-on",
  },
})

describe("[hellgate] real host assembler wires ReadFileState by DEFAULT", () => {
  test("env={} (no flag) ⇒ cfg.readFileState minted (DEFAULT-ON)", () => {
    const cfg = assembleAgentConfig(baseReq(), {})
    expect(cfg.readFileState).toBeInstanceOf(ReadFileState)
  })
  test("env with =off ⇒ cfg.readFileState NOT minted (kill-switch ⇒ legacy path)", () => {
    const cfg = assembleAgentConfig(baseReq(), { [STALE_READ_GUARD_ENV]: "off" })
    expect(cfg.readFileState).toBeUndefined()
  })
})

// ── C. editTool staleness end-to-end (the edit-tool e2e coverage gap) ────────
const root = mkdtempSync(join(tmpdir(), "edit-stale-default-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ctx = (cwd: string, rfs?: ReadFileState): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
  ...(rfs !== undefined ? { readFileState: rfs } : {}),
})
const runEdit = async (input: unknown, cwd: string, rfs?: ReadFileState): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of editTool.execute(input as never, ctx(cwd, rfs))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}
/** Advance on-disk mtime to a clean integer second strictly greater than now. */
const bumpMtime = (path: string): number => {
  const cur = statSync(path)
  const sec = Math.ceil(cur.mtimeMs / 1000) + 5
  utimesSync(path, sec, sec)
  return statSync(path).mtimeMs
}

describe("[hellgate] editTool enforces staleness end-to-end", () => {
  test("read-record → external mtime bump → edit ⇒ stale_read reject, file byte-untouched", async () => {
    const file = join(root, "drift.txt")
    const ORIGINAL = "alpha\nbeta\ngamma\n"
    writeFileSync(file, ORIGINAL)
    const rfs = new ReadFileState()
    const recorded = statSync(file).mtimeMs
    rfs.record(file, recorded)
    const bumped = bumpMtime(file)
    expect(bumped).toBeGreaterThan(recorded)

    const r = await runEdit({ path: file, old_string: "beta", new_string: "BETA" }, root, rfs)

    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "rejected", reason: "stale_read" })
    // The edit must NEVER have reached disk — byte-untouched.
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL)
  })

  test("fresh (recorded === current) ⇒ edit applies ok:true", async () => {
    const file = join(root, "fresh.txt")
    writeFileSync(file, "alpha\nbeta\ngamma\n")
    const rfs = new ReadFileState()
    rfs.record(file, statSync(file).mtimeMs)

    const r = await runEdit({ path: file, old_string: "beta", new_string: "BETA" }, root, rfs)

    expect(r.ok).toBe(true)
    expect(readFileSync(file, "utf8")).toBe("alpha\nBETA\ngamma\n")
  })

  test("UNREAD target (no baseline) ⇒ edit applies (no false-positive on blind/new edits)", async () => {
    const file = join(root, "unread.txt")
    writeFileSync(file, "alpha\nbeta\ngamma\n")
    const rfs = new ReadFileState() // nothing recorded for this file
    // Even with the guard ON, an unread target has no staleness baseline.
    const r = await runEdit({ path: file, old_string: "beta", new_string: "BETA" }, root, rfs)

    expect(r.ok).toBe(true)
    expect(readFileSync(file, "utf8")).toBe("alpha\nBETA\ngamma\n")
  })
})
