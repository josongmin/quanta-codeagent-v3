import { cx } from "../lib/classnames"
import type { SessionStateView } from "../types/protocol"

/** Closed set for `session.permission.set`. Mirrors `PermissionMode` in
 *  `src/permission/types.ts`; the drift-guard test pins parity. */
export const PERMISSION_MODE_OPTIONS = ["default", "acceptEdits", "bypass", "auto"] as const

export interface ModeBadgeProps {
  readonly state: SessionStateView | null
  /** Emit `session.permission.set`. Absent ⇒ the permission pill renders
   *  read-only (the daemon honors it live; see `useSendPermissionMode`). */
  readonly onSetPermission?: (mode: string) => void
}

/**
 * CLI parity: render the per-session mode levers (permission / identity /
 * tool profile) in the header. ONLY the permission lever is INTERACTIVE — a
 * `<select>` that emits `session.permission.set`, which the daemon honors live
 * on the next turn (its `permission.mode` is a getter/setter proxy). Identity
 * and tool-profile stay READ-ONLY pills: the web daemon bakes those into the
 * AgentConfig at session creation (system prompt / tool set), so switching them
 * mid-session would be a lying control — not offered here. Absent state ⇒ render
 * nothing (the StatusBar covers the connection surface).
 */
export const ModeBadge = ({ state, onSetPermission }: ModeBadgeProps): JSX.Element | null => {
  if (state === null) return null
  const hasPerm = state.permissionMode.length > 0
  const hasIdentity = state.identityMode !== undefined && state.identityMode.length > 0
  const hasProfile = state.toolProfile !== undefined && state.toolProfile.length > 0
  if (!hasPerm && !hasIdentity && !hasProfile) return null
  return (
    <div className="flex items-center gap-1">
      {hasPerm ? (
        <PermissionLever
          value={state.permissionMode}
          tone={pillToneForPermission(state.permissionMode)}
          {...(onSetPermission !== undefined ? { onChange: onSetPermission } : {})}
        />
      ) : null}
      {hasIdentity ? <Pill label="mode" value={state.identityMode ?? ""} tone="neutral" /> : null}
      {hasProfile ? <Pill label="tools" value={state.toolProfile ?? ""} tone="neutral" /> : null}
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
  <div className={cx("rounded-full border px-2 py-0.5 text-xs", TONE_BORDER[tone])}>
    <span className="text-ink-tertiary">{label}:</span>
    <span className="ml-1 font-mono">{value}</span>
  </div>
)

/** The permission lever — a pill-styled `<select>`. When `onChange` is absent it
 *  renders the live value but is disabled (read-only parity). A daemon-reported
 *  mode outside the mirror still shows (never hide the live truth). */
const PermissionLever = ({
  value,
  tone,
  onChange,
}: {
  readonly value: string
  readonly tone: PillTone
  readonly onChange?: (next: string) => void
}): JSX.Element => {
  const opts: readonly string[] = PERMISSION_MODE_OPTIONS.includes(
    value as (typeof PERMISSION_MODE_OPTIONS)[number],
  )
    ? PERMISSION_MODE_OPTIONS
    : [value, ...PERMISSION_MODE_OPTIONS]
  return (
    <label className={cx("flex items-center rounded-full border px-2 py-0.5 text-xs", TONE_BORDER[tone])}>
      <span className="text-ink-tertiary">perm:</span>
      <select
        value={value}
        disabled={onChange === undefined}
        onChange={(e) => onChange?.(e.target.value)}
        aria-label="set permission mode"
        className="ml-1 cursor-pointer appearance-none bg-transparent font-mono focus:outline-none disabled:cursor-default"
      >
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  )
}

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
