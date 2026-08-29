/**
 * USAGE-ACCOUNTING OWNER — the single place that mints the session's
 * usage-accounting authority onto an assembled `AgentConfig`.
 *
 * There are two composition roots and they must agree. `assembleAgentConfig`
 * serves the headless / batch / SDK surfaces; the interactive CLI bootstraps
 * its own config through the runtime-context overlay and never touches the
 * assembler. A gate implemented in one of those and not the other is silently
 * dark on the surface a person actually watches — the failure this codebase
 * keeps rediscovering — so the decision lives here and both roots route
 * through it.
 *
 * The knob is `QUANTA_USAGE_ACCOUNTING_V2` (`off` | `shadow` | `on`); this
 * module only decides whether an authority EXISTS. Who reads it is a surface
 * question, answered by `usageAccountingIsAuthoritative` at the point of
 * render.
 */
import type { AgentConfig } from "@/agent/types"
import { createSessionUsageAccounting } from "@/observability/usage-accounting"

/**
 * Mint the authority when the operator opted in, leaving the slot untouched
 * otherwise.
 *
 * Absent slot ⇒ `emitUsage`'s accounting sink is a no-op and the loop is
 * byte-identical for every legacy caller. Caller-override-safe: a config that
 * already carries an authority keeps it, so a host that minted one for its own
 * surfaces stays its owner — two instances would put the recording and the
 * rendering on different objects, which is the original defect wearing a new
 * shape.
 */
export const maybeWireUsageAccounting = (
  cfg: AgentConfig,
  env: Record<string, string | undefined>,
): void => {
  if (cfg.usageAccounting !== undefined) return
  const accounting = createSessionUsageAccounting(env)
  if (accounting !== undefined) cfg.usageAccounting = accounting
}
