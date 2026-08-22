/**
 * #20 SECURITY BACKSTOP — a prefix session grant can NEVER admit a HARD_DENY
 * command.
 *
 * The prefix grant ("always allow `git …` this session", `@/permission/
 * session-grant-prefix`) lives INSIDE the reviewer/onConfirm path. Its safety
 * therefore RELIES on the admissibility gate enforcing HARD_DENY *before* the
 * reviewer is ever consulted — otherwise an operator who granted the benign
 * `bash|git` prefix could have a single-token-matching but dangerous sibling
 * (`git push --force`, `git reset --hard` — both HARD_DENY *and* simple commands
 * with no shell metachar, so the prefix matcher WOULD match them) ride the grant
 * unprompted.
 *
 * The gate closes this via `earlyHardDeny` (admissibility-gate.ts), which is
 * pulled AHEAD of the HITL/reviewer gate whenever a `reviewerPort` is wired (the
 * CLI always wires one). This test pins that contract with a WORST-CASE reviewer:
 * an `onConfirm` that ALLOWS EVERYTHING (strictly more permissive than any real
 * prefix grant). If the gate still denies the HARD_DENY command WITHOUT calling
 * that reviewer, then no grant — prefix or exact — can ever ride a HARD_DENY
 * command.
 *
 * RED-ON-INJECTION (manually verified): no-op'ing `earlyHardDeny` in
 * admissibility-gate.ts makes `git push --force` reach the allow-everything
 * reviewer ⇒ admitted (res === null, reviewer called) ⇒ both assertions flip RED.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { createOnConfirmReviewerPort } from "@/agent"
import { type AdmissibilityAction, runAdmissibilityGate } from "@/agent/admissibility-gate"
import type { ToolUseBlock } from "@/llm"
import { __resetDefaultPermissionStore, type HITLTier, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import { type Tool, ToolRegistry } from "@/tool"

/** A bash-equivalent tool: always-confirm tier + `extractShellCommand` so the
 *  gate derives `action.shellCommand` and HARD_DENY fires uniformly. */
const bashLikeTool = (): Tool => {
  const t: Tool = {
    name: "bash",
    description: "bash tool",
    inputSchema: z.object({ command: z.string() }) as z.ZodType<unknown>,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async function* () {
      yield { type: "result", result: { ok: true, output: "ran" } }
    },
  }
  ;(t as Tool & { hitlTier: () => HITLTier }).hitlTier = () => "always-confirm"
  ;(t as Tool & { extractShellCommand: (i: unknown) => string }).extractShellCommand = (i) =>
    (i as { command: string }).command
  return t
}

const call = (command: string): ToolUseBlock => ({
  type: "tool_use",
  id: "c1",
  name: "bash",
  input: { command },
})
const actionOf = (command: string): AdmissibilityAction => ({
  tool: "bash",
  input: { command },
  isReadOnly: false,
})
const cfg = (registry: ToolRegistry): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "default" } as PermissionContext,
    registry,
    // HITL on so the always-confirm reviewer path is actually reached for a
    // benign command (the CONTROL) — proving the allow-everything reviewer is
    // live, so the HARD_DENY cases that DON'T reach it are bypassed by design.
    hitl: { enabled: true },
  }) as AgentConfig

let stateRoot: string | null = null
beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "prefix-backstop-"))
  process.env.QUANTA_PERMISSION_STATE = join(stateRoot, "state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})
afterEach(() => {
  if (stateRoot !== null) rmSync(stateRoot, { recursive: true, force: true })
  delete process.env.QUANTA_PERMISSION_STATE
})

describe("#20 HARD_DENY backstop — a prefix grant cannot ride a denylisted sibling", () => {
  // The worst-case reviewer: allows EVERYTHING it is asked about. Strictly more
  // permissive than any real prefix grant (which only allows token-matching
  // simple commands). If the gate bypasses even THIS for a HARD_DENY command,
  // no grant can ever ride one.
  const buildGate = () => {
    let reviewerCalls = 0
    const reviewerPort = createOnConfirmReviewerPort({
      onConfirm: async () => {
        reviewerCalls += 1
        return true // allow everything
      },
    })
    const registry = new ToolRegistry([bashLikeTool()])
    const run = (command: string) =>
      runAdmissibilityGate(
        call(command),
        cfg(registry),
        { mode: "default" },
        actionOf(command),
        undefined,
        {
          reviewerPort,
        },
      )
    return { run, calls: () => reviewerCalls }
  }

  test("a HARD_DENY sibling (`git push --force`) is DENIED without reaching the reviewer", async () => {
    const { run, calls } = buildGate()
    const res = await run("git push --force") // HARD_DENY (git-push-force) AND a simple `git` command
    expect(res).not.toBeNull() // denied
    expect(res?.preview).toBe("handoff") // HARD_DENY surfaces as the hand-off terminator
    expect(calls()).toBe(0) // earlyHardDeny short-circuited BEFORE any reviewer/grant
  })

  test("PAIRED: another HARD_DENY `git` sibling (`git reset --hard HEAD~3`) also never reaches the reviewer", async () => {
    const { run, calls } = buildGate()
    const res = await run("git reset --hard HEAD~3") // HARD_DENY (git-reset-hard), simple command
    expect(res).not.toBeNull()
    expect(calls()).toBe(0)
  })

  test("CONTROL: a benign `git` sibling (`git log`) DOES reach the allow-everything reviewer and is admitted", async () => {
    // Proves the deny above is causal to HARD_DENY — NOT a dead reviewer port.
    // The same allow-everything reviewer admits the benign command (reviewer
    // reached + result null = proceed), so the only thing that changed for the
    // denied cases is that they are HARD_DENY.
    const { run, calls } = buildGate()
    const res = await run("git log --oneline")
    expect(res).toBeNull() // admitted (proceed to execute)
    expect(calls()).toBe(1) // the reviewer WAS consulted for the benign sibling
  })
})
