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
 * The knob resolves ONCE here per assembled session (`on` | `off`; deprecated
 * or unrecognized values fail safe to `on`), and the resolution's warning is
 * printed HERE, once — the resolver stays pure so no module latch can eat a
 * later session's notice.
 */
import type { AgentConfig } from "@/agent/types"
import { createUsageAccounting, resolveUsageAccounting } from "@/observability/usage-accounting"
import { logger } from "@/shared"

/**
 * Mint the authority unless the kill switch is thrown, leaving the slot
 * untouched otherwise.
 *
 * Absent slot ⇒ `emitUsage`'s accounting sink is a no-op and every cost
 * surface renders an explicit "accounting off". Caller-override-safe: a config
 * that already carries an authority keeps it — two instances would put the
 * recording and the rendering on different objects, which is the original
 * defect wearing a new shape.
 */
export const maybeWireUsageAccounting = (
  cfg: AgentConfig,
  env: Record<string, string | undefined>,
): void => {
  if (cfg.usageAccounting !== undefined) return
  const res = resolveUsageAccounting(env)
  if (res.warning !== undefined) logger.warn(res.warning)
  if (res.mode === "on") cfg.usageAccounting = createUsageAccounting()
}
