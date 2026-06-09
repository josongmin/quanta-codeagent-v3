# Ticket 04 — web: send `control.request` / `thin.command`, render the response

> **REVISED (jun-09 audit)**: was "send `slash.run`, render `slash.result`". Now: send the routed verbs from ticket 02. A `control.response` carrying a **structured `ControlEffect`** renders as a typed widget (and is the seed for Phase-3 native panels); a `thin.result` (the `local` route) renders as text. Hook names below are illustrative — align to the ticket-02 verb shape.

**Phase**: 0 · **Depends**: 02 · **Parallel with**: 03 · **Risk**: low (frontend-only)

## Goal
Convert the web slash palette's **prefill stubs** into real server-side execution via the routed verbs, and render the returned **structured effect** (preferred) or text.

## Current state (the stub)
[apps/web-frontend/src/components/SlashPalette.tsx](../../../apps/web-frontend/src/components/SlashPalette.tsx):
- `prefill(slug)` ([:246](../../../apps/web-frontend/src/components/SlashPalette.tsx#L246)) drops `/<cmd> ` into the draft — does nothing on send.
- The server-routed rows ([:404+](../../../apps/web-frontend/src/components/SlashPalette.tsx#L404)) — `state` / `working-state` / `branches` / `focus-chain` / `skills` / `plan` / `effort` / … — all use `action: prefill(...)`.

## Changes
1. **Hook** `useSlashRun(client, sessionId)` in [apps/web-frontend/src/ws/session-hooks.ts](../../../apps/web-frontend/src/ws/session-hooks.ts) — mirror `useSendApprovalDecision` / `useSendTurn` ([:657](../../../apps/web-frontend/src/ws/session-hooks.ts#L657)): build + `client.send({ type:"slash.run", name, args, … })` with a fresh `commandId`.
2. **Result hook** `useSlashResults(client)` — fold `slash.result` events into a small list (mirror `usePendingApprovals` reducer shape in [apps/web-frontend/src/ws/pending-approvals.ts](../../../apps/web-frontend/src/ws/pending-approvals.ts)); each result keyed by `name`+seq.
3. **Render** a `SlashResultBlock` component (monospace, ANSI-stripped text in a bordered card with the command name + a copy button) — reuse the light-theme tokens (`surface-input`, `ink`, `line`) already in `EscalationCard`/`MessageBubble`. Append inline in the transcript or in a dismissible drawer.
4. **Palette rewire**: change the server-routed rows from `action: prefill(slug)` to `action: () => { sendSlashRun(slug, parseArgs(rest)); return "" }` (return empty draft — the palette closes, the result streams back). Keep the **read-only** Phase-1 commands here; leave mutation commands (Phase 2) prefilling until their verbs land.
5. **Frontend protocol mirror**: add `SlashRunCommand` to the `SessionCommand` union + `SlashResultEvent` to `SessionEvent` in [apps/web-frontend/src/types/protocol.ts](../../../apps/web-frontend/src/types/protocol.ts) (ticket 02 keeps these in drift-lockstep).

## Definition of Done (vitest)
- `useSlashRun` sends a `slash.run` command with the right `name`/`args` (no-op until `sessionId` known) — same test pattern as the send hooks.
- `useSlashResults` dedups by id and renders the latest; a `slash.result` with `isError:true` renders the error tone.
- `SlashResultBlock` snapshot: command name + output text present; ANSI already stripped server-side.
- Full frontend suite green (`bunx vitest run`), tsc 0, `vite build` ok.
- Manual: with the daemon on `:4096` (gate on), typing `/state` in the web palette renders the working-state panel text inline — not a dead prefill.

## Notes
- This closes the loop for **every** read-only command at once (they all flow through the one `slash.run`/`slash.result` pair). Phase 1 (ticket 05) is then purely about turning daemon **slots** on so each command has data to render.
- Keep `/clear` and `/image` as local-only actions (no server round-trip) — they are genuinely client-side.
