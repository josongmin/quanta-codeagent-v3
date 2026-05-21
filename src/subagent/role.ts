/**
 * agent_role enum + role-to-tool-policy table (Cluster E / F16, ADR-0042).
 *
 * Codex absorbed: subagent invocations classify by intent into three roles:
 *   - `explorer` (42%) — read-only, wide-scope search/inspection.
 *   - `none`     (28%) — no role; child inherits parent's full tool set.
 *   - `worker`   (16%) — mutating tools enabled, narrow scope.
 *   (Remaining ~14% are other / experimental — collapsed into `none` here.)
 *
 * This module is contracts-only. Role enforcement (filtering the child's
 * registry by `allowedToolKinds`) is wired by `./agent-tool.ts` (in-flight
 * on main). The point of having the table here is for `agent-role-policy.test.ts`
 * to assert that EVERY ToolKind has an explicit allow/deny per role — adding
 * a new ToolKind without a role mapping is a build-time failure.
 *
 * Slice contract: no imports from outside the subagent slice. ToolKind is
 * declared here as a local enum (rather than imported from @/tool) so this
 * module remains self-contained.
 */

/** Canonical tool-kind partition used for role enforcement. This is NOT the
 *  same as the @/tool registry's per-tool name list — it's a coarse class
 *  bucket. Adding a new bucket requires updating EVERY role row below. */
export const TOOL_KINDS = [
  /** Reading files / listing directories / running grep. */
  "read",
  /** Editing / writing / creating / deleting files. */
  "edit",
  /** Running shell commands (potentially mutating). */
  "shell",
  /** Fetching network resources (HTTP, MCP). */
  "network",
  /** Spawning child subagents (recursive). */
  "subagent",
  /** Memory / scratchpad / working-set operations. */
  "memory",
  /** LSP queries (semantic navigation; read-only). */
  "lsp",
] as const

export type ToolKind = (typeof TOOL_KINDS)[number]

export type AgentRole = "explorer" | "worker" | "none"

export const AGENT_ROLES: readonly AgentRole[] = Object.freeze(["explorer", "worker", "none"])

export interface RoleToolPolicy {
  /** Tool kinds the role MAY use. */
  readonly allowedToolKinds: readonly ToolKind[]
  /** Tool kinds the role MAY NOT use. Disjoint from `allowedToolKinds`. */
  readonly deniedToolKinds: readonly ToolKind[]
}

/** EXPLICIT table — every (role, ToolKind) cell is filled. If a new ToolKind
 *  lands without a corresponding row here, `agent-role-policy.test.ts` fails
 *  intentionally. NO defaulting, NO heuristics. */
const POLICY_TABLE: Readonly<Record<AgentRole, RoleToolPolicy>> = Object.freeze({
  explorer: {
    // Read-only, wide-scope: read/lsp/memory yes; edit/shell/network/subagent no.
    allowedToolKinds: Object.freeze(["read", "lsp", "memory"] as const),
    deniedToolKinds: Object.freeze(["edit", "shell", "network", "subagent"] as const),
  },
  worker: {
    // Narrow mutator: edit/read/shell/memory yes; network/subagent/lsp no
    // (workers receive a small surface; LSP nav is the explorer's job).
    allowedToolKinds: Object.freeze(["read", "edit", "shell", "memory"] as const),
    deniedToolKinds: Object.freeze(["network", "subagent", "lsp"] as const),
  },
  none: {
    // No role; inherit parent's full set. Both lists are empty by design —
    // the host is expected to fall back to parent policy when this role is
    // active. The empty-allowed/empty-denied combo is recognised by
    // `getToolPolicyForRole` consumers as the "inherit" signal.
    allowedToolKinds: Object.freeze([] as readonly ToolKind[]),
    deniedToolKinds: Object.freeze([] as readonly ToolKind[]),
  },
})

export class UnknownAgentRoleError extends Error {
  override readonly name = "UnknownAgentRoleError"
  constructor(role: string) {
    super(`unknown agent_role '${role}'`)
  }
}

/** Look up the policy for `role`. Throws on unknown role (defensive — the
 *  Zod / TS enum should already prevent this, but a runtime miss is bad
 *  enough that we want to crash, not silently fall through to a default). */
export const getToolPolicyForRole = (role: AgentRole): RoleToolPolicy => {
  const p = POLICY_TABLE[role]
  if (p === undefined) throw new UnknownAgentRoleError(role)
  return p
}

/** Convenience predicate: does `role` permit the given kind? `none` returns
 *  true for everything (it inherits parent policy). */
export const roleAllowsKind = (role: AgentRole, kind: ToolKind): boolean => {
  const p = getToolPolicyForRole(role)
  if (p.allowedToolKinds.length === 0 && p.deniedToolKinds.length === 0) return true
  return p.allowedToolKinds.includes(kind)
}
