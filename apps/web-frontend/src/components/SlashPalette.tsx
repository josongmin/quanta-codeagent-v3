import { useEffect, useMemo, useRef, useState } from "react"
import { cx } from "../lib/classnames"
import type { ContextUsageMessage } from "../types/protocol"
import { renderContextGauge } from "./slash-context-gauge"

/**
 * One entry in the slash-command catalogue — a TYPED contract (WS-F move 1).
 *
 * Every entry declares an explicit `kind` and the host routes an accept BY
 * KIND (see `slash-routing.ts`), so "the action ran but its result was
 * silently discarded" is unrepresentable:
 *
 *   - `local`   — runs `action(rest)` and the host APPLIES the returned draft
 *                 (a client-side effect, an HTTP shim, or a usage-correction
 *                 prefill like `/effort ` on bad args).
 *   - `readout` — same execution shape as `local`, but the action's effect is
 *                 specifically a `GET /readout/:name` fetch whose body lands
 *                 in the transcript (see `slash-readout.ts`).
 *   - `server-slash` — no local action; the host SENDS `/<slug> <rest>` to the
 *                 session as a turn (the daemon/LLM sees the slash line) and
 *                 the turn echo renders it in the transcript. No entry uses
 *                 this today (the web daemon has no slash router yet); the
 *                 kind exists so the ack/protocol wave can adopt it without
 *                 reshaping the palette.
 *   - `unwired` — surfaced for discoverability only. Accept KEEPS the draft
 *                 and shows the inline `hint` — never a silent clear.
 */
export type SlashCommandKind = "local" | "server-slash" | "readout" | "unwired"

interface SlashCommandBase {
  /** Canonical slug — `/<slug>`. Lowercase, hyphenated. */
  readonly slug: string
  /** One-line description shown in the palette row. */
  readonly description: string
  /** Optional alias matched as a prefix in addition to `slug`. */
  readonly aliases?: readonly string[]
}

export type SlashCommand =
  | (SlashCommandBase & {
      readonly kind: "local" | "readout"
      /**
       * Invoked on accept with the draft minus the leading `/<slug> `. The
       * return value is the NEXT DRAFT (empty string clears) — the host is
       * contractually required to apply it (enforced by the palette
       * invariant test).
       */
      readonly action: (rest: string) => string | Promise<string>
    })
  | (SlashCommandBase & { readonly kind: "server-slash" })
  | (SlashCommandBase & {
      readonly kind: "unwired"
      /** Inline explanation shown on accept (the draft is kept). */
      readonly hint: string
    })

export interface SlashPaletteProps {
  /** Current draft input. Used to detect the leading `/` and filter rows. */
  readonly draft: string
  /** Closed catalogue. The host page assembles this so wiring stays local. */
  readonly commands: readonly SlashCommand[]
  /**
   * Called when a row is accepted (Tab / Enter / click). The HOST routes the
   * command by `kind` through `executeSlashCommand` (slash-routing.ts) — the
   * palette itself never runs actions, so there is exactly one execution
   * choke point shared with the composer's submit path.
   */
  readonly onAcceptCommand: (cmd: SlashCommand, rest: string) => void
  /** Called on Escape — host clears its `open` gate. */
  readonly onDismiss: () => void
}

/** Detect whether the current draft is in slash-command mode. */
export const isSlashMode = (draft: string): boolean =>
  draft.startsWith("/") && !draft.slice(1).includes("\n")

export const splitDraft = (draft: string): { slug: string; rest: string } => {
  const trimmed = draft.replace(/^\//, "")
  const spaceIdx = trimmed.indexOf(" ")
  if (spaceIdx === -1) {
    return { slug: trimmed.toLowerCase(), rest: "" }
  }
  return {
    slug: trimmed.slice(0, spaceIdx).toLowerCase(),
    rest: trimmed.slice(spaceIdx + 1),
  }
}

const matchesQuery = (cmd: SlashCommand, query: string): boolean => {
  if (cmd.slug.startsWith(query)) return true
  if (cmd.aliases === undefined) return false
  return cmd.aliases.some((a) => a.toLowerCase().startsWith(query))
}

/* ------------------------------------------------------------------ */
/* Pure key routing (UUX-5-26)                                         */
/* ------------------------------------------------------------------ */

export type PaletteKeyAction =
  | { readonly type: "move"; readonly nextIndex: number }
  | { readonly type: "accept" }
  | { readonly type: "dismiss" }
  | { readonly type: "none" }

/** Minimal keyboard-event view so the routing is testable without a DOM. */
export interface PaletteKeyEventLike {
  readonly key: string
  /** True while an IME composition is in flight (Korean/Japanese/Chinese). */
  readonly isComposing?: boolean
  /** Legacy IME signal (Safari/WKWebView emit keyCode 229 mid-composition). */
  readonly keyCode?: number
}

/**
 * Route one palette keystroke. IME guard first: an Enter that merely
 * finalizes a composition (`isComposing` / key "Process" / keyCode 229) must
 * NOT accept a row — pre-fix, composing Korean and hitting Enter fired the
 * active command.
 */
export const resolvePaletteKey = (
  ev: PaletteKeyEventLike,
  activeIdx: number,
  count: number,
): PaletteKeyAction => {
  if (count === 0) return { type: "none" }
  if (ev.isComposing === true || ev.key === "Process" || ev.keyCode === 229) {
    return { type: "none" }
  }
  switch (ev.key) {
    case "ArrowDown":
      return { type: "move", nextIndex: (activeIdx + 1) % count }
    case "ArrowUp":
      return { type: "move", nextIndex: (activeIdx - 1 + count) % count }
    case "Tab":
    case "Enter":
      return { type: "accept" }
    case "Escape":
      return { type: "dismiss" }
    default:
      return { type: "none" }
  }
}

/**
 * Headless-ish palette: render a floating list above the input bar when the
 * draft begins with `/`. Keyboard nav: ↑/↓ to move, Tab/Enter to accept,
 * Escape to dismiss — captured on `window` keydown so the textarea keeps
 * focus. Handled keys stop propagation so the composer's own Enter handler
 * cannot double-execute the accepted command.
 */
export const SlashPalette = ({
  draft,
  commands,
  onAcceptCommand,
  onDismiss,
}: SlashPaletteProps): JSX.Element | null => {
  const [activeIdx, setActiveIdx] = useState(0)
  const open = isSlashMode(draft)
  const { slug, rest } = useMemo(() => splitDraft(draft), [draft])

  const filtered = useMemo(() => commands.filter((c) => matchesQuery(c, slug)), [commands, slug])

  useEffect(() => {
    // Clamp the active index whenever the filter list shrinks.
    if (activeIdx >= filtered.length) setActiveIdx(Math.max(0, filtered.length - 1))
  }, [filtered.length, activeIdx])

  if (!open || filtered.length === 0) return null

  const accept = (cmd: SlashCommand): void => {
    onAcceptCommand(cmd, rest)
  }

  return (
    <div
      role="listbox"
      aria-label="Slash command palette"
      className="mb-2 max-h-56 animate-fade-in overflow-y-auto rounded-xl border border-line bg-surface-overlay p-1 shadow-lg"
    >
      {filtered.map((cmd, idx) => (
        <button
          key={cmd.slug}
          type="button"
          role="option"
          aria-selected={idx === activeIdx}
          onMouseEnter={() => setActiveIdx(idx)}
          onClick={() => {
            accept(cmd)
          }}
          className={cx(
            "flex w-full items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-black/[0.05]",
            idx === activeIdx && "bg-black/[0.05]",
          )}
        >
          <span className="font-mono text-sm font-medium text-ink">/{cmd.slug}</span>
          <span className="truncate text-xs text-ink-tertiary">{cmd.description}</span>
          {cmd.kind === "unwired" ? (
            <span className="ml-auto shrink-0 rounded bg-black/[0.05] px-1 py-0.5 text-[9px] uppercase tracking-wide text-ink-faint">
              cli only
            </span>
          ) : null}
        </button>
      ))}
      <div className="px-2.5 py-1 text-[11px] text-ink-faint">
        ↑/↓ navigate · Tab/Enter accept · Esc dismiss
      </div>
      <PaletteRef
        activeIdx={activeIdx}
        setActiveIdx={setActiveIdx}
        filtered={filtered}
        accept={accept}
        onDismiss={onDismiss}
      />
    </div>
  )
}

/** Hidden hook that binds a window-level keydown listener (capture phase) so
 *  ↑/↓/Tab/Enter/Esc reach the palette without the textarea losing focus. */
const PaletteRef = ({
  activeIdx,
  setActiveIdx,
  filtered,
  accept,
  onDismiss,
}: {
  activeIdx: number
  setActiveIdx: (next: number) => void
  filtered: readonly SlashCommand[]
  accept: (cmd: SlashCommand) => void
  onDismiss: () => void
}): null => {
  const handlerRef = useRef<((ev: globalThis.KeyboardEvent) => void) | null>(null)
  handlerRef.current = (ev) => {
    const action = resolvePaletteKey(ev, activeIdx, filtered.length)
    if (action.type === "none") return
    // Handled: suppress the default AND stop propagation so the composer's
    // Enter handler never sees the same keystroke (a palette accept + a
    // composer submit both resolving the slash used to DOUBLE-EXECUTE it).
    ev.preventDefault()
    ev.stopPropagation()
    switch (action.type) {
      case "move":
        setActiveIdx(action.nextIndex)
        return
      case "accept": {
        const cmd = filtered[activeIdx]
        if (cmd !== undefined) accept(cmd)
        return
      }
      case "dismiss":
        onDismiss()
        return
    }
  }
  useEffect(() => {
    const listener = (ev: globalThis.KeyboardEvent): void => {
      handlerRef.current?.(ev)
    }
    window.addEventListener("keydown", listener, true)
    return () => {
      window.removeEventListener("keydown", listener, true)
    }
  }, [])
  return null
}

/**
 * Default catalogue — mirrors the CLI `BUILTINS` registry (ADR-0306) so
 * muscle memory carries over. Kind classification (WS-F):
 *
 *   - `local`   — resolved entirely client-side (transcript readouts over UI
 *                 state, clear, focus, knobs panel).
 *   - `unwired` — CLI builtins the web daemon has no route for yet. Rendered
 *                 for discoverability; accept keeps the draft + explains.
 *                 (The old behaviour prefilled `/<cmd> ` and the submit path
 *                 silently discarded it — UUX-2-01.)
 *
 * When the daemon connection resolves, `assembleSlashCommands`
 * (slash-catalog.ts) REPLACES the unwired stubs whose slugs have live
 * HTTP-backed implementations (readouts / llm-config / auth).
 */
/** Snapshot of UI state the slash commands need to render their replies.
 *  Each field is a pure value (no callbacks) so the catalogue stays
 *  serialisable and easy to test. */
export interface SlashCommandContext {
  readonly modelSlug: string | null
  readonly connection: { kind: string; detail?: string }
  readonly sessionId: string | null
  readonly sessionStatus: string | null
  readonly permissionMode: string | null
  readonly identityMode: string | null
  readonly toolProfile: string | null
  readonly messageCount: number
  readonly tokenUsage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    costMicroUsd: number
    turns: number
  }
  /** S3 — the latest `context.usage` frame from the canvas channel
   *  (`useContextUsage`). `null` when the channel is OFF / no frame yet ⇒
   *  `/context` falls back to the transcript-count stub. Present ⇒ `/context`
   *  renders the live segmented gauge (with the reasoning-token split). */
  readonly contextUsage: ContextUsageMessage | null
}

/** The inline explanation an `unwired` entry shows on accept. Exported so the
 *  invariant test can assert hints stay non-empty and slug-specific. */
export const unwiredHint = (slug: string): string =>
  `/${slug} isn't wired on the web surface yet — nothing was sent and your draft was kept. Run /${slug} from the quanta CLI.`

export const buildDefaultSlashCommands = (deps: {
  clearTranscript: () => void
  focusImageAttachment: () => void
  /** Append a system / error message to the local transcript. The slash
   *  commands that resolve client-side (`/help`, `/status`, `/usage`, …)
   *  call this so the user sees the answer in the chat list. */
  appendClientMessage: (role: "system" | "error", text: string) => void
  /** Snapshot fetcher — called at action time so each invocation sees the
   *  current state without stale closures. */
  getContext: () => SlashCommandContext
  /** Open the Settings / Knobs panel. Wired by the host (App) which owns the
   *  panel's open state + the daemon endpoint. */
  openKnobsPanel: () => void
}): readonly SlashCommand[] => {
  // CLI builtin with no web route yet: honest `unwired` entry — accept keeps
  // the draft and explains instead of the old silent prefill-discard.
  const unwired = (slug: string, description: string): SlashCommand => ({
    slug,
    description,
    kind: "unwired",
    hint: unwiredHint(slug),
  })

  // Client-resolved command: append a system message and clear the draft.
  const clientSystem =
    (build: (ctx: SlashCommandContext, rest: string) => string) =>
    (rest: string): string => {
      deps.appendClientMessage("system", build(deps.getContext(), rest))
      return ""
    }

  const formatTokens = (n: number): string =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(2)}M`
      : n >= 1_000
        ? `${(n / 1_000).toFixed(1)}k`
        : n.toString()

  const formatCost = (microUsd: number): string => {
    const usd = microUsd / 1_000_000
    if (usd >= 1) return `$${usd.toFixed(2)}`
    if (usd >= 0.01) return `$${usd.toFixed(3)}`
    return `$${usd.toFixed(4)}`
  }

  const allCommands: SlashCommand[] = []
  const helpLines = (): string => {
    const lines = allCommands
      .map(
        (c) =>
          `  /${c.slug.padEnd(15)}  ${c.description}${
            c.aliases !== undefined && c.aliases.length > 0
              ? `  (aliases: ${c.aliases.map((a) => `/${a}`).join(", ")})`
              : ""
          }`,
      )
      .join("\n")
    return `Available slash commands:\n${lines}\n\nKeyboard: ↑/↓ navigate · Tab/Enter accept · Esc dismiss`
  }

  const commands: SlashCommand[] = [
    // Client-only ───────────────────────────────────────────────────
    {
      slug: "clear",
      aliases: ["c", "reset"],
      description: "Clear the visible transcript (local only — session memory intact)",
      kind: "local",
      action: () => {
        deps.clearTranscript()
        return ""
      },
    },
    {
      slug: "image",
      aliases: ["img", "i"],
      description: "Attach an image to the next turn (paste or use Image button)",
      kind: "local",
      action: () => {
        deps.focusImageAttachment()
        return ""
      },
    },
    // Client-resolved (read-only readout — server isn't touched) ──
    {
      slug: "help",
      aliases: ["h", "?"],
      description: "List all slash commands + keyboard shortcuts",
      kind: "local",
      action: (_rest) => {
        deps.appendClientMessage("system", helpLines())
        return ""
      },
    },
    {
      slug: "status",
      aliases: ["s"],
      description: "Session / connection / model status",
      kind: "local",
      action: clientSystem((c) => {
        const parts = [
          `connection: ${c.connection.kind}${c.connection.detail !== undefined ? ` (${c.connection.detail})` : ""}`,
          `model:      ${c.modelSlug ?? "(unknown)"}`,
          `session:    ${c.sessionId ?? "(not yet learned)"}`,
          `status:     ${c.sessionStatus ?? "idle"}`,
          `messages:   ${c.messageCount}`,
        ]
        return `Status\n${parts.map((p) => `  ${p}`).join("\n")}`
      }),
    },
    {
      slug: "usage",
      aliases: ["u"],
      description: "Cumulative token + cost usage this session",
      kind: "local",
      action: clientSystem((c) => {
        const u = c.tokenUsage
        if (u.turns === 0) {
          return "No completed turns yet — token usage will appear after the first response."
        }
        return [
          "Token usage (cumulative)",
          `  turns:      ${u.turns}`,
          `  prompt:     ${formatTokens(u.promptTokens)}`,
          `  completion: ${formatTokens(u.completionTokens)}`,
          `  total:      ${formatTokens(u.totalTokens)}`,
          ...(u.costMicroUsd > 0 ? [`  cost:       ${formatCost(u.costMicroUsd)}`] : []),
        ].join("\n")
      }),
    },
    {
      slug: "cost",
      description: "Cost breakdown (alias of /usage with $-focus)",
      kind: "local",
      action: clientSystem((c) => {
        const u = c.tokenUsage
        if (u.costMicroUsd === 0) {
          return "No cost recorded yet — adapter may not be emitting `costMicroUsd` on `usage` events."
        }
        const usd = u.costMicroUsd / 1_000_000
        const perTurn = u.turns > 0 ? usd / u.turns : 0
        return [
          `Cost: ${formatCost(u.costMicroUsd)} across ${u.turns} turn${u.turns === 1 ? "" : "s"}`,
          `  per-turn avg: ${formatCost(perTurn * 1_000_000)}`,
          `  total tokens: ${formatTokens(u.totalTokens)}`,
        ].join("\n")
      }),
    },
    {
      slug: "identity",
      description: "Show current identity mode",
      kind: "local",
      action: clientSystem(
        (c) => `Identity mode: ${c.identityMode ?? "(default — set QUANTA_IDENTITY=1 to enable)"}`,
      ),
    },
    {
      slug: "profile",
      description: "Show current tool profile",
      kind: "local",
      action: clientSystem((c) => `Tool profile: ${c.toolProfile ?? "(default)"}`),
    },
    {
      slug: "context",
      description: "Show live segmented context-window usage (with reasoning split)",
      kind: "local",
      action: clientSystem((c) => {
        // S3 — live segmented gauge when the canvas `context.usage` frame is
        // present; falls back to the transcript-count stub when the channel is
        // OFF (byte-identical to the pre-S3 behaviour, default-OFF).
        const gauge = renderContextGauge(c.contextUsage)
        if (gauge !== null) return gauge
        return `Messages in transcript: ${c.messageCount}  ·  permission: ${c.permissionMode ?? "(unknown)"}`
      }),
    },
    {
      slug: "session",
      description: "Show session id + permission mode",
      kind: "local",
      action: clientSystem((c) =>
        [
          `session id:      ${c.sessionId ?? "(not learned)"}`,
          `permission mode: ${c.permissionMode ?? "(unknown)"}`,
          `identity mode:   ${c.identityMode ?? "(default)"}`,
          `tool profile:    ${c.toolProfile ?? "(default)"}`,
        ].join("\n"),
      ),
    },
    // CLI builtins with no web route yet (honest `unwired`) ─────────
    unwired("effort", "Show / set reasoning effort tier"),
    unwired("plan", "Show / edit the current plan"),
    unwired("state", "Inspect agent + session state"),
    unwired("working-state", "Working-state panel (active files / tools)"),
    unwired("branches", "List speculative branch-search results"),
    unwired("focus-chain", "Show / configure focus-chain todo reinject"),
    unwired("skills", "List available skills"),
    unwired("reload-skills", "Reload skills from disk"),
    // UUX-4-19 — copy mirrors the CLI registry's describe strings verbatim:
    // /snooze is a NEW-TURN gate (idle-monitor), not a background-task snooze.
    unwired("snooze", "Suspend new turns for a duration (default 5m). e.g. /snooze 10m"),
    unwired("resume", "Cancel an active snooze and resume new turns"),
    unwired("wait", "Wait for background tasks to settle"),
    unwired("navigate", "Navigate session / transcript"),
    unwired("color", "Set terminal color scheme"),
    unwired("debug", "Toggle debug instrumentation"),
    unwired("memory", "Memory inspector (env-gated)"),
    unwired("mcp", "MCP server status / config"),
    unwired("rewind", "Rewind conversation (env-gated)"),
    unwired("rewind-tool", "Rewind a single tool call"),
    unwired("rewind-conv", "Rewind to a previous conversation point"),
    unwired("fork", "Fork conversation (env-gated)"),
    {
      slug: "knobs",
      aliases: ["settings", "config"],
      description: "Open the Settings panel — inspect / tune runtime knobs",
      kind: "local",
      action: () => {
        deps.openKnobsPanel()
        return ""
      },
    },
    unwired("permission", "Permission store explainer"),
    {
      slug: "capabilities",
      aliases: ["caps"],
      description: "Show capability layer — gates + per-surface exposure",
      kind: "unwired",
      hint: unwiredHint("capabilities"),
    },
  ]
  allCommands.push(...commands)
  return commands
}
