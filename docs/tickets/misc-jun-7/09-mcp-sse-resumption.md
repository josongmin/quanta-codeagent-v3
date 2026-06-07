# Ticket 09 — MCP SSE resumption (Last-Event-ID)

**Date:** 2026-06-07
**Status:** 📐 Design (no impl).
**Gap:** §1.2 (P10) — verified jun-07: `Last-Event-ID`/`lastEventId`/`resume` grep 0 in `src/mcp/transports/http-sse.ts`.
**Slice:** `@/mcp` (transports/http-sse). Self-contained transport change.
**Candidate ADR:** next free (≥ 0510).
**Competitor:** Codex `StreamableHttpClientWorkerresume` — resume + inconsistent-state handling on reconnect.
**ROI:** cost 저-중, impact 중 — server-pushed messages during an SSE drop are currently LOST; resumption recovers them.

## 1. Problem
The streamable-HTTP MCP transport (`http-sse.ts`) does POST + GET-SSE + DELETE with `Mcp-Session-Id`, but does NOT track the SSE event id or send `Last-Event-ID` on reconnect. Per the MCP streamable-HTTP spec, a server MAY tag SSE events with `id:` and a client SHOULD replay from the last seen id after a drop. Without it, any server→client message emitted during a disconnect window is silently lost.

## 2. Current state (src-verified)
- `src/mcp/transports/http-sse.ts`: handles `Mcp-Session-Id`, POST/GET/DELETE; self-doc "spec rev 2025-03-26". No `id:` parse, no `Last-Event-ID` header on the GET-SSE reconnect, no resume cursor.
- Reconnect logic exists CLI-side (`_cli-symbols.txt`: auto-reconnect, capped attempts) but without the event-id cursor it replays from scratch (or not at all).

## 3. Design
- Parse the SSE `id:` field per event; retain the LAST id in the transport (per `Mcp-Session-Id`).
- On a GET-SSE (re)connect, send `Last-Event-ID: <lastId>` header so the server replays from after it.
- Reset the cursor on a fresh session (new `Mcp-Session-Id`); persist only for the life of the session.
- Inconsistent-state guard (Codex parity): if the server responds that the id is unknown/expired, fall back to a clean reconnect (no id) + emit an observable `mcp.sse.resume_reset` rather than spin.
- Default-OFF safety: absent any `id:` from the server ⇒ behavior byte-identical to today (no header sent, no cursor).

## 4. Files to touch
- `src/mcp/transports/http-sse.ts` — SSE `id:` parse, cursor field, `Last-Event-ID` on reconnect, unknown-id fallback.
- (maybe) the transport types if the cursor needs surfacing for telemetry.

## 5. TDD / hellgate plan (red-first)
- Parse: an SSE stream with `id: 42\nevent: …\ndata: …` → cursor = "42". (RED: no parse today.)
- Reconnect: after capturing id "42", a reconnect issues `Last-Event-ID: 42`. (fake fetch asserting the header.)
- No-id server: events without `id:` → no cursor, reconnect sends NO `Last-Event-ID` (byte-identical).
- Unknown-id fallback: server rejects the `Last-Event-ID` → clean reconnect (cursor cleared) + `resume_reset` event, no infinite loop.
- Fresh session: a new `Mcp-Session-Id` resets the cursor.
- Malformed frame: `id:` with garbage → ignored (cursor unchanged), routes to onError not crash (existing `P$.parse` discipline).

## 6. Risk
- Must not change request ordering / dedupe. The cursor is read-only telemetry-shaped state; the only wire change is one header on reconnect — low blast radius. Run existing MCP transport hellgates as regression.
