/**
 * RFC-09 (A) — TTY/opt-in gate for the completion-notify adapter. Pure
 * function, no global reads (mirrors `status-bar.ts` `isStatusBarSupported`).
 *
 * DEFAULT-OFF (opt-in): unlike the spinner (default-ON), changing the terminal
 * title is a visible side effect on the user's tab name / multiplexer, so the
 * feature requires an EXPLICIT `QUANTA_NOTIFY` opt-in. Absent ⇒ `"off"` ⇒ the
 * composition root builds no port ⇒ byte-identical output.
 *
 * Channel selection (Claude `notifChannel` absorption):
 *   - `QUANTA_NOTIFY` unset / `0`/`off`/`false`/`no` ⇒ `"off"`
 *   - `QUANTA_NOTIFY=bell`            ⇒ `"bell"` (title + BEL)
 *   - `QUANTA_NOTIFY=title`/`title_only` ⇒ `"title_only"` (title, no BEL)
 *   - `QUANTA_NOTIFY=1`/`on`/`true`/`yes` ⇒ `"bell"` (sensible default)
 *
 * Hard gates (override any opt-in ⇒ `"off"`):
 *   - non-TTY (pipe / redirect / CI) — NEVER write an OSC byte to a pipe.
 *   - `TERM=dumb` — no escape-sequence support.
 */

import type { NotifyChannel } from "./osc-adapter"

const FALSY = new Set(["0", "off", "false", "no", ""])
const TRUTHY = new Set(["1", "on", "true", "yes"])

export const resolveNotifyChannel = (
  env: NodeJS.ProcessEnv,
  isTTY: boolean | undefined,
): NotifyChannel => {
  // Hard gates first — these win over any opt-in value.
  if (isTTY !== true) return "off"
  if ((env.TERM ?? "").trim().toLowerCase() === "dumb") return "off"

  const raw = (env.QUANTA_NOTIFY ?? "").trim().toLowerCase()
  if (raw === "") return "off" // unset ⇒ opt-in absent
  if (FALSY.has(raw)) return "off"
  if (raw === "bell") return "bell"
  if (raw === "title" || raw === "title_only") return "title_only"
  if (TRUTHY.has(raw)) return "bell"
  // Unknown value ⇒ fail-closed (no surprise escape output).
  return "off"
}
