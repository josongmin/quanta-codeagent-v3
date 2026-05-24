import { READ_ONLY_FIXTURE } from "./parity-fixtures/read-only"
import { WORKSPACE_WRITE_FIXTURE } from "./parity-fixtures/workspace-write"
import { WORKSPACE_WRITE_NET_FIXTURE } from "./parity-fixtures/workspace-write-net"

/**
 * Closed enum of the three Seatbelt arms that have a verbatim fixture.
 * `off` and `danger-full-access` deliberately do NOT — they are
 * passthrough modes (compiler returns `null`).
 */
export type VerbatimArm = "read-only" | "workspace-write" | "workspace-write-net"

const FIXTURE: Readonly<Record<VerbatimArm, string>> = {
  "read-only": READ_ONLY_FIXTURE,
  "workspace-write": WORKSPACE_WRITE_FIXTURE,
  "workspace-write-net": WORKSPACE_WRITE_NET_FIXTURE,
}

/**
 * Returns the verbatim Codex-baseline fixture for `arm`, with
 * `__WORKSPACE__` substituted to the (escaped) workspace path.
 *
 * The substitution is exactly once per declared workspace subpath
 * (read line + optional write line). The placeholder is global-replaced
 * so a fixture editor cannot accidentally introduce a second occurrence
 * with a typo that would silently desync.
 */
export const renderVerbatim = (arm: VerbatimArm, escapedWorkspace: string): string => {
  const fixture = FIXTURE[arm]
  return fixture.replace(/__WORKSPACE__/g, escapedWorkspace)
}

export { READ_ONLY_FIXTURE, WORKSPACE_WRITE_FIXTURE, WORKSPACE_WRITE_NET_FIXTURE }
