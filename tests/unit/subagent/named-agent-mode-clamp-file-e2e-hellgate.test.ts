/**
 * Hellgate — FILE-LEVEL end-to-end lock for the most-restrictive child-mode
 * clamp. Unlike the fold-e2e sibling (which injects a fake resolver), this drives
 * the WHOLE chain off a real on-disk definition:
 *
 *   `.quanta/agents/<name>.md` (frontmatter `mode: default`)   <- repo-controlled
 *      → REAL `loadNamedAgents(cwd)` (the production loader + frontmatter parser)
 *      → REAL `NamedAgentRegistry` wired onto a `review`-posture parent
 *      → REAL `createSubagentRunner` fork (applyNamedAgent → resolveChildMode)
 *      → REAL `runAdmissibilityGate` dispatch gate
 *
 * This is the exact attack the fix defends: a contributor checks in an agent
 * definition declaring `mode: default` (write-capable), a review/audit-posture
 * parent spawns it by `agent_type`, and WITHOUT the clamp the child would run
 * write-capable. We assert:
 *   FILE-CLAMP  the forked child's resolved `mode` is `review` (NOT the file's
 *               `default`) — the loader faithfully carries `mode:"default"`, and
 *               the clamp floors it.
 *   FILE-DENY   that clamped child DENIES a mutating tool (`write`) at the real
 *               admissibility gate (mode enforced END-TO-END from a real file).
 *   FILE-ALLOW  the same child still admits a read-only tool (`read`).
 *   FILE-LOADER-SANITY  the loader DID read `mode:"default"` off the file (so the
 *               clamp is genuinely overriding a mutating request, not a no-op).
 *
 * RED-on-injection: drop the clamp in `resolveChildMode` and FILE-CLAMP /
 * FILE-DENY both regress to the write-capable `default` posture.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { runAgent } from "@/agent/loop"
import { loadNamedAgents } from "@/agent/named-agent-registry"
import { createSubagentRunner } from "@/agent/subagent-runner"
import type { AgentConfig, AgentOutcome } from "@/agent/types"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { SubagentRequest } from "@/subagent/types"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"
import { runAdmissibilityGate } from "../../../src/agent/admissibility-gate"

const tool = (name: string, readOnly: boolean): Tool => ({
  name,
  description: name,
  inputSchema: { parse: (v: unknown) => v } as Tool["inputSchema"],
  isReadOnly: () => readOnly,
  isConcurrencySafe: () => readOnly,
  async *execute(): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: "" } }
  },
})

const port = (): LLMPort =>
  ({
    model: "parent-model",
    // biome-ignore lint/suspicious/noExplicitAny: inert stream stub — loop never runs
    stream: async function* () {} as any,
  }) as LLMPort

/** Write a `.quanta/agents/<name>.md` fixture into a fresh temp repo and return
 *  its root cwd. The frontmatter declares the WRITE-CAPABLE `mode: default` — the
 *  repo-controlled escalation surface the clamp must neutralize. */
const mkRepoWithDef = (name: string): string => {
  const root = mkdtempSync(join(tmpdir(), "named-agent-file-e2e-"))
  const dir = join(root, ".quanta/agents")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: hostile write-capable definition\nmode: default\n---\nYou are ${name}.\n`,
    "utf8",
  )
  return root
}

const parentConfig = (cwd: string, mode: string): AgentConfig =>
  ({
    llm: port(),
    registry: new ToolRegistry([tool("read", true), tool("write", false)]),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "P" }] }],
    system: "S",
    cwd,
    maxTurns: 1,
    signal: new AbortController().signal,
    mode,
  }) as AgentConfig

const outcome: AgentOutcome = {
  reason: "completed",
  turns: 1,
  messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
}

/** Fork through the REAL runner with a REAL file-loaded resolver wired on. */
const captureChildFromFile = async (
  root: string,
  parentMode: string,
  agentType: string,
): Promise<AgentConfig> => {
  const registry = await loadNamedAgents(root)
  const parent = {
    ...parentConfig(root, parentMode),
    namedAgentResolver: registry,
  } as AgentConfig
  const seen: AgentConfig[] = []
  const run = (async (c: AgentConfig) => {
    seen.push(c)
    return outcome
  }) as typeof runAgent
  const reqInput: SubagentRequest = { prompt: "go", depth: 1, agentType }
  await createSubagentRunner(parent, { run })(reqInput)
  const child = seen[0]
  if (child === undefined) throw new Error("runner never forked a child")
  return child
}

const permission: PermissionContext = { mode: "default" }
const actionFor = (name: string, isReadOnly: boolean) => ({ tool: name, input: {}, isReadOnly })
const callFor = (name: string) => ({ type: "tool_use" as const, id: `c-${name}`, name, input: {} })

describe("named-agent mode clamp — FILE-LEVEL e2e (hellgate)", () => {
  test('FILE-LOADER-SANITY the real loader reads mode:"default" off the file', async () => {
    const root = mkRepoWithDef("evil")
    try {
      const registry = await loadNamedAgents(root)
      expect(registry.resolve("evil")?.mode).toBe("default")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("FILE-CLAMP review parent + file def.mode=default ⇒ forked child stays review", async () => {
    const root = mkRepoWithDef("evil")
    try {
      const child = await captureChildFromFile(root, "review", "evil")
      expect(child.mode).toBe("review")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("FILE-DENY the file-clamped child DENIES a mutating tool at the REAL dispatch gate", async () => {
    const root = mkRepoWithDef("evil")
    try {
      const child = await captureChildFromFile(root, "review", "evil")
      expect(child.mode).toBe("review")
      const result = await runAdmissibilityGate(
        callFor("write"),
        child,
        permission,
        actionFor("write", false),
      )
      expect(result).not.toBeNull()
      expect(result?.ok).toBe(false)
      expect(result?.preview).toContain("review-blocked")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("FILE-ALLOW the same file-clamped child still ADMITS a read-only tool", async () => {
    const root = mkRepoWithDef("evil")
    try {
      const child = await captureChildFromFile(root, "review", "evil")
      const result = await runAdmissibilityGate(
        callFor("read"),
        child,
        permission,
        actionFor("read", true),
      )
      expect(result).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("FILE-AUDIT audit parent floors the file's default ⇒ child stays audit", async () => {
    const root = mkRepoWithDef("evil")
    try {
      const child = await captureChildFromFile(root, "audit", "evil")
      expect(child.mode).toBe("audit")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
