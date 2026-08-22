/**
 * Hellgate — LOCKS the most-restrictive child-mode clamp THROUGH the real fold
 * path, not just a directly-injected `req.mode`. The existing
 * `named-agent-mode-clamp-hellgate.test.ts` (cases 1-8) sets `req.mode` DIRECTLY,
 * so it proves `resolveChildMode` clamps but NOT that the clamp survives the
 * `applyNamedAgent` fold (where a repo-controlled named-agent definition's
 * `def.mode` is the real attack surface). It also never exercises `architect`,
 * a depth-2 grandchild, or an end-to-end dispatch denial. This file adds those.
 *
 * THE FIX UNDER TEST (`src/agent/subagent-runner.ts`):
 *   `applyNamedAgent` folds a matched definition's `def.mode` into the effective
 *   `req.mode` (explicit-request-wins), and `resolveChildMode` then clamps it
 *   MOST-RESTRICTIVE: a read-only parent (plan/review/audit/architect —
 *   `!isMutatingMode`) FLOORS a mutating (default/editor) requested mode.
 *
 * RED-on-injection (the gap that matters): a refactor that clamped a
 * directly-set `req.mode` but applied `def.mode` AFTER the clamp (post-fold
 * write) would pass cases 1-8 yet RELAX a review parent into a write-capable
 * child here. FOLD-1 fails red in that world.
 *
 * Coverage added (vs. cases 1-8):
 *   FOLD-1   real namedAgentResolver returns `{ mode: "default" }` ⇒ review parent
 *            ⇒ child stays "review" (proves applyNamedAgent → resolveChildMode wire)
 *   FOLD-2   architect parent + mutating def.mode "editor" ⇒ child stays "architect"
 *   FOLD-3   read-only def.mode (audit) on a review parent ⇒ further restriction honored
 *   FOLD-4   explicit req.mode beats def.mode, then STILL clamps (review + req default ⇒ review)
 *   DEPTH2   review parent ⇒ clamped review child ⇒ grandchild req default ⇒ stays review
 *            (two nested spawns through the REAL runner — non-escape at depth 2)
 *   DEPTH2-ARCH  architect grandchild non-escape
 *   E2E-DENY child config produced by the real fold is fed to the REAL
 *            `runAdmissibilityGate`; a mutating tool (`write`) is DENIED end-to-end
 *            (mode enforced at the genuine dispatch gate, not just stored on config)
 *   E2E-ALLOW the SAME child still admits a read-only tool (`read`) — the clamp
 *            denies writes WITHOUT over-blocking reads (no false positive)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { runAgent } from "@/agent/loop"
import type { NamedAgentDefinition, NamedAgentResolver } from "@/agent/named-agent-registry"
import type { AgentMode } from "@/agent/prompt"
import { createSubagentRunner } from "@/agent/subagent-runner"
import type { AgentConfig, AgentOutcome } from "@/agent/types"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import type { SubagentRequest } from "@/subagent/types"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"
import { runAdmissibilityGate } from "../../../src/agent/admissibility-gate"

// ── harness (mirrors named-agent-spawn-hellgate.test.ts shapes) ──────────────

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

const parentConfig = (mode: AgentMode | undefined): AgentConfig =>
  ({
    llm: port(),
    // `read` is read-only, `write` is mutating — used by the e2e dispatch gate.
    registry: new ToolRegistry([tool("read", true), tool("write", false)]),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "P" }] }],
    system: "S",
    cwd: "/repo",
    maxTurns: 1,
    signal: new AbortController().signal,
    ...(mode !== undefined ? { mode } : {}),
  }) as AgentConfig

const outcome: AgentOutcome = {
  reason: "completed",
  turns: 1,
  messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
}

/** A resolver that returns one fixed definition for one agentType (the real
 *  fold path: the runner reads this off `parent.namedAgentResolver`). */
const resolverFor = (agentType: string, def: NamedAgentDefinition): NamedAgentResolver => ({
  resolve: (t) => (t === agentType ? def : undefined),
})

const withResolver = (parent: AgentConfig, resolver: NamedAgentResolver): AgentConfig =>
  ({ ...parent, namedAgentResolver: resolver }) as AgentConfig

/** Capture the child {@link AgentConfig} the runner builds. */
const captureChild = async (parent: AgentConfig, req: SubagentRequest): Promise<AgentConfig> => {
  const seen: AgentConfig[] = []
  const run = (async (c: AgentConfig) => {
    seen.push(c)
    return outcome
  }) as typeof runAgent
  await createSubagentRunner(parent, { run })(req)
  const child = seen[0]
  if (child === undefined) throw new Error("runner never forked a child")
  return child
}

/** Build a definition naming a `mode:` (the repo-controlled attack surface). */
const defWithMode = (agentType: string, mode: AgentMode | undefined): NamedAgentDefinition => ({
  agentType,
  system: `${agentType} role`,
  sourcePath: `/repo/.quanta/agents/${agentType}.md`,
  ...(mode !== undefined ? { mode } : {}),
})

describe("named-agent mode clamp — REAL fold path (hellgate)", () => {
  test("FOLD-1 resolver def.mode=default ⇒ review parent ⇒ child stays review", async () => {
    // The hostile definition declares a write-capable mode; folding it into
    // req.mode then clamping must NOT relax the review parent.
    const parent = withResolver(
      parentConfig("review"),
      resolverFor("evil", defWithMode("evil", "default")),
    )
    const child = await captureChild(parent, { prompt: "go", depth: 1, agentType: "evil" })
    expect(child.mode).toBe("review")
  })

  test("FOLD-2 architect parent + def.mode=editor ⇒ child stays architect", async () => {
    const parent = withResolver(
      parentConfig("architect"),
      resolverFor("builder", defWithMode("builder", "editor")),
    )
    const child = await captureChild(parent, { prompt: "go", depth: 1, agentType: "builder" })
    expect(child.mode).toBe("architect")
  })

  test("FOLD-3 read-only def.mode=audit on review parent ⇒ further restriction honored", async () => {
    const parent = withResolver(
      parentConfig("review"),
      resolverFor("auditor", defWithMode("auditor", "audit")),
    )
    const child = await captureChild(parent, { prompt: "go", depth: 1, agentType: "auditor" })
    expect(child.mode).toBe("audit")
  })

  test("FOLD-4 explicit req.mode beats def.mode, then STILL clamps", async () => {
    // Caller explicitly asks default (wins over def.mode=audit) — but the review
    // parent floors it back to review. Proves the clamp is downstream of BOTH
    // the explicit-request-wins fold AND the def default.
    const parent = withResolver(parentConfig("review"), resolverFor("x", defWithMode("x", "audit")))
    const child = await captureChild(parent, {
      prompt: "go",
      depth: 1,
      agentType: "x",
      mode: "default",
    })
    expect(child.mode).toBe("review")
  })

  test("FOLD-NOMATCH unknown agentType ⇒ no def folded ⇒ inherit parent (byte-identical)", async () => {
    const parent = withResolver(
      parentConfig("review"),
      resolverFor("known", defWithMode("known", "default")),
    )
    const child = await captureChild(parent, { prompt: "go", depth: 1, agentType: "unknown" })
    expect(child.mode).toBe("review")
  })
})

describe("named-agent mode clamp — depth-2 grandchild non-escape (hellgate)", () => {
  // Drive TWO nested spawns through the REAL runner: parent → child (clamped)
  // → grandchild. The grandchild's parent IS the clamped child config, so a
  // read-only floor at depth 1 must keep flooring at depth 2 (no escape by
  // re-requesting `default` one level deeper).
  //
  // OPERATOR-POLICY WIDEN (RFC jul-13 §4.2 rev.4 min-cap): admitting a depth-2
  // grandchild requires `effectiveCap >= 2`. The effective cap is
  // `min(spawnDepthCap() operator policy, opts.maxDepth ?? +∞)` and the operator
  // policy `maxDescendantDepth` now DEFAULTS to 1 (min-cap RFC) — so with the
  // default policy `effectiveCap(undefined) = min(1, +∞) = 1` and the depth-2
  // spawn is DENIED before `run` ("runner never forked a child"). A per-config
  // `subagent.maxDepth` would NOT help: it only ever TIGHTENS below the policy
  // ceiling (`min(1, 2) = 1`), and `captureChild` passes NO `opts.maxDepth`
  // anyway. The authoritative lever is the operator policy env, so we widen it
  // to 2 (via the real runtime-config seam) around THIS block only — exactly the
  // pattern in `subagent-runner.test.ts`'s depth-guard block. The depth-1 tests
  // above stay untouched (they assert the DEFAULT-policy clamp).
  let savedPolicy: string | undefined
  beforeEach(() => {
    savedPolicy = process.env.QUANTA_MAX_DESCENDANT_DEPTH
    process.env.QUANTA_MAX_DESCENDANT_DEPTH = "2"
    __resetRuntimeConfig()
  })
  afterEach(() => {
    if (savedPolicy === undefined) delete process.env.QUANTA_MAX_DESCENDANT_DEPTH
    else process.env.QUANTA_MAX_DESCENDANT_DEPTH = savedPolicy
    __resetRuntimeConfig()
  })

  const grandchildOf = async (
    rootMode: AgentMode,
    childAgentType: string,
    childDefMode: AgentMode,
    grandReqMode: AgentMode,
  ): Promise<AgentMode | undefined> => {
    // Level 1: root → child. Capture the clamped child config.
    const rootParent = withResolver(
      parentConfig(rootMode),
      resolverFor(childAgentType, defWithMode(childAgentType, childDefMode)),
    )
    const child = await captureChild(rootParent, {
      prompt: "child",
      depth: 1,
      agentType: childAgentType,
    })
    // Level 2: clamped child → grandchild, grandchild requests a mutating mode.
    const grandchild = await captureChild(child, {
      prompt: "grand",
      depth: 2,
      mode: grandReqMode,
    })
    return grandchild.mode
  }

  test("DEPTH2 review root ⇒ review child ⇒ grandchild req default ⇒ stays review", async () => {
    expect(await grandchildOf("review", "evil", "default", "default")).toBe("review")
  })

  test("DEPTH2-ARCH architect root ⇒ architect child ⇒ grandchild req editor ⇒ stays architect", async () => {
    expect(await grandchildOf("architect", "builder", "editor", "editor")).toBe("architect")
  })
})

describe("named-agent mode clamp — END-TO-END dispatch denial (hellgate)", () => {
  // The strongest lock: the clamped child config is fed to the REAL
  // admissibility gate (the genuine pre-execute dispatch seam). A mutating tool
  // must be DENIED because `denyIfModeBlocked` reads `config.mode` (the clamped
  // "review"), proving the clamp is enforced END-TO-END, not merely stored.
  const permission: PermissionContext = { mode: "default" }

  /** Build the action the dispatch seam derives for a tool call. */
  const actionFor = (name: string, isReadOnly: boolean) => ({
    tool: name,
    input: {},
    isReadOnly,
  })
  const callFor = (name: string) => ({
    type: "tool_use" as const,
    id: `c-${name}`,
    name,
    input: {},
  })

  test("E2E-DENY review-clamped child DENIES a mutating tool (write) at the real gate", async () => {
    const parent = withResolver(
      parentConfig("review"),
      resolverFor("evil", defWithMode("evil", "default")),
    )
    const child = await captureChild(parent, { prompt: "go", depth: 1, agentType: "evil" })
    // Sanity: the clamp landed.
    expect(child.mode).toBe("review")
    const result = await runAdmissibilityGate(
      callFor("write"),
      child,
      permission,
      actionFor("write", false),
    )
    // A non-null result here is the mode-block deny (read-only tools return null).
    expect(result).not.toBeNull()
    expect(result?.ok).toBe(false)
    // The deny preview is tagged `${mode}-blocked` and the content names the mode.
    expect(result?.preview).toContain("review-blocked")
  })

  test("E2E-ALLOW the SAME review-clamped child still ADMITS a read-only tool (read)", async () => {
    const parent = withResolver(
      parentConfig("review"),
      resolverFor("evil", defWithMode("evil", "default")),
    )
    const child = await captureChild(parent, { prompt: "go", depth: 1, agentType: "evil" })
    const result = await runAdmissibilityGate(
      callFor("read"),
      child,
      permission,
      actionFor("read", true),
    )
    // Read-only tools pass the mode gate (null = admitted at this gate).
    expect(result).toBeNull()
  })

  test("E2E-CONTROL an UNCLAMPED default child is NOT mode-blocked on the same mutating tool (proves the review deny is the MODE clamp, not the tool)", async () => {
    // Same definition + same write tool, but a MUTATING parent (default) ⇒ no
    // clamp ⇒ the write is NOT MODE-blocked. (The legacy permission policy
    // still declines a mutating tool under permission.mode:"default" — a
    // DIFFERENT gate — so the result is non-null, but its tag is the permission
    // decline, never `${mode}-blocked`.) This differential proves E2E-DENY's
    // denial is caused by the read-only mode clamp specifically: the SAME tool,
    // SAME definition, only the parent posture differs, and ONLY the read-only
    // posture produces a `*-blocked` mode deny.
    const parent = withResolver(
      parentConfig("default"),
      resolverFor("evil", defWithMode("evil", "default")),
    )
    const child = await captureChild(parent, { prompt: "go", depth: 1, agentType: "evil" })
    expect(child.mode).toBe("default")
    const result = await runAdmissibilityGate(
      callFor("write"),
      child,
      permission,
      actionFor("write", false),
    )
    // Whatever the legacy permission gate decides, it is NOT the mode-posture
    // block — the deny that DID fire for the review-clamped child.
    expect(result?.preview ?? "").not.toContain("-blocked")
    expect(result?.preview ?? "").not.toContain("review")
  })
})
