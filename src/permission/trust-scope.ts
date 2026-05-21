/**
 * Trust-scope registry (Phase C wire-up). Models per-project grants that
 * short-circuit the legacy ask-flow when a previously-approved structurally-
 * equivalent action is repeated within the grant's scope. The registry is
 * DEFAULT OFF — `AgentConfig.trustScope` must be set explicitly for the gate
 * to consult it. Absent ⇒ the admissibility-gate path is byte-identical to
 * the pre-Phase-C behavior.
 *
 * Slice discipline (RFC §1.2 + biome boundaries):
 *   - This file lives under `@/permission` and MUST NOT import from `@/agent`.
 *   - `admissibility-gate.ts` type-imports the registry interface only; the
 *     concrete in-memory implementation is wired by the caller.
 *
 * Scope semantics (smallest set required by Phase C):
 *   - `always_allow`   — durable allow across runs (caller persists).
 *   - `project`        — allow for the lifetime of this project key.
 *   - `workspace`      — allow within a workspace (multi-project root).
 *   - `session`        — allow for the lifetime of this session.
 *   - `once_only`      — allow exactly one matching invocation (consumed on
 *                        first `hasGrant=true` answered to the gate).
 *   - `deny`           — explicit deny; the wire-up does NOT treat this as an
 *                        ask-skip (deny routes through the legacy/explicit
 *                        deny path).
 *
 * The wire-up only treats `hasGrant(...) === true` as ask-skip. The registry
 * is responsible for returning `false` for `deny`-scoped grants — the gate
 * code does not branch on scope literals. This keeps the gate one `if`.
 */

export type TrustScope = "always_allow" | "project" | "workspace" | "session" | "once_only" | "deny"

/** Stable key the registry uses to compare two actions for "structural
 *  equivalence". The simplest stable key is the tool name; callers wanting
 *  finer granularity (e.g. fs_write per-path) can encode their own key into
 *  the `actionKey` field. The registry treats both fields as opaque strings. */
export interface TrustScopeAction {
  readonly tool: string
  /** Optional stable composite key (e.g. `fs_write:/repo/x.ts`). When absent
   *  the registry falls back to `tool` alone. */
  readonly actionKey?: string
}

/** Per-project grant record. Caller-grants and the registry's `grant()` both
 *  produce records of this shape; `hasGrant()` answers true when at least
 *  one positive scope is present for the projectKey + action pair. */
export interface TrustScopeGrant {
  readonly tool: string
  readonly scope: TrustScope
  /** Optional finer key (must match the lookup key when set). */
  readonly actionKey?: string
}

/** The wire-up only invokes `hasGrant`. `consume` is called by the registry
 *  itself when a `once_only` grant resolves to true; exposing it on the
 *  interface keeps the registry transparent for tests and lets future callers
 *  manually consume / inspect state. `grant` is used by callers (UI, CLI
 *  flags) to seed entries; the gate never calls it. */
export interface TrustScopeRegistry {
  hasGrant(projectKey: string, action: TrustScopeAction): boolean
  consume(projectKey: string, action: TrustScopeAction): void
  grant(projectKey: string, grant: TrustScopeGrant): void
}

/** Positive scopes — `hasGrant` returns true when ANY record with one of
 *  these scopes matches; once_only is additionally consumed inline. */
const POSITIVE_SCOPES: ReadonlySet<TrustScope> = new Set<TrustScope>([
  "always_allow",
  "project",
  "workspace",
  "session",
  "once_only",
])

const matches = (grant: TrustScopeGrant, action: TrustScopeAction): boolean => {
  if (grant.tool !== action.tool) return false
  // actionKey scoping: when the grant pins a specific key, the action MUST
  // match it; when the grant has no key, it covers any actionKey for the tool.
  if (grant.actionKey !== undefined && grant.actionKey !== action.actionKey) return false
  return true
}

/**
 * In-memory registry impl. Production callers (CLI, web surface) typically
 * wrap this with a persistent store for `always_allow`/`project` scopes; the
 * gate itself only needs the in-memory contract.
 *
 * Concurrency: the gate is single-threaded per-turn, so this implementation
 * intentionally uses plain Maps without locks. Cross-turn callers (multiple
 * agents sharing a registry) should serialize external mutations themselves.
 */
export const createInMemoryTrustScopeRegistry = (): TrustScopeRegistry => {
  const store = new Map<string, TrustScopeGrant[]>()

  const find = (projectKey: string): TrustScopeGrant[] => store.get(projectKey) ?? []

  return {
    hasGrant(projectKey, action): boolean {
      const entries = find(projectKey)
      const hit = entries.find((g) => POSITIVE_SCOPES.has(g.scope) && matches(g, action))
      if (!hit) return false
      if (hit.scope === "once_only") {
        // Consume inline: remove this one record. We can't use Array.filter
        // because identical entries should each be consumed individually —
        // pop ONE matching record.
        const idx = entries.indexOf(hit)
        if (idx >= 0) entries.splice(idx, 1)
        if (entries.length === 0) store.delete(projectKey)
      }
      return true
    },
    consume(projectKey, action): void {
      const entries = find(projectKey)
      const idx = entries.findIndex((g) => g.scope === "once_only" && matches(g, action))
      if (idx >= 0) {
        entries.splice(idx, 1)
        if (entries.length === 0) store.delete(projectKey)
      }
    },
    grant(projectKey, grant): void {
      const list = store.get(projectKey)
      if (list) list.push(grant)
      else store.set(projectKey, [grant])
    },
  }
}
