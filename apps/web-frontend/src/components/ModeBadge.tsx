import { cx } from "../lib/classnames"
import type { SessionStateView } from "../types/protocol"

export interface ModeBadgeProps {
  readonly state: SessionStateView | null
}

/**
 * CLI parity: render the per-session mode levers (permission / identity /
 * tool profile) as small pills in the header so the user can see at a
 * glance what posture the turn will run under. Absent state ⇒ render
 * nothing (the StatusBar already covers the connection-level surface).
 */
export const ModeBadge = ({ state }: ModeBadgeProps): JSX.Element | null => {
  if (state === null) return null
  const pills: Array<{ label: string; value: string; tone: PillTone }> = []
  if (state.permissionMode.length > 0) {
    pills.push({
      label: "perm",
      value: state.permissionMode,
      tone: pillToneForPermission(state.permissionMode),
    })
  }
  if (state.identityMode !== undefined && state.identityMode.length > 0) {
    pills.push({ label: "mode", value: state.identityMode, tone: "neutral" })
  }
  if (state.toolProfile !== undefined && state.toolProfile.length > 0) {
    pills.push({ label: "tools", value: state.toolProfile, tone: "neutral" })
  }
  if (pills.length === 0) return null
  return (
    <div className="flex items-center gap-1">
      {pills.map((p) => (
        <Pill key={`${p.label}:${p.value}`} label={p.label} value={p.value} tone={p.tone} />
      ))}
    </div>
  )
}

type PillTone = "neutral" | "danger" | "warn" | "ok"

const TONE_BORDER: Record<PillTone, string> = {
  neutral: "border-line text-ink-secondary",
  ok: "border-ok/40 text-ok",
  warn: "border-warn/40 text-warn",
  danger: "border-err/40 text-err",
}

const Pill = ({
  label,
  value,
  tone,
}: { label: string; value: string; tone: PillTone }): JSX.Element => (
  <div
    className={cx(
      "rounded-full border px-2 py-0.5 text-xs",
      TONE_BORDER[tone],
    )}
  >
    <span className="text-ink-tertiary">{label}:</span>
    <span className="ml-1 font-mono">{value}</span>
  </div>
)

const pillToneForPermission = (mode: string): PillTone => {
  switch (mode) {
    case "default":
      return "ok"
    case "acceptEdits":
      return "warn"
    case "bypass":
    case "auto":
      return "danger"
    default:
      return "neutral"
  }
}
