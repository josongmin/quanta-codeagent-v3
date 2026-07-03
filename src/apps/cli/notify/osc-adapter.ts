/**
 * RFC-09 (A) — default {@link NotificationPort} adapter: OSC window-title +
 * optional BEL. The ONLY place in the slice that knows escape sequences.
 *
 * Absorbed verbatim from competitors (RFC §1):
 *   - BEL char `\x07` (Claude Code `_cli-symbols :13717`).
 *   - OSC title form `ESC ] 0 ; <pt> (BEL | ST)` (Claude OSC parser :190796 —
 *     same terminator family). We emit `ESC ] 0 ; <pt> BEL`.
 *   - bell / title_only channel split (Claude `notifChannel`: `terminal_bell`
 *     vs `iterm2_with_bell`; we collapse to bell-or-not in v1, §non-goal).
 *
 * Pure + injectable: `write` (raw sink) and `now` are injected so tests collect
 * into a buffer with ZERO real terminal I/O. The composition root binds `write`
 * to a real `process.stdout.write` only when the TTY gate allows it.
 */

import type { IdleInfo, NotificationPort, PushStats, TurnCompleteInfo } from "./port"
import { shouldPush } from "./push-decision"

/** BEL — Claude `_cli-symbols :13717`. Doubles as the OSC string terminator. */
const BEL = "\x07"
/** ESC — start of every OSC sequence. */
const ESC = "\x1b"

/** Strip every C0 control char (0x00–0x1f) and DEL (0x7f) from a title payload.
 *  This is the title-injection guard: a cwd basename or summary that contains a
 *  stray BEL/ESC would otherwise terminate the OSC early and let an attacker
 *  inject arbitrary escape sequences. Char-code filter (no control-char regex
 *  literal in source). Multi-byte glyphs (✓/✗/…) pass through. Pure. */
export const sanitizeTitle = (s: string): string => {
  let out = ""
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    // C0 controls + DEL (covers BEL 0x07 / ESC 0x1b — the OSC terminators) AND
    // C1 controls 0x80-0x9f (notably NEL 0x85, which some terminals treat as a
    // line break / 8-bit OSC intro) AND the Unicode line/paragraph separators
    // U+2028 / U+2029. All can break or hijack the OSC frame; strip them.
    if (code <= 0x1f || code === 0x7f) continue
    if (code >= 0x80 && code <= 0x9f) continue
    if (code === 0x2028 || code === 0x2029) continue
    out += ch
  }
  return out
}

/** Build an `OSC 0 ; <title> BEL` sequence with the title sanitized. */
const oscTitle = (title: string): string => `${ESC}]0;${sanitizeTitle(title)}${BEL}`

export type NotifyChannel = "bell" | "title_only" | "off"

export interface OscNotifyDeps {
  /** Raw write sink (real `/dev/tty` / `process.stdout` at the wire point, a
   *  buffer in tests). The adapter writes nothing else. */
  readonly write: (s: string) => void
  /** `"bell"` ⇒ title + BEL; `"title_only"` ⇒ title, no extra BEL; `"off"` ⇒
   *  the adapter should not be built (the composition root checks this). */
  readonly channel: NotifyChannel
  /** "Slow turn only" threshold (ms). A turn shorter than this does NOT notify
   *  (anti-spam). Default 10_000. */
  readonly slowTurnThresholdMs?: number
  /** Optional clock (reserved for future rate-limiting; not used in v1). */
  readonly now?: () => number
  /** B5 (jul-03) — optional presence probe. When injected AND it returns true,
   *  the adapter SUPPRESSES the OSC/BEL push (the user is at the keyboard; the
   *  notification is for when they have looked away). The composition root binds
   *  this to `() => !idle.isIdle()` — the SSOT idle signal, no parallel focus
   *  tracker. ABSENT (default) ⇒ never suppressed ⇒ byte-identical legacy. */
  readonly isUserPresent?: () => boolean
}

const DEFAULT_SLOW_TURN_MS = 10_000

/**
 * Build the OSC/BEL-backed {@link NotificationPort}. When `channel === "off"`
 * the returned port is a pure no-op (defense in depth — the composition root
 * already avoids building it, but a stray construction stays silent).
 */
export const createOscNotificationPort = (deps: OscNotifyDeps): NotificationPort => {
  const { write, channel } = deps
  const slowTurnThresholdMs = deps.slowTurnThresholdMs ?? DEFAULT_SLOW_TURN_MS
  const isUserPresent = deps.isUserPresent

  // B5 — presence-suppression accounting (measurable). Zero when the presence
  // probe is absent (nothing is ever suppressed by presence).
  let sent = 0
  let suppressedUserPresent = 0
  // Read the injected presence probe. Absent ⇒ always false ⇒ byte-identical.
  // THROW-SAFE: a probe that throws must not crash the notify event (the call
  // sites in the REPL loop — prompt-pipeline / turn-helpers — have no try/catch).
  // Fail-OPEN toward NOTIFYING (treat a broken probe as "not present"): a
  // notification beats a crashed turn, and it matches the always-notify default
  // when presence is off.
  const presentNow = (): boolean => {
    if (isUserPresent === undefined) return false
    try {
      return isUserPresent() === true
    } catch {
      return false
    }
  }

  // True iff a push at THIS moment must be held back because the user is present.
  // The precedence ("should we actually write the push?") is owned by the pure
  // SSOT {@link shouldPush} — this adapter does NOT re-encode it. At this point
  // the channel-off gate (⇒ no-op port) and the write transport are already
  // resolved, so we feed the fixed `status:"on" / transport:true` slice and let
  // shouldPush decide the presence outcome. The adapter's OWN gates (fast-turn
  // anti-spam, once-per-idle latch) sit OUTSIDE shouldPush's model and are
  // composed by the call sites BEFORE this check — they are not presence gates.
  const pushHeldByPresence = (): boolean =>
    shouldPush({ status: "on", transport: true, present: presentNow() }).disabledReason ===
    "user_present"

  if (channel === "off") {
    return {
      onTurnComplete: () => undefined,
      onIdleAwaitingInput: () => undefined,
      markActive: () => undefined,
      dispose: () => undefined,
      getPushStats: (): PushStats => ({ sent: 0, suppressedUserPresent: 0 }),
    }
  }

  // Latch: notify once per idle ENTRY. Reset by `markActive` (new turn).
  let idleNotified = false
  // Idempotency for dispose — restore the title at most once.
  let disposed = false
  // Remember the last basename so dispose can restore a NEUTRAL title (cwd
  // basename, not an empty string — an empty title makes some multiplexers
  // drop the tab label entirely, §6).
  let lastBasename = ""

  const bell = (): void => {
    if (channel === "bell") write(BEL)
  }

  return {
    onTurnComplete: (info: TurnCompleteInfo): void => {
      lastBasename = info.cwdBasename
      // Anti-spam: fast turns are silent. A non-finite/negative duration is
      // treated as "not slow" (fail-closed — no notification on bad data). This
      // is NOT presence suppression, so it is not counted in getPushStats.
      if (!(info.durationMs >= slowTurnThresholdMs)) return
      // B5 — presence gate (routed through the SSOT shouldPush): user at the
      // keyboard ⇒ hold the push (counted).
      if (pushHeldByPresence()) {
        suppressedUserPresent += 1
        return
      }
      write(oscTitle(`${info.ok ? "✓" : "✗"} ${info.cwdBasename} — done`))
      bell()
      sent += 1
    },
    onIdleAwaitingInput: (info: IdleInfo): void => {
      lastBasename = info.cwdBasename
      if (idleNotified) return
      // B5 — presence gate (routed through the SSOT shouldPush): hold the push
      // while the user is present, but do NOT consume the once-per-entry latch
      // (so the push still fires if they go idle before the next markActive).
      // Counted as presence suppression.
      if (pushHeldByPresence()) {
        suppressedUserPresent += 1
        return
      }
      idleNotified = true
      write(oscTitle(`… ${info.cwdBasename} — waiting`))
      bell()
      sent += 1
    },
    markActive: (): void => {
      idleNotified = false
    },
    dispose: (): void => {
      if (disposed) return
      disposed = true
      // Restore a neutral title (cwd basename) so the tab does not keep the
      // "✓ done" / "… waiting" label after the session ends.
      write(oscTitle(lastBasename))
    },
    getPushStats: (): PushStats => ({ sent, suppressedUserPresent }),
  }
}
