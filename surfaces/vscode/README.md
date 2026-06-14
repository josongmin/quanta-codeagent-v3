# quanta — VS Code Chat Sessions surface (T07)

A **thin editor surface** that registers quanta agent threads as native VS Code
[Chat Sessions](https://code.visualstudio.com/api). It is the third quanta
surface (alongside CLI and Web/Tauri) and is **opt-in**: nothing here is built
or shipped by the core; the core (`src/`) has **zero** VS Code coupling.

## Architecture

```
 VS Code host ── provider.ts ──► chat-session-adapter.ts ──► session.v1 ──► quanta core
   (vscode)      (vscode glue,      (PURE: no vscode)        (@/ipc/session,    (engine, app-server)
                  ONLY file that      projection + cmds       @/protocol/session)
                  imports vscode)
```

- **`chat-session-adapter.ts`** — PURE. Maps session.v1 (`@/protocol/session` +
  `@/ipc/session`) onto a structural `ChatSessionItemView` (id/label/status/
  timing) and translates editor actions into session commands. No `vscode`
  import → unit-tested against a real session transport with no editor host.
- **`status.ts`** — PURE. session.v1 lifecycle → `ChatSessionStatus`.
- **`provider.ts`** — the ONLY file importing `vscode`. Re-shapes the pure view
  into `vscode.ChatSessionItem`, re-maps status onto the proposed-API enum, and
  registers the provider.

Status is derived from the **server's** turn lifecycle (`turn.started` →
in-progress, `turn.completed` → idle, `turn.failed` → failed; the coarse
`session.state.updated` view is honored too). The adapter never optimistically
flips status on submit — a hidden/rejected turn must not show a fake spinner.

## ⚠️ Proposed-API version dependence

The `chatSessionsProvider` API is **unstable**. This package pins:

- `engines.vscode`: `^1.95.0`
- `enabledApiProposals`: `["chatSessionsProvider"]`

`ChatSessionStatus` enum values are version-dependent. The version-stable
mapping lives in `status.ts` (`CHAT_SESSION_STATUS`); `provider.ts`
(`STATUS_TO_VSCODE`) re-maps it onto the concrete enum. **When bumping the
engine, re-verify against the build's shipped
`vscode.proposed.chatSessionsProvider.d.ts` and update `STATUS_TO_VSCODE` if the
enum moved.** `vscode-proposed.d.ts` is a minimal local shim (not `@types/
vscode`) so this package typechecks standalone.

## Prerequisites (landed)

- **T01** `item/*` fine-grained streaming (`QUANTA_ITEM_STREAM`) — the protocol
  surface for rich per-item progress the editor can render.
- **T02** thread-follower co-control (`src/agent/thread-follower/`) — steer /
  interrupt / approval-relay the editor panel drives.

## Tests

- `tests/unit/surfaces/vscode/chat-session-adapter-hellgate.test.ts` — UC1–UC3
  against a real session.v1 round-trip.
- `tests/unit/surfaces/vscode/core-no-vscode-leak-ratchet.test.ts` — UC4: RED if
  any `src/` file imports `vscode` or a chatSessions proposed-API symbol.
