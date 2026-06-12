/**
 * #20 DURABLE prefix grant — GATE safety: a durable token-prefix grant must NOT
 * ask-skip a CHAINED command (`echo x && cat /etc/passwd`), even though the
 * persistent store's `patternMatchesAction` would token-prefix-match its first
 * token. The gate's `trustScopeGrants` consult therefore applies the SAME
 * single-simple-command guard the session prefix grant uses (`isSimpleCommand`):
 * a command with any shell metachar forces the confirm prompt instead of riding
 * the grant. This closes the chaining-smuggle that the bare persistent matcher
 * (no metachar guard) would otherwise allow.
 *
 * RED-ON-INJECTION (manually verified): dropping the `isSimpleCommand` guard in
 * `trustScopeGrants` makes the chained command ask-skip (reviewer calls === 0)
 * ⇒ the "chained re-prompts" assertion flips RED.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { type AdmissibilityAction, runAdmissibilityGate } from "@/agent/admissibility-gate"
import type { ToolUseBlock } from "@/llm"
import {
  __resetDefaultPermissionStore,
  createPersistentTrustScopeRegistry,
  type HITLTier,
  type PermissionContext,
  type PersistentTrustScopeRegistry,
} from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import { type Tool, ToolRegistry } from "@/tool"

const bashLikeTool = (): Tool => {
  const t: Tool = {
    name: "bash",
    description: "bash",
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

let dir: string
let reg: PersistentTrustScopeRegistry
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "trust-gate-guard-"))
  process.env.QUANTA_PERMISSION_STATE = join(dir, "perm.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
  reg = createPersistentTrustScopeRegistry({ filePath: join(dir, "grants.json") })
  await reg.hydrate()
  reg.grant("proj", { tool: "bash", scope: "project", commandPattern: "echo" })
  await reg.flush()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.QUANTA_PERMISSION_STATE
})

describe("#20 durable prefix grant — gate consult single-command guard", () => {
  // No `hitl.enabled` ⇒ the always-confirm bash routes through mode-policy's
  // `resolveAskBranch`, which is where `trustScopeGrants` is consulted. A wired
  // allow-everything reviewer stands in for the operator confirm so a NON-skip
  // is observable as a reviewer call.
  const build = () => {
    // The mode-policy ask branch (`resolveAskBranch`, where `trustScopeGrants`
    // is consulted) calls `config.onConfirm` — so the confirm spy lives THERE,
    // and a NON-skip is observable as an onConfirm call.
    let confirmCalls = 0
    const registry = new ToolRegistry([bashLikeTool()])
    const cfg = {
      cwd: "/repo",
      signal: new AbortController().signal,
      planMode: false,
      permission: { mode: "default" } as PermissionContext,
      registry,
      trustScope: { registry: reg, projectKey: "proj" },
      onConfirm: async () => {
        confirmCalls += 1
        return true // allow-everything stand-in operator
      },
    } as unknown as AgentConfig
    const run = (command: string) =>
      runAdmissibilityGate(call(command), cfg, { mode: "default" }, actionOf(command))
    return { run, calls: () => confirmCalls }
  }

  test("a SIMPLE sibling (`echo bye`) rides the durable grant — ask-skipped, no reviewer", async () => {
    const { run, calls } = build()
    const res = await run("echo bye")
    expect(res).toBeNull() // admitted via trust-scope ask-skip
    expect(calls()).toBe(0) // reviewer never consulted
  })

  test("a CHAINED sibling (`echo bye && echo two`) does NOT ride — reviewer IS consulted", async () => {
    // A benign chain (NOT hard-deny) so the only thing that can stop the ask-skip
    // is the metachar guard. Without the guard, the persistent matcher would
    // token-prefix-match `echo` and silently ride the grant (calls 0).
    const { run, calls } = build()
    const res = await run("echo bye && echo two")
    // The metachar guard refuses the ask-skip, so the gate falls to the confirm
    // (reviewer). The allow-everything reviewer then admits it, but the POINT is
    // the operator was re-prompted (calls === 1), not silently ridden.
    expect(calls()).toBe(1)
    expect(res).toBeNull() // (admitted only because the stand-in reviewer allows everything)
  })
})
