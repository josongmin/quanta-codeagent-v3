/**
 * skill-mcp-deps — per-session attach coordinator (ADR-0476 wiring).
 *
 * Holds the ONE per-session view of "which MCP servers are currently attached
 * on behalf of the active skill set" and drives the injected
 * {@link AttachMcpPort} / {@link DetachMcpPort} so that:
 *
 *   - on each `reconcile(activeSkills)` the deduped desired set
 *     ({@link resolveMcpDeps}) is diffed against what is already attached;
 *     ONLY the newly-needed servers are attached, and servers no longer
 *     needed by ANY active skill are detached (deactivation cleanup).
 *   - dedupe + lifetime survive across activations because the set of
 *     currently-attached identities lives in the coordinator's closure (one
 *     per session) — a second skill declaring the SAME server attaches it
 *     ONCE, not once-per-skill.
 *   - `shutdownAll()` releases everything at session end.
 *
 * PERFORMANCE invariant (the hard one the e2e hellgate asserts): across a
 * reconcile, `attach` is invoked with at most the DISTINCT not-yet-attached
 * servers — never once per skill. A reconcile that introduces no new server
 * performs ZERO attach calls (the empty-spec call is skipped). This keeps the
 * turn from being blocked by redundant launches.
 *
 * DEFAULT-OFF: {@link resolveMcpDeps} already short-circuits to `[]` when
 * `QUANTA_SKILL_MCP_DEPS !== "1"`, so a gate-OFF session resolves an empty
 * desired set every reconcile ⇒ nothing is ever attached ⇒ byte-identical to
 * today (the coordinator is a no-op).
 *
 * NO-THROW: every port call is wrapped; a throwing port leaves the tracked
 * state UNCHANGED for the affected identity (so a later reconcile retries)
 * and never escapes. The coordinator itself never throws.
 *
 * Slices imported: local (`./resolve`, `./types`) only. The attach/detach
 * ports are INJECTED (port inversion) — this module does NOT import
 * `@/agent/plugin-mcp-launcher`; the composition root maps the launcher onto
 * these ports.
 */

import { resolveMcpDeps } from "./resolve"
import {
  type ActiveSkillDeps,
  type AttachMcpPort,
  depIdentity,
  type McpAttachOutcome,
  type McpServerSpec,
  type SkillMcpDepsEnv,
} from "./types"

/**
 * The detach side of the lifetime seam. The composition root implements this
 * against the launcher's `PluginMcpRegistry.shutdownAll` / per-handle
 * `shutdown`. MUST NOT throw — failures are swallowed by the coordinator.
 */
export interface DetachMcpPort {
  /** Shut down the given previously-attached servers (identified by the SAME
   *  {@link depIdentity}-bearing spec they were attached with). Implementations
   *  MUST be idempotent — detaching an already-gone server is a no-op. */
  detach(specs: readonly McpServerSpec[]): Promise<void>
}

/** The injected lifetime ports the coordinator drives. `detach` is optional:
 *  a session that only wants attach-on-activation (shutdownAll at the end via
 *  the registry directly) may omit it — then mid-session deactivation does NOT
 *  tear servers down, but {@link SkillMcpSession.shutdownAll} still clears the
 *  coordinator's tracking. */
export interface SkillMcpPorts {
  readonly attach: AttachMcpPort
  readonly detach?: DetachMcpPort
}

/** What one reconcile actually did — returned for diagnostics + so the e2e
 *  hellgate can assert the exact attach/detach call shape. */
export interface ReconcileResult {
  /** Identities newly attached this reconcile (in attach-call order). */
  readonly attached: readonly string[]
  /** Identities detached this reconcile (no longer needed by any skill). */
  readonly detached: readonly string[]
}

/** The per-session coordinator handle. ONE per session — the composition root
 *  creates it once and calls {@link reconcile} on every activation change. */
export interface SkillMcpSession {
  /**
   * Diff the desired attach set (resolved from the CURRENT active skills) vs.
   * what is already attached; attach the new, detach the orphaned. NO-THROW.
   * Returns the exact set of identities attached/detached this call.
   */
  reconcile(activeSkills: readonly ActiveSkillDeps[]): Promise<ReconcileResult>
  /** Detach EVERYTHING currently tracked and clear state (session end). */
  shutdownAll(): Promise<void>
  /** Read-only snapshot of currently-attached identities (test/diagnostic). */
  attachedIdentities(): readonly string[]
}

/**
 * Create the per-session skill→MCP attach coordinator.
 *
 * @param ports — injected attach (+ optional detach) seam. Port inversion:
 *                the composition root wires these to
 *                `@/agent/plugin-mcp-launcher`.
 * @param env   — env projection read by the DEFAULT-OFF gate (never
 *                `process.env`). Captured once; pass a per-session snapshot.
 */
export const createSkillMcpSession = (
  ports: SkillMcpPorts,
  env: SkillMcpDepsEnv,
): SkillMcpSession => {
  // identity -> the spec it was attached with (kept so detach can hand the
  // launcher the same shape). The MAP is the single per-session source of
  // truth that makes dedupe + lifetime survive across reconciles.
  const attachedByIdentity = new Map<string, McpServerSpec>()

  const safeAttach = async (specs: readonly McpServerSpec[]): Promise<void> => {
    if (specs.length === 0) return
    let outcomes: readonly McpAttachOutcome[]
    try {
      outcomes = await ports.attach.attach(specs)
    } catch {
      // NO-THROW: a throwing attach leaves these identities UNTRACKED so a
      // later reconcile retries them. State below is only committed on success.
      return
    }
    // Commit ONLY the specs the port reports as actually attached. A per-spec
    // failure (`attached:false` — e.g. a launcher that returned `ready:false`
    // or an HTTP connect that rejected) is left UNCOMMITTED so a LATER reconcile
    // RE-tries it, honoring the attach port's untracked-on-failure contract.
    // Without this, the session would mark a never-started server "attached"
    // and (a) never retry it within the session AND (b) diverge from the
    // adapter's registry. Outcomes are returned in input order; zip by INDEX
    // because `serviceName` is NOT unique across HTTP deps (same name, different
    // transport/url is a distinct identity). A short/missing outcome ⇒ not
    // committed (defensive against a non-conforming port).
    specs.forEach((s, i) => {
      if (outcomes[i]?.attached === true) attachedByIdentity.set(depIdentity(s), s)
    })
  }

  const safeDetach = async (specs: readonly McpServerSpec[]): Promise<void> => {
    if (specs.length === 0) return
    if (ports.detach === undefined) {
      // No detach seam — drop tracking only (shutdownAll/ registry owns teardown).
      for (const s of specs) attachedByIdentity.delete(depIdentity(s))
      return
    }
    try {
      await ports.detach.detach(specs)
    } catch {
      // NO-THROW: leave tracking intact so a later shutdownAll still tries.
      return
    }
    for (const s of specs) attachedByIdentity.delete(depIdentity(s))
  }

  const reconcile = async (activeSkills: readonly ActiveSkillDeps[]): Promise<ReconcileResult> => {
    // Desired set is gate-aware (OFF ⇒ []). Deduped already by resolveMcpDeps.
    const desired = resolveMcpDeps(activeSkills, env)
    const desiredById = new Map<string, McpServerSpec>()
    for (const spec of desired) desiredById.set(depIdentity(spec), spec)

    // To attach: desired identities not currently attached. Preserve desired
    // order for determinism.
    const toAttach: McpServerSpec[] = []
    for (const spec of desired) {
      const id = depIdentity(spec)
      if (!attachedByIdentity.has(id)) toAttach.push(spec)
    }
    // To detach: currently-attached identities no longer desired.
    const toDetach: McpServerSpec[] = []
    for (const [id, spec] of attachedByIdentity) {
      if (!desiredById.has(id)) toDetach.push(spec)
    }

    // Snapshot the call sets BEFORE the awaited port work mutates the map so
    // the returned result reflects the intent regardless of port success.
    const attachedIds = toAttach.map(depIdentity)
    const detachedIds = toDetach.map(depIdentity)

    await safeAttach(toAttach)
    await safeDetach(toDetach)

    return { attached: attachedIds, detached: detachedIds }
  }

  const shutdownAll = async (): Promise<void> => {
    const all = [...attachedByIdentity.values()]
    await safeDetach(all)
    // safeDetach with no detach port only drops tracking; with a detach port
    // it clears on success. Force-clear regardless so session end is final.
    attachedByIdentity.clear()
  }

  const attachedIdentities = (): readonly string[] => [...attachedByIdentity.keys()]

  return { reconcile, shutdownAll, attachedIdentities }
}
