/**
 * RFC-09 — REPL host factory for feature A (completion-notify port, ADR-0444)
 * and feature B (pre-compaction context warning, ADR-0445).
 *
 * Lives under `factories/` so the env / TTY reads stay OUT of the fenced host
 * file `repl.ts` and `surface-compose.ts` (both forbid direct `process.env` /
 * `isTTY`). The host calls this once and threads the result straight into
 * `runSessionLoop`. Both knobs default-OFF ⇒ all fields `undefined` ⇒
 * byte-identical.
 */

import * as nodePath from "node:path"
import { runtimeConfig } from "@/shared"
import { renderContextWarning, toWarningView } from "../../context-warning"
import {
  createOscNotificationPort,
  type NotificationPort,
  resolveNotifyChannel,
} from "../../notify"
import type { SegmentedUsageView } from "../../status-line"

/** Compaction threshold the warning compares against — mirrors
 *  `compaction.ts` `resolveThreshold` (`runtimeConfig().compactTokens ??
 *  DEFAULT_THRESHOLD`). DEFAULT_THRESHOLD is 120_000; kept local so the warning
 *  path never imports `@/agent`. */
const COMPACT_DEFAULT_THRESHOLD = 120_000

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
}): NotifyAndWarningBundle => {
  const channel = resolveNotifyChannel(process.env, process.stdout.isTTY)
  const notify =
    channel === "off"
      ? undefined
      : createOscNotificationPort({
          channel,
          write: (s) => {
            process.stdout.write(s)
          },
        })

  const compactThreshold = runtimeConfig().compactTokens ?? COMPACT_DEFAULT_THRESHOLD
  const contextWarning =
    process.stderr.isTTY === true
      ? (): string => renderContextWarning(toWarningView(args.contextUsageView(), compactThreshold))
      : undefined

  return {
    ...(notify !== undefined ? { notify, notifyCwdBasename: nodePath.basename(args.cwd) } : {}),
    ...(contextWarning !== undefined ? { contextWarning } : {}),
  }
}
