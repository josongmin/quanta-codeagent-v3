import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { cx } from "../lib/classnames"
import type { ContextUsageMessage } from "../types/protocol"
import { renderContextGauge } from "./slash-context-gauge"

/**
 * One entry in the slash-command catalogue. Client-side only for v1 — the
 * server-side `/<cmd>` slash protocol is out of scope; these commands are
 * affordances over local state (clear transcript, focus input, etc.) and
 * over the daemon's well-known facets (image attach, status snapshot).
 *
 * Adding a server-side command later means swapping `action` for a
 * `serverCommand` discriminant — the palette itself stays the same.
 */
export interface SlashCommand {
  /** Canonical slug — `/<slug>`. Lowercase, hyphenated. */
  readonly slug: string
  /** One-line description shown in the palette row. */
  readonly description: string
  /** Optional alias matched as a prefix in addition to `slug`. */
  readonly aliases?: readonly string[]
  /**
   * Invoked when the user accepts this row (Tab / Enter). Receives the
   * current draft minus the leading `/<query>` so handlers can splice in a
   * replacement; return value is the next draft (empty string clears).
   */
  readonly action: (rest: string) => string | Promise<string>
}

export interface SlashPaletteProps {
  /** Current draft input. Used to detect the leading `/` and filter rows. */
  readonly draft: string
  /** Closed catalogue. The host page assembles this so wiring stays local. */
  readonly commands: readonly SlashCommand[]
  /** Called when a command is accepted — return value replaces the draft. */
  readonly onAccept: (nextDraft: string) => void
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

/**
 * Headless-ish palette: render a floating list above the input bar when the
 * draft begins with `/`. The host page wires `onAccept` to its `setDraft`.
 *
 * Keyboard nav: ↑/↓ to move, Tab/Enter to accept, Escape to dismiss. The
 * host textarea's `onKeyDown` should forward those keys via
 * `handleKeyboardEvent` so the palette captures them BEFORE submission.
 */
export const SlashPalette = ({
  draft,
  commands,
  onAccept,
  onDismiss,
}: SlashPaletteProps): JSX.Element | null => {
  const [activeIdx, setActiveIdx] = useState(0)
  const open = isSlashMode(draft)
  const { slug, rest } = useMemo(() => splitDraft(draft), [draft])

  const filtered = useMemo(
    () => commands.filter((c) => matchesQuery(c, slug)),
    [commands, slug],
  )

  useEffect(() => {
    // Clamp the active index whenever the filter list shrinks.
    if (activeIdx >= filtered.length) setActiveIdx(Math.max(0, filtered.length - 1))
  }, [filtered.length, activeIdx])

  if (!open || filtered.length === 0) return null

  const accept = async (cmd: SlashCommand): Promise<void> => {
    const next = await cmd.action(rest)
    onAccept(next)
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
            void accept(cmd)
          }}
          className={cx(
            "flex w-full items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-black/[0.05]",
            idx === activeIdx && "bg-black/[0.05]",
          )}
        >
          <span className="font-mono text-sm font-medium text-ink">/{cmd.slug}</span>
          <span className="truncate text-xs text-ink-tertiary">
            {cmd.description}
          </span>
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

/** Hidden hook that the host's textarea calls via ref to forward key events
 *  into the palette without giving up textarea focus. */
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
  accept: (cmd: SlashCommand) => Promise<void>
  onDismiss: () => void
}): null => {
  // Pure side-effect: bind a single keyup listener for the lifetime of the
  // palette so ↑/↓/Tab/Enter/Esc work without intercepting normal typing.
  const handlerRef = useRef<((ev: KeyboardEvent) => void) | null>(null)
  handlerRef.current = (ev) => {
    if (filtered.length === 0) return
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault()
        setActiveIdx((activeIdx + 1) % filtered.length)
        return
      case "ArrowUp":
        ev.preventDefault()
        setActiveIdx((activeIdx - 1 + filtered.length) % filtered.length)
        return
      case "Tab":
      case "Enter": {
        const cmd = filtered[activeIdx]
        if (cmd === undefined) return
        ev.preventDefault()
        void accept(cmd)
        return
      }
      case "Escape":
        ev.preventDefault()
        onDismiss()
        return
      default:
        return
    }
  }
  useEffect(() => {
    const listener = (ev: globalThis.KeyboardEvent): void => {
      const h = handlerRef.current
      if (h === null) return
      h(ev as unknown as KeyboardEvent)
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
 * muscle memory carries over. Three classes:
 *
 *   1. **client-only** (clear/help) — handled entirely in the React app.
 *   2. **prefill** — palette inserts `/<cmd> ` into the draft and the user
 *      presses Enter; the daemon forwards the raw text to its slash router
 *      (server-side router lives outside this slice — when absent the LLM
 *      sees the raw text, which is the same fallback the CLI uses today).
 *   3. **deferred** — surfaced for discoverability; action is a no-op until
 *      the corresponding daemon/server hook lands.
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
  // Helper that returns the draft prefilled with `/<cmd> ` so the user can
  // type args + hit Enter. The daemon receives `input.append` with that
  // text and routes (server-side or LLM).
  const prefill = (slug: string) => (rest: string): string =>
    rest.length > 0 ? `/${slug} ${rest}` : `/${slug} `

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
      action: () => {
        deps.clearTranscript()
        return ""
      },
    },
    {
      slug: "image",
      aliases: ["img", "i"],
      description: "Attach an image to the next turn (paste or use Image button)",
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
      action: (_rest) => {
        deps.appendClientMessage("system", helpLines())
        return ""
      },
    },
    {
      slug: "status",
      aliases: ["s"],
      description: "Session / connection / model status",
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
      action: clientSystem(
        (c) =>
          `Identity mode: ${c.identityMode ?? "(default — set QUANTA_IDENTITY=1 to enable)"}`,
      ),
    },
    {
      slug: "profile",
      description: "Show current tool profile",
      action: clientSystem(
        (c) => `Tool profile: ${c.toolProfile ?? "(default)"}`,
      ),
    },
    {
      slug: "context",
      description: "Show live segmented context-window usage (with reasoning split)",
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
      action: clientSystem(
        (c) =>
          [
            `session id:      ${c.sessionId ?? "(not learned)"}`,
            `permission mode: ${c.permissionMode ?? "(unknown)"}`,
            `identity mode:   ${c.identityMode ?? "(default)"}`,
            `tool profile:    ${c.toolProfile ?? "(default)"}`,
          ].join("\n"),
      ),
    },
    // Server-routed (mirrors CLI BUILTINS) ──────────────────────────
    { slug: "effort",        description: "Show / set reasoning effort tier",          action: prefill("effort") },
    { slug: "plan",          description: "Show / edit the current plan",              action: prefill("plan") },
    { slug: "state",         description: "Inspect agent + session state",             action: prefill("state") },
    { slug: "working-state", description: "Working-state panel (active files / tools)", action: prefill("working-state") },
    { slug: "branches",      description: "List speculative branch-search results",    action: prefill("branches") },
    { slug: "focus-chain",   description: "Show / configure focus-chain todo reinject", action: prefill("focus-chain") },
    { slug: "skills",        description: "List available skills",                     action: prefill("skills") },
    { slug: "reload-skills", description: "Reload skills from disk",                   action: prefill("reload-skills") },
    { slug: "snooze",        description: "Snooze background tasks",                   action: prefill("snooze") },
    { slug: "resume",        description: "Resume snoozed background tasks",           action: prefill("resume") },
    { slug: "wait",          description: "Wait for background tasks to settle",       action: prefill("wait") },
    { slug: "navigate",      description: "Navigate session / transcript",             action: prefill("navigate") },
    { slug: "color",         description: "Set terminal color scheme",                 action: prefill("color") },
    { slug: "debug",         description: "Toggle debug instrumentation",              action: prefill("debug") },
    { slug: "memory",        description: "Memory inspector (env-gated)",              action: prefill("memory") },
    { slug: "mcp",           description: "MCP server status / config",                action: prefill("mcp") },
    { slug: "rewind",        description: "Rewind conversation (env-gated)",           action: prefill("rewind") },
    { slug: "rewind-tool",   description: "Rewind a single tool call",                 action: prefill("rewind-tool") },
    { slug: "rewind-conv",   description: "Rewind to a previous conversation point",   action: prefill("rewind-conv") },
    { slug: "fork",          description: "Fork conversation (env-gated)",             action: prefill("fork") },
    {
      slug: "knobs",
      aliases: ["settings", "config"],
      description: "Open the Settings panel — inspect / tune runtime knobs",
      action: () => {
        deps.openKnobsPanel()
        return ""
      },
    },
    { slug: "permission",    description: "Permission store explainer",                action: prefill("permission") },
    {
      slug: "capabilities",
      aliases: ["caps"],
      description: "Show capability layer — gates + per-surface exposure",
      action: prefill("capabilities"),
    },
  ]
  allCommands.push(...commands)
  return commands
}
