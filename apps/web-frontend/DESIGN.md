# quanta web — Codex-aligned design contract (jun-8)

Goal: make the web frontend read like **Codex / ChatGPT desktop** — prose-first, token-driven, airy, dark. Apply these rules consistently across all components. Dark-first only (no light mode yet).

## Tokens (tailwind.config.js — USE THESE, not raw `neutral-*`)
- **surface**: `surface`(app bg #0f0f12) · `surface-raised`(cards/sidebar #17171b) · `surface-overlay`(dropdowns/menus #1e1e23) · `surface-input`(composer/inputs #202026)
- **line**(hairlines): `line`(#2a2a30) · `line-subtle`(#1f1f24) · `line-strong`(#3a3a43)
- **ink**(text ramp): `ink`(primary #ededee) · `ink-secondary`(labels #9b9ba4) · `ink-tertiary`(captions #6a6a73) · `ink-faint`(placeholder/disabled #50505a)
- **accent**: `accent`(#7aa2f7) · `accent-muted` · `accent-fg`(on-accent text)
- **semantic**: `ok`(green) · `warn`(amber) · `err`(red) · `info`(blue)

## Typography (the #1 "구려" fix — STOP using mono for prose)
- **Message body = PROSE**: `font-sans text-chat` (15px/1.6) `text-ink`. Assistant text `text-ink`; user text `text-ink` on a subtle `bg-surface-raised` block (see Messages).
- **mono ONLY for**: code blocks, inline code, ids, file paths, token counts, env keys, diffs.
- **labels/captions**: `text-xs text-ink-secondary` (optionally `tracking-wide uppercase` for section labels).
- **section headers**: `text-sm font-medium text-ink`.

## Messages (full-width, NOT max-w-80% left/right bubbles)
- Each turn is **full-width row**, `px-4 py-3`, separated by generous vertical rhythm (`gap` between turns ~`space-y-1` rows but each row breathes).
- **Role distinction by treatment, not bubbles**:
  - assistant: plain on app bg, `text-ink`, a tiny role label `text-[11px] text-ink-tertiary` ("quanta").
  - user: wrapped in `rounded-2xl bg-surface-raised border border-line-subtle px-4 py-3` (a soft block), `text-ink`.
  - system/error: `err`/`warn` tinted left-border + muted text.
- **Hover actions** (copy/retry/edit): `opacity-0 group-hover:opacity-100`, icon buttons `rounded-md text-ink-tertiary hover:bg-white/5 hover:text-ink size-7`.
- **Tool calls / reasoning**: collapsible — summary row `text-ink-secondary` with a chevron, expanded body `text-ink-tertiary text-sm`. Reasoning gets a subtle shimmer while streaming.
- code blocks: `rounded-lg border border-line bg-surface-raised`, mono, keep existing syntax highlighting (just swap container colors to tokens).

## Composer (rounded multiline + toolbar chrome)
- Outer: `rounded-2xl border border-line bg-surface-input` (focus-within: `border-accent/50`). Generous: `px-3 py-2.5`, textarea `min-h-[52px]` auto-grow, `resize-none bg-transparent text-ink placeholder:text-ink-faint`.
- **Bottom toolbar row** inside the composer: left = attach/image + slash hint (icon buttons), right = **send** = `rounded-full bg-accent text-accent-fg size-8` (or a clean arrow); stop = `err` while running.
- Slash palette / @-mention: `rounded-xl bg-surface-overlay border border-line shadow-lg`, rows `rounded-lg px-2.5 py-1.5 hover:bg-white/5`, selected `bg-white/5`.

## Buttons
- **primary**: `rounded-full bg-accent text-accent-fg px-3 py-1.5 text-sm font-medium hover:bg-accent-muted`.
- **secondary**: `rounded-lg border border-line text-ink px-3 py-1.5 text-sm hover:bg-white/5`.
- **icon**: `rounded-md p-1.5 text-ink-tertiary hover:bg-white/5 hover:text-ink`.
- focus: `focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50`.

## Cards / panels / pills
- card: `rounded-xl bg-surface-raised border border-line-subtle p-3`.
- pill/badge: `rounded-full border border-line px-2 py-0.5 text-xs text-ink-secondary` (status dot + label).
- list row: `rounded-lg px-2.5 py-2 hover:bg-white/5`.

## Layout / shell
- app: `bg-surface text-ink`. header: thin `border-b border-line-subtle px-4 py-2`, status grouped with `gap-2`, not crammed.
- right sidebar (observability): `bg-surface-raised border-l border-line-subtle`, section headers `text-xs uppercase tracking-wide text-ink-tertiary`, cards spaced `space-y-3`, collapsible affordances clear.
- spacing: prefer `px-4 py-3` and `gap-2/3` over the current cramped `px-2 py-1`.

## Rules
- NO new dependencies. Valid Tailwind only (these tokens exist now). Keep it building — run `bun run build` (or vite build) / typecheck after.
- Keep all existing behavior/props/wiring; this is a **restyle**, not a rewrite. Don't touch WS/data logic.
- Don't touch other clusters' component files (stay in your assigned set).
