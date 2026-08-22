/**
 * SECURITY HELLGATE (jul-27, 3-round audit HIGH — two independent agents + direct
 * verification): the subagent FS-ownership fence did NOT compose across the SPAWN
 * boundary. `buildChildBase` built the child policy purely from the model-typed
 * `owned_surfaces`/`forbidden_surfaces` and NEVER read `parent.ownershipPolicy`.
 * So a fenced parent (owned=["src"], enforced) whose menu includes the default-ON
 * `agent`/`subagent_fork` tool could spawn a child with:
 *   · NO owned_surfaces          → child policy `undefined` → COMPLETELY UNFENCED
 *   · owned_surfaces=["."]        → child owns the WHOLE repo (widened)
 *   · dropped forbidden_surfaces  → child writes the parent's forbidden paths
 * …a full escape of the parent's fence one spawn-level down.
 *
 * FIX: `narrowChildOwnership(parent, child)` — child ≤ parent ALWAYS: owned kept
 * only if ⊆ parent (else inherit parent, never unfenced/widened); forbidden =
 * parent ∪ child; enforced stays true if the parent enforced. Wired into
 * `buildChildBase`.
 *
 * RED-first: revert the `narrowChildOwnership` wrap in subagent-runner-child-
 * config.ts (use `requestedPolicy` directly) ⇒ the INHERIT + CLAMP e2e cases flip
 * to `ownershipPolicy === undefined` / widened (escape). Proven in-tree.
 */
import { describe, expect, test } from "bun:test"
import { buildOwnershipPolicy, narrowChildOwnership } from "@/agent/ownership-policy"
import { buildChildConfig } from "@/agent/subagent-runner-child-config"
import type { AgentConfig, AgentOutcome } from "@/agent/types"
import type { SubagentRequest } from "@/subagent"
import { ToolRegistry } from "@/tool"

// ── UNIT: narrowChildOwnership — child ≤ parent, never widens ──
const P = (owned: string[], forbidden: string[] = []) =>
  buildOwnershipPolicy({ owned, forbidden, cwd: "/repo", enforced: true })

describe("narrowChildOwnership — child can only NARROW the parent fence", () => {
  test("parent NOT enforced ⇒ child kept as-requested (byte-identical legacy)", () => {
    const child = buildOwnershipPolicy({ owned: ["anything"], cwd: "/repo", enforced: true })
    expect(narrowChildOwnership(undefined, child)).toBe(child)
    const advisory = buildOwnershipPolicy({ owned: ["src"], cwd: "/repo", enforced: false })
    expect(narrowChildOwnership(advisory, child)).toBe(child)
  })

  test("child requests NOTHING ⇒ INHERITS the parent owned (NOT unfenced)", () => {
    const merged = narrowChildOwnership(P(["src"]), undefined)
    expect(merged?.enforced).toBe(true)
    expect(merged?.owned).toEqual(["/repo/src"])
  })

  test("child requests WIDER (['.']) ⇒ clamped to parent owned", () => {
    const merged = narrowChildOwnership(P(["src"]), P(["."]))
    // "." → /repo, which is NOT inside /repo/src ⇒ dropped ⇒ inherit parent
    expect(merged?.owned).toEqual(["/repo/src"])
  })

  test("child requests a SUBSET ⇒ narrows to the subset", () => {
    const merged = narrowChildOwnership(P(["src"]), P(["src/sub"]))
    expect(merged?.owned).toEqual(["/repo/src/sub"])
  })

  test("child cannot DROP the parent forbidden (union)", () => {
    const merged = narrowChildOwnership(P(["src"], ["src/secret"]), P(["src"]))
    expect(merged?.forbidden).toContain("/repo/src/secret")
  })

  test("child ADDS forbidden ⇒ union of both", () => {
    const merged = narrowChildOwnership(P(["src"], ["src/a"]), P(["src"], ["src/b"]))
    expect(merged?.forbidden).toEqual(["/repo/src/a", "/repo/src/b"])
  })

  test("enforced stays true even if the child's own flag is off", () => {
    const childUnenforced = buildOwnershipPolicy({
      owned: ["src/x"],
      cwd: "/repo",
      enforced: false,
    })
    const merged = narrowChildOwnership(P(["src"]), childUnenforced)
    expect(merged?.enforced).toBe(true)
  })
})

// ── DISPATCH E2E: buildChildConfig actually threads the narrowed policy ──
const parentConfig = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    // biome-ignore lint/suspicious/noExplicitAny: inert port stub
    llm: { stream: async function* () {} } as any,
    registry: new ToolRegistry([]),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "PARENT" }] }],
    system: "PARENT SYSTEM",
    cwd: "/repo",
    maxTurns: 17,
    signal: new AbortController().signal,
    ...over,
  }) as AgentConfig
const req = (over: Partial<SubagentRequest> = {}): SubagentRequest => ({
  prompt: "do the thing",
  depth: 1,
  ...over,
})
const mailbox = { agentId: "child", parentId: "parent" }
const ENFORCE = { fsOwnershipEnforce: true }
// buildChildConfig(parent, req, cwd, mailboxIds, toolNamespace, turnGate, spawnedAsTaskId, childRuntime)
const child = (parent: AgentConfig, r: SubagentRequest): AgentConfig =>
  buildChildConfig(parent, r, "/repo", mailbox, undefined, undefined, undefined, ENFORCE)

const fencedPolicy = P(["src"], ["src/secret"])
if (fencedPolicy === undefined) throw new Error("fixture: expected a defined policy")
const fencedParent = () => parentConfig({ ownershipPolicy: fencedPolicy })

describe("§20.4 spawn E2E — a fenced parent's fence is INHERITED, not escapable", () => {
  test("child spawned with NO surfaces ⇒ INHERITS parent fence (was undefined=unfenced)", () => {
    const c = child(fencedParent(), req())
    expect(c.ownershipPolicy).toBeDefined()
    expect(c.ownershipPolicy?.enforced).toBe(true)
    expect(c.ownershipPolicy?.owned).toEqual(["/repo/src"])
    expect(c.ownershipPolicy?.forbidden).toContain("/repo/src/secret")
  })

  test("child spawned WIDER (owned_surfaces=['.']) ⇒ clamped to parent /repo/src", () => {
    const c = child(fencedParent(), req({ ownedSurfaces: ["."] }))
    expect(c.ownershipPolicy?.owned).toEqual(["/repo/src"])
  })

  test("child spawned to a SUBSET ⇒ narrowed", () => {
    const c = child(fencedParent(), req({ ownedSurfaces: ["src/sub"] }))
    expect(c.ownershipPolicy?.owned).toEqual(["/repo/src/sub"])
    expect(c.ownershipPolicy?.forbidden).toContain("/repo/src/secret")
  })

  test("UNFENCED parent ⇒ child keeps its own request (no regression)", () => {
    const c = child(parentConfig(), req({ ownedSurfaces: ["src/x"] }))
    // parent not enforced; child's own enforced flag comes from childRuntime=ENFORCE
    expect(c.ownershipPolicy?.owned).toEqual(["/repo/src/x"])
  })
})

// keep AgentOutcome import honest (shared scaffolding shape)
export type _Outcome = AgentOutcome
