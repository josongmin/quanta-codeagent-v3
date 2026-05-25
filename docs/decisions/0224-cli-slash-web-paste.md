# ADR-0224 — CLI `/web` + `/paste` (text-inbox absorption)

- **Status**: Accepted
- **Date**: 2026-05-25
- **Slice**: `src/apps/cli`
- **Sources**: Aider `/web` (URL fetch + HTML→MD) + Aider `/paste`
  (clipboard text/image/path auto-detect)
- **Sibling ADRs**: 0148 (web-search/web-fetch tools), 0186 (turndown
  HTML→MD), 0126/0132/0146 (image tools), 0225 (mid-edit via $EDITOR)

## Context

Aider ships two convergence-tested REPL primitives:

- **`/web <url>`** — fetch a URL, convert HTML→markdown, attach the body
  as context for the next turn. Reduces "open browser → copy → paste"
  friction by ~90% for documentation-grounded tasks.
- **`/paste`** — pull the system clipboard into the next message. Auto-
  detects image vs. text; when the text resolves to an absolute file
  path, reads the file body instead. Mirrors Claude Desktop's `cmd+v`
  paste-as-attachment UX without requiring a GUI.

We already ship the `web_fetch` tool (ADR-0148) and `turndown`
(ADR-0186), so `/web` is a thin slash UX on top of an existing
capability. We ship `/image add <path>` (ADR-0083) for image
attachments, so `/paste` complements it: text/file paste goes through
the new inbox; image paste advises the user to use `/image add`.

## Decision

Add `webCmd` (`src/apps/cli/web-cmd.ts`) and `pasteCmd`
(`src/apps/cli/paste-cmd.ts`) to the BUILTINS registry. Introduce a
sibling-to-`image-queue` single-shot text inbox in
`src/apps/cli/text-inbox.ts` (`TextInbox` port) the surface drains on
each `PromptSource.next()` to prepend out-of-band content to the user's
literal text.

### `/web` contract
- `/web <url> [--no-markdown] [--max-bytes=N]`.
- Delegates to `webFetchTool` (ADR-0148): SSRF deny + protocol gate +
  size cap + binary-content reject all live in the tool. The slash is a
  thin argument parser + delivery shim.
- Inbox wired ⇒ queued; inbox absent ⇒ printed inline (never silently
  swallowed — the user paid for the fetch).
- `--no-markdown` strips the tool's 4-line header so the user gets raw
  bytes when they explicitly opt in.
- 60s hardcoded ceiling via `AbortController` (no surface state needed).

### `/paste` contract
- Platform-dispatched clipboard reader:
  - macOS: probe `osascript … PNGf` → image hint; else `pbpaste`.
  - Linux: `wl-paste --no-newline` (Wayland) → `xclip` (X11).
  - Windows: `powershell.exe Get-Clipboard` (best-effort; Windows is not
    Phase 1).
- Closed `ClipboardContent` discriminated union (`text` / `image` /
  `empty` / `no_backend` / `error`) — adding a kind is a compile-error
  at every consumer.
- Path-attachment branch: clipboard text that's an absolute single-line
  path AND `stat().isFile === true` AND `size <= 1MB` ⇒ file body is
  attached, labeled with the path. Multi-line text + relative paths +
  oversize all fall through to the literal-text branch (or typed error).
- Image clipboard ⇒ explicit "/image add <path>" advisory; never raw
  base64 (Aider's posture).

### Text inbox semantics
- Single-shot drain (mirrors `ImageQueue.drain()` — same shape).
- Default cap 8 entries; over-cap ⇒ typed error, not silent drop.
- `renderInboxPreamble(entries)` returns the stable `[/web URL]\n<body>`
  preamble the surface prepends. Empty inbox ⇒ empty string (no branching).

### Slice posture
- `web-cmd.ts` imports `@/tool/web` + the local `./text-inbox` +
  `./slash-commands`. Nothing from `@/agent`, `@/permission`, `@/storage`.
- `paste-cmd.ts` imports `node:*` only + the local `./text-inbox`. Pure
  surface module.
- Both declare a `SlashContext` extension via `declare module
  "./slash-commands"` (no central-file edit).

### Default-OFF posture
- `webCmd` / `pasteCmd` are always REGISTERED. The text inbox is the
  optional wire. Without it, `/web` and `/paste` print the body to
  stdout — degraded, not broken.
- `webFetcher` + `clipboardReader` + `clipboardFs` are all injectable
  test seams that default to production impls.

## Consequences

- **+** Two more vendor-validated REPL primitives shipped without
  duplicating any web-fetch / clipboard logic.
- **+** The text-inbox port unifies a pattern (`/web`, `/paste`, future
  drag-drop on Web/Tauri) that would otherwise duplicate four times.
- **−** Two more BUILTINS entries (~50 → 50+4) — flat enumeration; not
  a discoverability cliff.
- **−** macOS image-clipboard ⇒ advisory message instead of inline
  attachment. Deliberate — image bytes belong on the `/image` queue
  (typed `ImageBlock` carrier with the 20MB cap from ADR-0083).

## Test plan

- `tests/unit/cli/web-cmd-hellgate.test.ts` — 12 cases: missing URL /
  unknown flag / extra positional / invalid --max-bytes / http:// rejection
  / SSRF / 4xx / happy-path with inbox / happy-path without inbox /
  --no-markdown strips header / inbox over-cap / parser order-independence.
- `tests/unit/cli/paste-cmd-hellgate.test.ts` — 12 cases: no_backend /
  error / empty / image hint / text-with-inbox / text-without-inbox /
  abs file path read / abs path not a file / oversize file / relative
  path treated as text / extra argument / probePath rejects multi-line.

All 24 cases green. tsc 0 / biome 0 on the slice.

## Negative invariants

- `/web` MUST NOT bypass the `web_fetch` tool's SSRF deny + size cap.
  No alternate fetch path.
- `/paste` MUST NOT auto-attach image bytes to a text message. Image
  clipboards advise `/image add <path>` and exit 1.
- The text inbox MUST NOT persist across processes or sessions. Single-
  shot per turn, lost on REPL exit.
- The inbox preamble MUST NOT be model-callable (the tag `[/web …]` is
  decorative; we never let the model emit such a tag and have it
  injected into the next turn).
