/**
 * Phase C — trust-scope registry wire-up into the admissibility-gate.
 *
 * DEFAULT OFF, opt-in semantics:
 *  (a) registry.hasGrant=true ⇒ ask-branch SKIPS onConfirm (allow path).
 *  (b) registry.hasGrant=false ⇒ legacy onConfirm path (current behavior).
 *  (c) `config.trustScope` UNSET ⇒ byte-identical to before (no registry
 *      lookup, no consume call, onConfirm is invoked exactly once just like
 *      every existing admissibility-gate test expects).
 *
 * The wire-up site is `runAdmissibilityGate` → `runModePolicy`'s
 * `decision.kind === "ask"` branch — BEFORE `config.onConfirm` is called.
 * The trust-scope registry lives in `@/permission` (slice isolation: the
 * gate type-imports the registry interface, never the implementation).
 */
import { describe, expect, test } from "bun:test"
import { runAdmissibilityGate } from "@/agent/admissibility-gate"
import type { AgentConfig } from "@/agent/types"
import type { ToolUseBlock } from "@/llm"
import {
  createInMemoryTrustScopeRegistry,
  type PermissionContext,
  type TrustScope,
  type TrustScopeRegistry,
} from "@/permission"
import { defaultTools, ToolRegistry } from "@/tool"

const mutatingCall: ToolUseBlock = {
  type: "tool_use",
  id: "call-1",
  name: "fs_write",
  input: { path: "/repo/x.ts", content: "x" },
}

const mutatingAction = {
  tool: "fs_write",
  input: { path: "/repo/x.ts", content: "x" },
  isReadOnly: false,
}

const askingPermission: PermissionContext = { mode: "default" }

/** Minimal AgentConfig — only the fields the gate touches. */
const cfg = (over: Partial<AgentConfig>): AgentConfig =>
  ({
    registry: new ToolRegistry(defaultTools),
    stream: { emit: () => {} },
    permission: askingPermission,
    messages: [],
    system: "SYS",
    cwd: "/repo",
    maxTurns: 5,
    signal: new AbortController().signal,
    llm: { stream: async function* () {} } as unknown as AgentConfig["llm"],
    ...over,
  }) as AgentConfig

describe("trust-scope wire-up (Phase C)", () => {
  test("(a) registry.hasGrant=true ⇒ onConfirm is NEVER called, gate allows", async () => {
    let onConfirmCalls = 0
    const registry: TrustScopeRegistry = {
      hasGrant: () => true,
      consume: () => {},
      grant: () => {},
    }
    const result = await runAdmissibilityGate(
      mutatingCall,
      cfg({
        onConfirm: async () => {
          onConfirmCalls++
          return false
        },
        trustScope: { registry, projectKey: "p1" },
      }),
      askingPermission,
      mutatingAction,
    )
    expect(onConfirmCalls).toBe(0)
    expect(result).toBeNull()
  })

  test("(b) registry.hasGrant=false ⇒ legacy onConfirm ask flow", async () => {
    let onConfirmCalls = 0
    const registry: TrustScopeRegistry = {
      hasGrant: () => false,
      consume: () => {},
      grant: () => {},
    }
    const result = await runAdmissibilityGate(
      mutatingCall,
      cfg({
        onConfirm: async () => {
          onConfirmCalls++
          return true
        },
        trustScope: { registry, projectKey: "p1" },
      }),
      askingPermission,
      mutatingAction,
    )
    expect(onConfirmCalls).toBe(1)
    // approved ⇒ admissible (null)
    expect(result).toBeNull()
  })

  test("(c) trustScope UNSET ⇒ byte-identical legacy behavior (onConfirm called)", async () => {
    let onConfirmCalls = 0
    const result = await runAdmissibilityGate(
      mutatingCall,
      cfg({
        onConfirm: async () => {
          onConfirmCalls++
          return true
        },
      }),
      askingPermission,
      mutatingAction,
    )
    expect(onConfirmCalls).toBe(1)
    expect(result).toBeNull()
  })

  test("(d) once_only grant is consumed on first hit (second hit re-prompts)", async () => {
    const registry = createInMemoryTrustScopeRegistry()
    registry.grant("p1", { tool: "fs_write", scope: "once_only" satisfies TrustScope })

    let onConfirmCalls = 0
    const config = cfg({
      onConfirm: async () => {
        onConfirmCalls++
        return false // second call ⇒ declined ⇒ short-circuit deny
      },
      trustScope: { registry, projectKey: "p1" },
    })

    // First call: grant present, onConfirm SKIPPED, gate allows.
    const r1 = await runAdmissibilityGate(mutatingCall, config, askingPermission, mutatingAction)
    expect(onConfirmCalls).toBe(0)
    expect(r1).toBeNull()

    // Second call: grant consumed, onConfirm now drives the decision.
    const r2 = await runAdmissibilityGate(mutatingCall, config, askingPermission, mutatingAction)
    expect(onConfirmCalls).toBe(1)
    expect(r2).not.toBeNull()
  })

  test("(e) deny grant routes through legacy ask (deny is not an ask-skip)", async () => {
    const registry = createInMemoryTrustScopeRegistry()
    registry.grant("p1", { tool: "fs_write", scope: "deny" satisfies TrustScope })

    let onConfirmCalls = 0
    const result = await runAdmissibilityGate(
      mutatingCall,
      cfg({
        onConfirm: async () => {
          onConfirmCalls++
          return true
        },
        trustScope: { registry, projectKey: "p1" },
      }),
      askingPermission,
      mutatingAction,
    )
    // "deny" trust scope MUST NOT short-circuit the ask via the wire-up — the
    // wire-up only treats positive scopes as ask-skip. A "deny" grant either
    // falls through to legacy ask (this test asserts current minimal Phase C
    // behavior) or is handled by a future deny gate; the invariant we lock in
    // here is: it is NEVER treated as an implicit allow.
    expect(onConfirmCalls).toBe(1)
    expect(result).toBeNull()
  })
})
