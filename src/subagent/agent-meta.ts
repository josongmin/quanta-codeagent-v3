/**
 * RFC-04 §4.2 (option B) / ADR-0437 — `AgentMetaRegistry`.
 *
 * A side-table mapping `agentId → { depth, label }`, kept SEPARATE from
 * `TaskRegistry` so the frozen `TaskRecord` contract is NOT mutated
 * (byte-identical spawn path). `spawn_agent` writes here ONLY when the host
 * injected this registry into the 6-tool deps; absent ⇒ no write, and
 * `list_agents` falls back to `depth=0` + a `description`-derived label.
 *
 * PURE: in-memory Map, no clock, no `node:`. Deterministic.
 */

export interface AgentMeta {
  readonly depth: number
  readonly label: string
}

export class AgentMetaRegistry {
  private readonly meta = new Map<string, AgentMeta>()

  /** Record metadata for a spawned child. Overwrites a prior entry (a re-used
   *  id is the spawner's responsibility; last write wins). */
  set(agentId: string, meta: AgentMeta): void {
    this.meta.set(agentId, meta)
  }

  get(agentId: string): AgentMeta | undefined {
    return this.meta.get(agentId)
  }

  /** Drop an entry (called when a child settles, if the host wires cleanup).
   *  Idempotent. */
  delete(agentId: string): void {
    this.meta.delete(agentId)
  }
}
