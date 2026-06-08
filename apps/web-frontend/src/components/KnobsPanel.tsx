/**
 * Knobs / Settings panel.
 *
 * A modal overlay that lists the runtime knob manifest from the daemon's
 * `GET /api/knobs`, grouped by `group`. Each row shows the env key, its
 * description, current value + source, and a `home` tag. A search box
 * filters by envKey / describe / group.
 *
 * Mutation surface: hot-toggleable bool knobs whose env key is in the
 * daemon's closed `/config` allowlist render an interactive toggle that
 * POSTs to `/config`; every other knob is read-only (the daemon would
 * reject the write). Redacted string values render as `[redacted]` and are
 * never un-redacted.
 *
 * Styling follows the Codex-aligned token system (DESIGN.md): a real modal
 * (`bg-surface-overlay` panel over a `bg-black/50` backdrop), `surface-input`
 * search field, `hover:bg-black/[0.05]` knob rows, mono env keys, uppercase-tracking
 * section headers.
 */

import { memo, useCallback, useEffect, useMemo, useState } from "react"
import { cx } from "../lib/classnames"
import {
  displayKnobValue,
  fetchKnobs,
  filterKnobGroups,
  isToggleableBool,
  type KnobEntry,
  type KnobsEndpoint,
  type KnobsResponse,
  knobBoolValue,
  postKnobValue,
} from "./slash-knobs"

export interface KnobsPanelProps {
  /** Daemon endpoint (httpUrl + optional bearer token). When `null` the
   *  panel renders a "not connected" notice instead of fetching. */
  readonly endpoint: KnobsEndpoint | null
  /** Close handler — host clears its `open` gate. */
  readonly onClose: () => void
}

type LoadState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly data: KnobsResponse }

export const KnobsPanel = ({ endpoint, onClose }: KnobsPanelProps): JSX.Element => {
  const [query, setQuery] = useState("")
  const [state, setState] = useState<LoadState>({ kind: "idle" })
  /** Optimistic per-row pending / error state keyed by envKey. */
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set())

  const load = useCallback(
    (signal?: AbortSignal): void => {
      if (endpoint === null) {
        setState({ kind: "error", message: "Not connected to the daemon yet." })
        return
      }
      setState({ kind: "loading" })
      fetchKnobs(endpoint, signal)
        .then((data) => {
          if (signal?.aborted === true) return
          setState({ kind: "ready", data })
        })
        .catch((error: unknown) => {
          if ((error as { name?: string } | null)?.name === "AbortError") return
          setState({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          })
        })
    },
    [endpoint],
  )

  useEffect(() => {
    const ctrl = new AbortController()
    load(ctrl.signal)
    return () => {
      ctrl.abort()
    }
  }, [load])

  // Escape closes the panel.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") {
        ev.preventDefault()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => {
      window.removeEventListener("keydown", onKey, true)
    }
  }, [onClose])

  const toggleKnob = useCallback(
    async (knob: KnobEntry, next: boolean): Promise<void> => {
      if (endpoint === null) return
      setPendingKeys((prev) => new Set(prev).add(knob.envKey))
      setRowErrors((prev) => {
        const { [knob.envKey]: _omit, ...rest } = prev
        return rest
      })
      // QUANTA_* flag convention: "1" enables; clearing (null) reverts to
      // the built-in default (off for these flags).
      const result = await postKnobValue(endpoint, knob.envKey, next ? "1" : null)
      setPendingKeys((prev) => {
        const nextSet = new Set(prev)
        nextSet.delete(knob.envKey)
        return nextSet
      })
      if (!result.ok) {
        setRowErrors((prev) => ({
          ...prev,
          [knob.envKey]: result.error ?? "write failed",
        }))
        return
      }
      // Re-fetch so value/source/isDefault reflect the new state truthfully
      // rather than guessing optimistically.
      load()
    },
    [endpoint, load],
  )

  const filteredGroups = useMemo(
    () => (state.kind === "ready" ? filterKnobGroups(state.data.groups, query) : []),
    [state, query],
  )
  const visibleCount = useMemo(
    () => filteredGroups.reduce((n, g) => n + g.knobs.length, 0),
    [filteredGroups],
  )

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings — runtime knobs"
      data-testid="knobs-panel"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 sm:p-8"
      onClick={(ev) => {
        // Backdrop click closes; clicks inside the card don't bubble here.
        if (ev.target === ev.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-surface-overlay shadow-2xl">
        {/* Header */}
        <header className="flex items-center justify-between gap-3 border-b border-line-subtle px-4 py-3">
          <div>
            <h2 className="text-sm font-medium text-ink">Settings · Knobs</h2>
            <p className="mt-0.5 text-[11px] text-ink-tertiary">
              {state.kind === "ready"
                ? `${state.data.total} knob${state.data.total === 1 ? "" : "s"} · showing ${visibleCount}`
                : "Runtime configuration manifest"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            title="Close (Esc)"
            className="rounded-md p-1.5 text-ink-tertiary transition hover:bg-black/[0.05] hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
          >
            <CloseIcon />
          </button>
        </header>

        {/* Search */}
        <div className="border-b border-line-subtle px-4 py-2">
          <input
            type="text"
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
            placeholder="Filter by key, description, or group…"
            aria-label="Filter knobs"
            className="w-full rounded-lg border border-line bg-surface-input px-3 py-1.5 text-xs text-ink placeholder:text-ink-faint outline-none focus:border-accent/50"
          />
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {state.kind === "loading" || state.kind === "idle" ? (
            <p className="py-8 text-center text-xs text-ink-tertiary" data-testid="knobs-loading">
              Loading knobs…
            </p>
          ) : state.kind === "error" ? (
            <div
              className="rounded-lg border border-err/40 bg-err/10 p-3 text-xs text-ink"
              data-testid="knobs-error"
            >
              <p className="font-medium text-err">Failed to load knobs.</p>
              <p className="mt-1 text-ink-secondary">{state.message}</p>
              <button
                type="button"
                onClick={() => load()}
                className="mt-2 rounded-md border border-line px-2 py-0.5 text-[11px] text-ink hover:bg-black/[0.05]"
              >
                Retry
              </button>
            </div>
          ) : filteredGroups.length === 0 ? (
            <p className="py-8 text-center text-xs text-ink-tertiary" data-testid="knobs-empty">
              {state.data.groups.length === 0
                ? "No knobs reported by the daemon."
                : `No knobs match “${query}”.`}
            </p>
          ) : (
            <div className="space-y-4">
              {filteredGroups.map((group) => (
                <section key={group.group} data-testid={`knobs-group-${group.group}`}>
                  <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-tertiary">
                    {group.group}
                  </h3>
                  <ul className="space-y-1.5">
                    {group.knobs.map((knob) => {
                      const rowError = rowErrors[knob.envKey]
                      return (
                      <KnobRow
                        key={knob.envKey}
                        knob={knob}
                        pending={pendingKeys.has(knob.envKey)}
                        {...(rowError !== undefined ? { error: rowError } : {})}
                        onToggle={toggleKnob}
                      />
                      )
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Row                                                                 */
/* ------------------------------------------------------------------ */

interface KnobRowProps {
  readonly knob: KnobEntry
  readonly pending: boolean
  readonly error?: string
  readonly onToggle: (knob: KnobEntry, next: boolean) => void | Promise<void>
}

const SOURCE_TONE: Record<string, string> = {
  env: "bg-ok/15 text-ok",
  session: "bg-accent/20 text-accent",
  default: "bg-black/[0.05] text-ink-tertiary",
}

const KnobRow = memo(({ knob, pending, error, onToggle }: KnobRowProps): JSX.Element => {
  const toggleable = isToggleableBool(knob)
  const sourceTone = SOURCE_TONE[knob.source] ?? SOURCE_TONE.default
  return (
    <li
      className="rounded-lg px-2.5 py-2 transition hover:bg-black/[0.05]"
      data-testid={`knob-row-${knob.envKey}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <code className="font-mono text-xs font-medium text-accent">{knob.envKey}</code>
            {knob.home.length > 0 ? (
              <span className="rounded bg-black/[0.05] px-1 py-0.5 text-[9px] uppercase tracking-wide text-ink-tertiary">
                {knob.home}
              </span>
            ) : null}
          </div>
          {knob.describe.length > 0 ? (
            <p className="mt-0.5 break-words text-[11px] text-ink-secondary">{knob.describe}</p>
          ) : null}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px]">
            <span className="text-ink-tertiary">
              value:{" "}
              <span className="font-mono text-ink-secondary">{displayKnobValue(knob)}</span>
            </span>
            <span
              className={cx(
                "rounded-full px-1.5 py-0.5 font-medium uppercase tracking-wide",
                sourceTone,
              )}
            >
              {knob.source}
            </span>
            <span className="text-ink-faint">({knob.kind})</span>
          </div>
          {error !== undefined ? (
            <p className="mt-1 text-[10px] text-err" data-testid={`knob-error-${knob.envKey}`}>
              {error}
            </p>
          ) : null}
        </div>

        {/* Control */}
        <div className="shrink-0 pt-0.5">
          {toggleable ? (
            <Toggle
              on={knobBoolValue(knob)}
              pending={pending}
              label={knob.envKey}
              onChange={(next) => {
                void onToggle(knob, next)
              }}
            />
          ) : (
            <span
              className="rounded bg-black/[0.05] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-ink-tertiary"
              title={
                knob.hotToggleable
                  ? "Not in the daemon's /config write allowlist"
                  : "Read-only knob"
              }
            >
              read-only
            </span>
          )}
        </div>
      </div>
    </li>
  )
})

const Toggle = ({
  on,
  pending,
  label,
  onChange,
}: {
  on: boolean
  pending: boolean
  label: string
  onChange: (next: boolean) => void
}): JSX.Element => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-label={`Toggle ${label}`}
    disabled={pending}
    onClick={() => onChange(!on)}
    className={cx(
      "relative inline-flex h-5 w-9 items-center rounded-full transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50",
      on ? "bg-accent" : "bg-line-strong",
      pending ? "cursor-wait opacity-60" : "cursor-pointer",
    )}
  >
    <span
      className={cx(
        "inline-block h-3.5 w-3.5 transform rounded-full bg-white transition",
        on ? "translate-x-4" : "translate-x-1",
      )}
    />
  </button>
)

const CloseIcon = (): JSX.Element => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="size-4"
  >
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)
