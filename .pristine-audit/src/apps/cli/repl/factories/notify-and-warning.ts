/**
 * RFC-09 — REPL host factory for feature A (completion-notify port, ADR-0444)
 * and feature B (pre-compaction context warning, ADR-0445).
 *
 * Lives under `factories/` so the env / TTY reads stay OUT of the fenced host
 * file `repl.ts` and `surface-compose.ts` (both forbid direct `process.env` /
 * `isTTY`). The host calls this once and threads the result straight into
 * `runSessionLoop`. Both knobs default-OFF ⇒ all fields `undefined` ⇒
 * byte-identical.
 *
 * M3/S3 (jun-7 FINAL): the context-% warning now derives its threshold from the
 * SAME SSOT the compaction wire uses (`resolveCompactionLimitTokens`, which
 * applies the D4 model-window derivation). Previously this hardcoded the
 * model-blind 120k constant, so on a 1M-context session the warning disagreed
 * with the real ~923k threshold. The active model is read per-turn from the
 * retained usage view (`view.model`), so the display can never disagree with
 * the real compaction threshold for that model.
 */

import * as nodePath from "node:path"
import { resolveCompactionLimitTokens } from "@/agent"
import { renderContextWarning, toWarningView } from "../../context-warning"
import {
  createOscNotificationPort,
  type NotificationPort,
  resolveNotifyChannel,
} from "../../notify"
import type { SegmentedUsageView } from "../../status-line"

export interface NotifyAndWarningBundle {
  /** RFC-09 (A) — built only when `QUANTA_NOTIFY` opt-in + stdout TTY. */
  readonly notify?: NotificationPort
  /** RFC-09 (A) — short cwd label for the notify title. */
  readonly notifyCwdBasename?: string
  /** RFC-09 (B) — warning provider; built only when stderr is a TTY. */
  readonly contextWarning?: () => string
}

/**
 * Build the RFC-09 A+B host bundle. `contextUsageView` is the surface's
 * retained per-turn usage getter (`wires.contextUsageView`); the warning reuses
 * the SAME token count (no new heuristic). Reads `process.env` / `process.*TTY`
 * here (factory layer — outside the host fence).
 */
export const buildNotifyAndContextWarning = (args: {
  readonly cwd: string
  readonly contextUsageView: () => SegmentedUsageView | undefined
  /** B5 (jul-03) — SSOT presence probe (`() => !idle.isIdle()`) from the
   *  composition root. Attached to the notify port ONLY when the presence gate
   *  `QUANTA_NOTIFY_PRESENCE` is opted in; otherwise the port is built WITHOUT
   *  `isUserPresent` ⇒ byte-identical always-notify (no silent inversion). */
  readonly isUserPresent?: () => boolean
}): NotifyAndWarningBundle => {
  const channel = resolveNotifyChannel(process.env, process.stdout.isTTY)
  // B5 — default-OFF gate. Absent / falsy ⇒ presence probe NOT attached ⇒ the
  // legacy always-notify behavior is preserved byte-for-byte. Only an explicit
  // opt-in (1/on/true/yes) turns on presence suppression, matching the
  // competitor "suppress while the user is present" push semantics.
  const presenceRaw = (process.env.QUANTA_NOTIFY_PRESENCE ?? "").trim().toLowerCase()
  const presenceOn =
    presenceRaw === "1" || presenceRaw === "on" || presenceRaw === "true" || presenceRaw === "yes"
  const presenceProbe = presenceOn ? args.isUserPresent : undefined
  const notify =
    channel === "off"
      ? undefined
      : createOscNotificationPort({
          channel,
          write: (s) => {
            process.stdout.write(s)
          },
          ...(presenceProbe !== undefined ? { isUserPresent: presenceProbe } : {}),
        })

  const contextWarning =
    process.stderr.isTTY === true
      ? (): string => {
          const view = args.contextUsageView()
          // M3/S3 — derive the threshold from the SAME SSOT compaction uses,
          // model-aware via the active model on the retained view. No explicit
          // per-config override is plumbed to the display, so the resolver
          // applies the env override then the model-window derivation then the
          // 120k legacy default — identical precedence to the compaction wire.
          const compactThreshold = resolveCompactionLimitTokens(undefined, view?.model)
          return renderContextWarning(toWarningView(view, compactThreshold))
        }
      : undefined

  return {
    ...(notify !== undefined ? { notify, notifyCwdBasename: nodePath.basename(args.cwd) } : {}),
    ...(contextWarning !== undefined ? { contextWarning } : {}),
  }
}
