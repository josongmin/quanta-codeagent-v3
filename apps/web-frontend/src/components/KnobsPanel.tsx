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
 * Styling mirrors `ObservabilityPane` / `SlashPalette` (neutral-900/950
 * surfaces, accent for keys, uppercase-tracking section headers) — no new
 * design system.
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 sm:p-8"
      onClick={(ev) => {
        // Backdrop click closes; clicks inside the card don't bubble here.
        if (ev.target === ev.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl">
        {/* Header */}
        <header className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-neutral-100">Settings · Knobs</h2>
            <p className="mt-0.5 text-[11px] text-neutral-500">
              {state.kind === "ready"
                ? `${state.data.total} knob${state.data.total === 1 ? "" : "s"} · showing ${visibleCount}`
                : "Runtime configuration manifest"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          >
            Esc ✕
          </button>
        </header>

        {/* Search */}
        <div className="border-b border-neutral-800 px-4 py-2">
          <input
            type="text"
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
            placeholder="Filter by key, description, or group…"
            aria-label="Filter knobs"
            className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-100 placeholder-neutral-600 outline-none focus:border-accent-muted"
          />
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {state.kind === "loading" || state.kind === "idle" ? (
            <p className="py-8 text-center text-xs text-neutral-500" data-testid="knobs-loading">
              Loading knobs…
            </p>
          ) : state.kind === "error" ? (
            <div
              className="rounded-md border border-red-800 bg-red-950 p-3 text-xs text-red-200"
              data-testid="knobs-error"
            >
              <p className="font-medium">Failed to load knobs.</p>
              <p className="mt-1 text-red-300/80">{state.message}</p>
              <button
                type="button"
                onClick={() => load()}
                className="mt-2 rounded bg-red-900 px-2 py-0.5 text-[11px] text-red-100 hover:bg-red-800"
              >
                Retry
              </button>
            </div>
          ) : filteredGroups.length === 0 ? (
            <p className="py-8 text-center text-xs text-neutral-500" data-testid="knobs-empty">
              {state.data.groups.length === 0
                ? "No knobs reported by the daemon."
                : `No knobs match “${query}”.`}
            </p>
          ) : (
            <div className="space-y-4">
              {filteredGroups.map((group) => (
                <section key={group.group} data-testid={`knobs-group-${group.group}`}>
                  <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
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
  env: "bg-emerald-900 text-emerald-100",
  session: "bg-accent/20 text-accent",
  default: "bg-neutral-800 text-neutral-400",
}

const KnobRow = memo(({ knob, pending, error, onToggle }: KnobRowProps): JSX.Element => {
  const toggleable = isToggleableBool(knob)
  const sourceTone = SOURCE_TONE[knob.source] ?? SOURCE_TONE.default
  return (
    <li
      className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2"
      data-testid={`knob-row-${knob.envKey}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <code className="font-mono text-xs font-medium text-accent">{knob.envKey}</code>
            {knob.home.length > 0 ? (
              <span className="rounded bg-neutral-800 px-1 py-0.5 text-[9px] uppercase tracking-wide text-neutral-500">
                {knob.home}
              </span>
            ) : null}
          </div>
          {knob.describe.length > 0 ? (
            <p className="mt-0.5 break-words text-[11px] text-neutral-400">{knob.describe}</p>
          ) : null}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px]">
            <span className="text-neutral-500">
              value:{" "}
              <span className="font-mono text-neutral-300">{displayKnobValue(knob)}</span>
            </span>
            <span
              className={cx(
                "rounded-full px-1.5 py-0.5 font-medium uppercase tracking-wide",
                sourceTone,
              )}
            >
              {knob.source}
            </span>
            <span className="text-neutral-600">({knob.kind})</span>
          </div>
          {error !== undefined ? (
            <p className="mt-1 text-[10px] text-red-400" data-testid={`knob-error-${knob.envKey}`}>
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
              className="rounded bg-neutral-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-neutral-500"
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
      "relative inline-flex h-5 w-9 items-center rounded-full transition",
      on ? "bg-accent" : "bg-neutral-700",
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
