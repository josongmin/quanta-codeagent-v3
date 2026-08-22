/**
 * LEAF — the ProMax PUBLIC PROJECTION, owned by the profile layer.
 *
 * Packet invariant 3, verbatim: *"Agent-visible data and grader-only data are
 * different types and storage roots. Gold patch, test patch, eval script, golden
 * output, and derived image receipts never enter the agent workspace, prompt,
 * repo map, or index root."*
 *
 * The corpus reader keeps the WHOLE upstream row on `SwebenchTask.raw`, and
 * `toInstance` lifts `raw.patch` straight onto `Instance.goldPatch`. So for a
 * family whose dataset file ships gold inline — which SWE-Bench-ProMax does,
 * every one of its 170 rows carrying `patch` and `test_patch` (field spec
 * verified against upstream by PMX-00's `corpus-identity.ts`) — the parse step IS
 * the leak boundary. Projecting here means the ProMax family cannot put gold on
 * an agent surface even by accident, because there is no code path from the
 * dataset file to the agent that does not go through this function.
 *
 * DIRECTION OF SAFETY: this is a DENY list of the two gold-bearing keys rather
 * than an allow-list of public ones, because ProMax rows are not key-uniform
 * (`pull_number` appears on 104/170, `issue_numbers` on 3/170) and an allow-list
 * would silently drop legitimate public metadata as upstream evolves. PMX-02
 * owns the typed grader-only/agent-visible split; this is the fail-safe floor
 * PMX-01 must not ship without.
 */

/** Row keys that carry GOLD and must never reach an agent-visible surface. */
export const PROMAX_GRADER_ONLY_ROW_KEYS = ["patch", "test_patch"] as const

/**
 * Project ONE raw ProMax row to its agent-visible form. Pure; returns a new
 * object (never mutates the caller's row) so the grader-only view PMX-02 builds
 * from the same bytes is unaffected.
 */
export const projectProMaxRowForAgent = (raw: Record<string, unknown>): Record<string, unknown> => {
  const projected: Record<string, unknown> = {}
  const denied = new Set<string>(PROMAX_GRADER_ONLY_ROW_KEYS)
  for (const [key, value] of Object.entries(raw)) {
    if (denied.has(key)) continue
    projected[key] = value
  }
  return projected
}

/** Does this row still carry grader-only material? Used by the ProMax preflight
 *  to refuse shipping a gold-bearing chunk to a remote box. */
export const proMaxGraderOnlyKeysPresent = (raw: Record<string, unknown>): readonly string[] =>
  PROMAX_GRADER_ONLY_ROW_KEYS.filter((k) => raw[k] !== undefined && raw[k] !== null)
