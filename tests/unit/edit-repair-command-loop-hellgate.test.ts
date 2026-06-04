/**
 * HELLGATE — edit-repair LoopOnCommand + config-ify (H1, jun-3-misc §3 / ADR-0472).
 *
 * The lint loop (LoopOnLints) was already wired; this proves the NEW dispatch
 * surface: after a path-bearing edit, when the host wires
 * `config.editRepair.{command,exec}`, the seam runs the command, and on failure
 * drives a bounded fast-model repair loop until it goes green — independent of
 * any diagnostics provider (LoopOnCommand needs no LSP). Plus the config-ify
 * contract: `maxIters` is honored, and the whole feature is byte-identical
 * default-OFF (knob off / command unwired / non-edit tool).
 *
 * Driven end-to-end through the REAL `dispatchTool` pipeline + REAL `editTool`
 * against a temp file. Only the fast model (LLMPort) and the command runner
 * (ExecRunner) are fakes — exactly the two infra ports the slice inverts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import type { ExecRunner } from "@/agent/edit-repair-wire"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolResultBlock, ToolUseBlock } from "@/llm"
import type { LLMPort } from "@/llm/ports"
import type { StreamEvent, StreamInput } from "@/llm/types"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import { editTool } from "@/tool/edit"
import { ToolRegistry } from "@/tool"

/** A fast model that always replies with the SAME corrected file content. */
const fakeLlm = (reply: string): LLMPort => ({
  model: "fast-test",
  stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    async function* gen(): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", delta: reply }
      yield { type: "message_stop", stop_reason: "end_turn" }
    }
    return gen()
  },
})

/** A command runner that returns a scripted exit-code SEQUENCE (last value
 *  repeats once exhausted) and records every command it was handed. */
const scriptedExec = (codes: number[]): { exec: ExecRunner; calls: string[] } => {
  const calls: string[] = []
  let i = 0
  const exec: ExecRunner = async (command) => {
    calls.push(command)
    const code = codes[Math.min(i, codes.length - 1)] ?? 0
    i++
    return { exitCode: code, output: code === 0 ? "PASS" : "FAIL: assertion" }
  }
  return { exec, calls }
}

let dir: string | null = null
const origGate = process.env.QUANTA_EDIT_REPAIR_LOOP
const origPerm = process.env.QUANTA_PERMISSION_STATE

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "edit-repair-cmd-"))
  process.env.QUANTA_PERMISSION_STATE = join(dir, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})
afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true })
  dir = null
  if (origGate === undefined) delete process.env.QUANTA_EDIT_REPAIR_LOOP
  else process.env.QUANTA_EDIT_REPAIR_LOOP = origGate
  if (origPerm === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = origPerm
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

const perm: PermissionContext = { mode: "acceptEdits" }

const config = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry: new ToolRegistry([editTool]),
    cwd: dir as string,
    signal: new AbortController().signal,
    planMode: false,
    permission: perm,
    ...over,
  }) as AgentConfig

/** Write a file in the temp dir and return its absolute path. */
const seed = (name: string, body: string): string => {
  const p = join(dir as string, name)
  writeFileSync(p, body)
  return p
}

const editCall = (path: string, oldS: string, newS: string): ToolUseBlock => ({
  type: "tool_use",
  id: "e1",
  name: "edit",
  input: { path, old_string: oldS, new_string: newS },
})

const content = (b: ToolResultBlock): string =>
  typeof b.content === "string" ? b.content : JSON.stringify(b.content)

describe("H1 LoopOnCommand — command fails then repairs green", () => {
  test("edit → command exit1 → fast-model re-edit → command exit0 ⇒ green annotation", async () => {
    process.env.QUANTA_EDIT_REPAIR_LOOP = "1"
    __resetRuntimeConfig()
    const file = seed("a.txt", "BROKEN\n")
    const { exec, calls } = scriptedExec([1, 0]) // fail once, then pass
    const cfg = config({
      llm: fakeLlm("FIXED\n"),
      editRepair: { command: "run-tests", exec, maxIters: 3 },
    })

    const res = await dispatchTool(editCall(file, "BROKEN", "OK"), cfg, perm)
    expect(res.ok).toBe(true)

    // The command ran at least twice (initial fail + post-repair pass).
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.every((c) => c === "run-tests")).toBe(true)
    // The fast model's correction WON (it overwrote the edit's "OK" with "FIXED").
    expect(readFileSync(file, "utf8")).toBe("FIXED\n")
    // The model-facing output advertises the green command repair.
    expect(content(res.block as ToolResultBlock)).toContain("`run-tests` passed after 1 repair attempt(s)")
  })
})

describe("H1 LoopOnCommand — maxIters bounds a never-green command", () => {
  test("command always fails ⇒ loop stops at maxIters, reports still-failing", async () => {
    process.env.QUANTA_EDIT_REPAIR_LOOP = "1"
    __resetRuntimeConfig()
    const file = seed("b.txt", "BROKEN\n")
    const { exec, calls } = scriptedExec([1]) // never green
    const cfg = config({
      llm: fakeLlm("STILL-BROKEN\n"),
      editRepair: { command: "ci", exec, maxIters: 2 },
    })

    const res = await dispatchTool(editCall(file, "BROKEN", "OK"), cfg, perm)
    expect(res.ok).toBe(true)
    // check(1) + maxIters(2) re-checks = 3 exec calls, no more (bound honored).
    expect(calls.length).toBe(3)
    expect(content(res.block as ToolResultBlock)).toContain("`ci` still failing")
  })

  test("invalid maxIters (0) falls back to the default cap (2)", async () => {
    process.env.QUANTA_EDIT_REPAIR_LOOP = "1"
    __resetRuntimeConfig()
    const file = seed("c.txt", "BROKEN\n")
    const { exec, calls } = scriptedExec([1])
    const cfg = config({
      llm: fakeLlm("x\n"),
      editRepair: { command: "ci", exec, maxIters: 0 }, // invalid ⇒ default 2
    })
    await dispatchTool(editCall(file, "BROKEN", "OK"), cfg, perm)
    expect(calls.length).toBe(3) // 1 + default(2)
  })
})

describe("H1 LoopOnCommand — byte-identical default-OFF", () => {
  test("knob OFF ⇒ no command loop even when command+exec wired", async () => {
    delete process.env.QUANTA_EDIT_REPAIR_LOOP
    __resetRuntimeConfig()
    const file = seed("d.txt", "BROKEN\n")
    const { exec, calls } = scriptedExec([1, 0])
    const cfg = config({ llm: fakeLlm("FIXED\n"), editRepair: { command: "t", exec } })
    const res = await dispatchTool(editCall(file, "BROKEN", "OK"), cfg, perm)
    expect(res.ok).toBe(true)
    expect(calls.length).toBe(0) // never classified
    expect(readFileSync(file, "utf8")).toBe("OK\n") // only the edit applied
    expect(content(res.block as ToolResultBlock)).not.toContain("[edit-repair]")
  })

  test("knob ON but command unwired ⇒ no loop (edit applies normally)", async () => {
    process.env.QUANTA_EDIT_REPAIR_LOOP = "1"
    __resetRuntimeConfig()
    const file = seed("e.txt", "BROKEN\n")
    const { exec, calls } = scriptedExec([1])
    // command absent ⇒ the gate short-circuits even though exec is present.
    const cfg = config({ llm: fakeLlm("FIXED\n"), editRepair: { exec } })
    const res = await dispatchTool(editCall(file, "BROKEN", "OK"), cfg, perm)
    expect(res.ok).toBe(true)
    expect(calls.length).toBe(0)
    expect(readFileSync(file, "utf8")).toBe("OK\n")
  })

  test("empty / whitespace command string ⇒ treated as no-command (never shells out)", async () => {
    process.env.QUANTA_EDIT_REPAIR_LOOP = "1"
    __resetRuntimeConfig()
    const file = seed("ws.txt", "BROKEN\n")
    const { exec, calls } = scriptedExec([1, 0])
    const cfg = config({ llm: fakeLlm("FIXED\n"), editRepair: { command: "   ", exec } })
    const res = await dispatchTool(editCall(file, "BROKEN", "OK"), cfg, perm)
    expect(res.ok).toBe(true)
    expect(calls.length).toBe(0) // blank command never ran
    expect(readFileSync(file, "utf8")).toBe("OK\n")
  })

  test("non-edit tool ⇒ command loop never runs", async () => {
    process.env.QUANTA_EDIT_REPAIR_LOOP = "1"
    __resetRuntimeConfig()
    const { exec, calls } = scriptedExec([1, 0])
    const cfg = config({ llm: fakeLlm("x"), editRepair: { command: "t", exec } })
    // A read-class call has no edit path ⇒ extractEditPath returns null.
    const badCall: ToolUseBlock = { type: "tool_use", id: "r1", name: "edit", input: { not_a_path: 1 } }
    await dispatchTool(badCall, cfg, perm).catch(() => undefined)
    expect(calls.length).toBe(0)
  })

  test("FAILED edit (old_string not found) ⇒ command loop must NOT run (no phantom repair)", async () => {
    // Regression for the result.ok gate: a failed edit changed nothing, so
    // running the command + letting the fast model rewrite the file would repair
    // a phantom edit and could clobber the file over an unrelated failure.
    process.env.QUANTA_EDIT_REPAIR_LOOP = "1"
    __resetRuntimeConfig()
    const file = seed("f.txt", "ORIGINAL\n")
    const { exec, calls } = scriptedExec([1, 0])
    const cfg = config({ llm: fakeLlm("FIXED\n"), editRepair: { command: "t", exec, maxIters: 3 } })
    // old_string is absent ⇒ the edit fails (result.ok === false).
    const res = await dispatchTool(editCall(file, "NOT-PRESENT", "X"), cfg, perm)
    expect(res.ok).toBe(false)
    expect(calls.length).toBe(0) // command never ran
    expect(readFileSync(file, "utf8")).toBe("ORIGINAL\n") // file untouched
    expect(content(res.block as ToolResultBlock)).not.toContain("[edit-repair]")
  })
})
