# Ticket — MCP protocol-version bump + negotiated supported-set

**Date:** 2026-06-07
**Status:** Design (NOT implementation). This ticket proposes a single SSOT + a negotiation seam; it ships no code.
**Gap:** `docs/backlog/jun-7-gap-other-agent.md` §1.1 (P1) — verified jun-07 src grep.
**Slice:** `@/mcp` (the version constant currently duplicated across `client.ts` / `isolated-client.ts` / `transports/http-sse.ts`; a new shared `SUPPORTED_PROTOCOL_VERSIONS` SSOT + a tiny negotiation helper). No new slice required.
**Candidate ADR:** next free (≥ 0497) — `docs/decisions/` last allocated is `0496`.
**Default posture:** This is NOT the usual default-OFF byte-identity case. Negotiation must be **BACKWARD-COMPATIBLE**: a server that only speaks the *old* pinned version (`2025-06-18`) MUST still connect. The invariant is **"no regression for existing servers,"** spelled out exactly:
  - The client OFFERS the newest version it supports (`2025-11-25`) on `initialize.protocolVersion`. Per MCP, a compliant server that does NOT support the offered version replies with the *highest version IT supports* in its `initialize` response `protocolVersion`. The client ACCEPTS that reply iff it is a member of `SUPPORTED_PROTOCOL_VERSIONS`, and pins it for the session (it is what the `mcp-protocol-version` HTTP header then carries). So an old-only server answers `2025-06-18`, the client accepts it, and the wire is byte-identical to today FROM THAT POINT.
  - The ONE behavioral change is the OFFERED value on the very first `initialize` (today a hardcoded `2025-06-18`; after the bump, `2025-11-25`). This is the change that must be guarded: a strict server that rejects an *unknown* offered version (rather than negotiating down) must still be handled — see §5 downgrade path. A knob (`QUANTA_MCP_PROTOCOL_OFFER`, default = newest) lets an operator pin the offered version back to `2025-06-18` for a server known to choke on the bump, restoring byte-identical behavior.
  - Capabilities advertised are UNCHANGED by this ticket (still whatever the wired negotiator compiles — today `{}` by default). The version bump does NOT silently turn on `listChanged` / `tasks` / `elicitation`; those stay capability-gated and knob-gated as they are now (§9).
**Competitor source:** Cursor SDK `.extracted_source/cursor/extensions/cursor-mcp/dist/main.js:9322-9323` (`const i="2025-11-25", s=[i,"2025-06-18","2025-03-26","2024-11-05","2024-10-07"]`); Codex `.extracted_source/codex/_codex-rs-0.135-symbols.txt` (`2025-11-25` ElicitRequestFormParams schema, UNSUPPORTED_PROTOCOL); Claude Code IDE spec §6.2.1 (negotiated set, same five versions).
**ROI:** cost 저-중, impact 중 (interop with current-gen MCP servers + a path to the newer `tools/tasks/elicitation` capabilities). Backlog ranks P1.

---

## 1. Problem

quanta pins a **single fixed** MCP protocol version and never negotiates. The constant `PROTOCOL_VERSION = "2025-06-18"` is sent verbatim on every `initialize` and stamped on every HTTP `mcp-protocol-version` header. There is no supported-set, no acceptance check on the server's reply, and no downgrade path.

Two concrete failures follow:

1. **Against a newer-only server** (one that has moved to `2025-11-25` and dropped `2025-06-18`): quanta offers `2025-06-18`, the server may downgrade to it (fine) — but quanta gains **none** of the newer protocol's surface (the `2025-11-25` elicitation form schema, newer task semantics, etc.) because it never *offers* the newer version. quanta is permanently stuck at the floor it pins.

2. **No acceptance/validation of the server's chosen version.** quanta sends `2025-06-18` and then **ignores whatever the server replies with**. The server's `initialize` response `protocolVersion` is never read or checked. If a server replies with a version quanta does not actually implement, quanta proceeds blindly rather than failing closed or downgrading deliberately. The handshake is one-directional: *send a fixed value, never look at the answer.*

Competitors (Cursor 3.5.33 / Codex 0.135 / Claude Code CLI 2.1.167) all carry a **newest-first supported set** and negotiate, rather than pinning one. quanta is the outlier.

---

## 2. Current state (src-verified)

The version is a **literal string `"2025-06-18"`**, hardcoded and **triplicated** (one copy per client/transport, no shared SSOT):

- `src/mcp/client.ts:46` — `const PROTOCOL_VERSION = "2025-06-18"`. Sent at `client.ts:447` inside `start()`:
  ```ts
  const initResult = await this.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,   // line 447
    clientInfo: CLIENT_INFO,
    capabilities: this.negotiator.compile(),
  })
  this.serverCapabilities = asRecord(initResult)?.capabilities ? … : {}   // 451-453
  ```
  Note: `start()` reads `initResult.capabilities` (line 451-453) but **never reads `initResult.protocolVersion`** — the server's chosen version is discarded. There is no acceptance check, no downgrade, no SSOT.
- `src/mcp/isolated-client.ts:42` — `const PROTOCOL_VERSION = "2025-06-18"` (a second, independent copy). Sent at `isolated-client.ts:200` with `capabilities:{}` hardcoded (the isolated path doesn't even thread a negotiator). The `initialize` result is awaited but discarded (`isolated-client.ts:199-204`).
- `src/mcp/transports/http-sse.ts:36` — `const PROTOCOL_VERSION = "2025-06-18"` (a third copy), used ONLY to stamp the `"mcp-protocol-version"` request header at `http-sse.ts:210` (`requestHeaders`). The file's header comment still says *"spec rev 2025-03-26"* (line 3) — stale.
- `src/mcp/capabilities/default-negotiator.ts:12` — `compile()` returns `EMPTY` (`{}`). The negotiator slice handles **capabilities only**; it has **no version list, no downgrade logic** (`fullNegotiator` likewise).
- Whole-tree confirm: `supportedVersions` / `versionList` / `downgrade` / `2025-11-25` / `SUPPORTED_PROTOCOL` grep **0** in `src/mcp/`. (`2024-11-05` / `2025-03-26` appear only in doc-comments, never as offered values.)

So: quanta **sends a fixed value and does NOT validate the server's reply** — both halves of the gap.

---

## 3. Competitor mechanism (verified)

**Cursor (verbatim, `cursor-mcp/dist/main.js:9322-9323`):**
```js
const i = "2025-11-25",
  s = [i, "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"],   // newest-first
```
i.e. a single newest-first ordered array; the newest (`i`) is the offered default, the rest are the downgrade-acceptable set.

**Codex (`_codex-rs-0.135-symbols.txt`):** `2025-11-25` is the live schema target (the `ElicitRequestFormParams` shape is "MCP 2025-11-25"), with an `UNSUPPORTED_PROTOCOL` failure path — a negotiated set with an explicit unsupported-version error rather than blind proceed.

**Claude Code IDE spec §6.2.1** (`docs/plans/jun-7-draft-ide-integration-spec-claude.md:284-296`), the negotiated-set semantics this ticket adopts:
- supported set (newest first): `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`. `protocolVersion` is **negotiated, not fixed**.
- Sequence: client `initialize {protocolVersion, capabilities, clientInfo}` → server `{protocolVersion, capabilities, serverInfo:{name,version}, instructions?}` → client `notifications/initialized` → `tools/list` → `tools/call`. Server may emit `notifications/tools/list_changed`.
- **Capabilities advertised:** the IDE MCP server registers `capabilities:{tools:{listChanged:true}}` + `serverInfo` + optional `instructions`.
- **Error envelope:** *protocol* errors throw `McpError` with JSON-RPC codes (e.g. `InvalidParams -32602`); **tool-level** failures return a normal result with `isError:true` in the content — NOT a throw. Incoming frames are **schema-validated** (`P$.parse`); a malformed frame routes to **`onError`, not a crash**.

This `isError:true`-result vs `McpError`-throw distinction is the load-bearing contract for §4/§7: a tool that fails is a *result*, only a *protocol* violation throws.

---

## 4. Design

A single newest-first SSOT, consumed by all three clients/transports; the client offers newest, accepts the server's chosen version iff it is in the set, else downgrades or fails-closed. Closed-port: ONE constant, no per-call-site duplication.

### 4.a The SSOT

New shared module (`src/mcp/protocol-version.ts`, exported from the `@/mcp` barrel):
```ts
// newest-first; index 0 is the offered default
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07",
] as const
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]   // "2025-11-25"
export const isSupportedProtocolVersion = (v: unknown): v is SupportedProtocolVersion =>
  typeof v === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(v)
```
The three existing `const PROTOCOL_VERSION = "2025-06-18"` (`client.ts:46`, `isolated-client.ts:42`, `http-sse.ts:36`) are **deleted** and replaced by an import of the SSOT. The offered value becomes `LATEST_PROTOCOL_VERSION` (default), overridable by `QUANTA_MCP_PROTOCOL_OFFER` for a known-strict server (knob pins it back to `2025-06-18` ⇒ byte-identical to today).

### 4.b Negotiation in `client.start()`

After the `initialize` request returns (`client.ts:446-453`), READ the now-discarded `initResult.protocolVersion`:
- **In the set ⇒ accept + pin.** Store `negotiatedVersion = initResult.protocolVersion`. This is the session's pinned version; the HTTP transport's `mcp-protocol-version` header must carry IT (not the offered constant) on every subsequent request — so the transport needs the pinned value handed to it after `initialize` (a `setProtocolVersion(v)` on the transport, called once from `start()`; stdio is a no-op since it stamps no header).
- **Absent ⇒ legacy-tolerant.** A server that omits `protocolVersion` in its reply (the current quanta-tolerated shape) ⇒ pin to the OFFERED value (today's behavior, no regression).
- **Present but NOT in the set ⇒ fail-closed** with a typed `McpError` (`mcp server "<name>" replied with unsupported protocolVersion "<v>"; supported: <set>`). We never silently proceed on a version we don't implement (Codex's `UNSUPPORTED_PROTOCOL` parity). This is a *protocol* error ⇒ a throw, NOT an `isError` result (§3).

### 4.c The downgrade path (offer-side)

A strict server that rejects an *unknown offered* version (replies with a JSON-RPC `error`, e.g. `InvalidParams -32602`, instead of negotiating down) is handled by a **single bounded re-offer**: catch the `initialize` error, and if it is a version-rejection AND the offered version was the newest, retry `initialize` ONCE offering the floor (`2025-06-18`, today's pinned value). A second failure propagates. This bounds the bump's blast radius: the worst case for a strict-old server is one extra round-trip, then byte-identical behavior. (Operators who know a server is strict set `QUANTA_MCP_PROTOCOL_OFFER=2025-06-18` to skip the probe entirely.)

### 4.d Transports consume the one SSOT

- **http-sse** (`http-sse.ts:210`): `requestHeaders` stamps `mcp-protocol-version`. Today: the hardcoded constant. After: the **pinned negotiated version** (set via `setProtocolVersion` after `initialize`; before negotiation completes — i.e. the `initialize` POST itself — it uses `LATEST_PROTOCOL_VERSION` / the offered value).
- **stdio**: stamps no header; only the `initialize` *body* carries the version, which `client.start()` already controls. No transport change beyond the no-op `setProtocolVersion`.
- **isolated-client** (`isolated-client.ts:200`): replace its private constant with the SSOT import and apply the SAME negotiation read on the `initialize` result it currently discards (`isolated-client.ts:199-204`). The isolated path stays default-OFF (`MCP_USE_ISOLATED_SPAWN`) but must not diverge on the version SSOT — one source, both clients.

### 4.e Schema-validate incoming frames (already partly present)

The HTTP transport already runs a strict envelope check (`http-sse.ts:479` `isValidEnvelope` → `decodeAndEmit` drops non-JSON-RPC frames with a warn, not a crash). This is the `P$.parse → onError, not crash` contract from §6.2.1 — keep it; the `initialize`-response negotiation read MUST treat a malformed/missing `protocolVersion` as the legacy-tolerant case (§4.b), never throw on a shape it can route around. Tool-result handling (`foldCallResult`, `client.ts:556`) already maps `isError` to `ok:false` and does NOT throw on a tool failure — that is the §3 `isError:true`-result-vs-throw distinction already honored; this ticket must not regress it.

**Behavioral-change callout (load-bearing):** the *only* observable change is the offered version on the first `initialize`. Everything downstream (header on subsequent requests, capabilities, tool-call result shape) is either pinned-to-server-choice or unchanged. The bump is guarded by §4.c downgrade + the `QUANTA_MCP_PROTOCOL_OFFER` knob so a strict-old server still negotiates down.

---

## 5. Compatibility / risk (honest)

- **What breaks if a server doesn't recognize a newer offered version?** Two server behaviors:
  1. *Spec-compliant* server: replies with the highest version IT supports (e.g. `2025-06-18`). quanta accepts it (§4.b) ⇒ no break, byte-identical from there.
  2. *Strict/buggy* server: rejects the unknown offered version with a JSON-RPC error rather than negotiating down. Handled by the §4.c single bounded re-offer at the floor. The cost is one extra `initialize` round-trip on first connect. A pathological server that rejects *both* the newest and the floor surfaces a typed `McpError` (it would not have worked at any version we speak).
- **Downgrade path** is bounded (one re-offer) and knob-skippable (`QUANTA_MCP_PROTOCOL_OFFER`). No unbounded version-probe loop.
- **Capability-flag differences across versions.** Newer protocol revisions gate newer capabilities (e.g. `tools:{listChanged:true}`, the `tasks/*` family, `2025-11-25` elicitation form schema). Bumping the *version string* does NOT auto-enable these — quanta still advertises only what its wired negotiator compiles (today `{}`), and still capability-gates `tasks` (`serverSupportsTasks`, `client.ts:462`), `resources`, `prompts`, etc. on the server's *advertised* caps. The risk is the inverse: a server that, seeing a newer negotiated version, advertises `listChanged`/`tasks` and EXPECTS quanta to honor `notifications/tools/list_changed` — quanta currently routes resource/tool list-changed notifications to an optional observer (`client.ts:872`, `isResourceNotificationMethod`) and otherwise ignores them, which is safe (no crash) but means we don't yet *act* on a newer capability we didn't ask for. That is acceptable for v1 (§9): version parity first, capability adoption is a separate, knob-gated follow-up.
- **The triplicated-constant deletion is itself a risk surface** — three call sites, three different consumers (init body / init body / HTTP header). The §7 SSOT-single-source ratchet exists precisely to prevent a future re-divergence.

---

## 6. Files to touch

- `src/mcp/protocol-version.ts` *(new)* — `SUPPORTED_PROTOCOL_VERSIONS` (newest-first), `LATEST_PROTOCOL_VERSION`, `isSupportedProtocolVersion`, `SupportedProtocolVersion` type. Pure, no IO/env.
- `src/mcp/index.ts` — export the new SSOT from the `@/mcp` barrel.
- `src/mcp/client.ts` — delete `PROTOCOL_VERSION` (line 46); import the SSOT; offer `LATEST_PROTOCOL_VERSION` (or the knob) at `start()` (line 447); after `initialize` returns, READ + accept/downgrade/fail-closed the server's `protocolVersion` (currently discarded at line 451-453); call `transport.setProtocolVersion(pinned)`; implement the §4.c single bounded re-offer.
- `src/mcp/isolated-client.ts` — delete `PROTOCOL_VERSION` (line 42); import the SSOT; same negotiation read on the `initialize` result it discards (line 199-204).
- `src/mcp/transports/http-sse.ts` — delete `PROTOCOL_VERSION` (line 36); import the SSOT for the offered value; add `setProtocolVersion(v)` so the `mcp-protocol-version` header (line 210, `requestHeaders`) carries the PINNED version post-negotiation; fix the stale "spec rev 2025-03-26" comment (line 3).
- `src/mcp/transports/stdio.ts` + `src/mcp/transports/port.ts` — add the no-op/`setProtocolVersion` to the `McpTransport` port so the client can call it uniformly (stdio stamps no header → no-op).
- `src/shared/runtime-config.ts` — `QUANTA_MCP_PROTOCOL_OFFER` (default = `LATEST_PROTOCOL_VERSION`) + the surface/SSOT manifest entry.
- `fc` catalog (`tools/feature-catalog/`) — register the feature.

---

## 7. Test / hellgate plan

- **Negotiate-down to an old-only server:** offer `2025-11-25`; a server replying `2025-06-18` ⇒ client accepts, pins `2025-06-18`, the subsequent HTTP `mcp-protocol-version` header carries `2025-06-18` (the pinned value, NOT the offered one). `tools/list`/`tools/call` succeed — byte-identical to today from the post-`initialize` point.
- **Accept newest:** a server replying `2025-11-25` ⇒ pinned, header carries `2025-11-25`.
- **Legacy-tolerant:** a server reply with NO `protocolVersion` field ⇒ pin to the offered value, no throw (today's behavior preserved).
- **Reject unknown version (fail-closed):** a server reply with `protocolVersion:"1999-01-01"` (not in the set) ⇒ typed `McpError`, NOT a silent proceed, NOT an `isError` result.
- **Strict-server downgrade (§4.c):** a server that answers the newest offer with a JSON-RPC `error` (`InvalidParams -32602`) ⇒ exactly ONE re-offer at the floor `2025-06-18` ⇒ connect; a second rejection ⇒ propagate. Assert the re-offer is bounded (no loop).
- **Knob pin-back (byte-identical):** `QUANTA_MCP_PROTOCOL_OFFER=2025-06-18` ⇒ the offered `initialize.protocolVersion` is `2025-06-18` AND no re-offer probe occurs — wire byte-identical to pre-ticket.
- **SSOT single-source ratchet (the divergence guard):** grep-assert that the literal `"2025-06-18"`/`"2025-11-25"` offered-version string appears as an offered value ONLY in `protocol-version.ts` — `client.ts` / `isolated-client.ts` / `http-sse.ts` carry NO independent version constant. (This is the permanent guard against the triplication re-forming.)
- **Malformed frame → onError, not crash:** a non-JSON-RPC / malformed `initialize` response frame routes through `isValidEnvelope`/the negotiation read to a warn/typed-error, never an unhandled throw or process crash (§6.2.1 `P$.parse → onError`).
- **`isError` result vs `McpError` throw:** a `tools/call` returning `{isError:true}` ⇒ `ok:false` result (no throw, `foldCallResult` unchanged); a protocol-level violation (unsupported version, bad envelope) ⇒ `McpError` throw. Red-on-injection: a server that returns `isError:true` must NOT be mistaken for a protocol error and vice-versa.

---

## 8. ROI / cost

- **Cost: 저-중.** The SSOT is ~10 lines; the negotiation read in `client.start()` is small (read one field, branch accept/downgrade/fail). The spend is (a) threading the pinned version into the HTTP transport header post-`initialize` (a new `setProtocolVersion` seam across the port + 3 impls), and (b) the §4.c bounded re-offer. The triplicated-constant deletion is mechanical but must land with the §7 ratchet so it can't re-diverge.
- **Impact: 중.** Closes the outlier gap (every competitor negotiates; quanta pins). Genuine wins: interop with current-gen servers that have moved off `2025-06-18`; a *path* to the newer `tools/tasks/elicitation` capabilities (the version is the prerequisite, not the capability adoption itself — see §9). Honest scoping: this ticket buys **version parity + a downgrade-safe handshake**, NOT new capability behavior. The newer capabilities (`listChanged` action, richer tasks, `2025-11-25` elicitation form) are separate, knob-gated follow-ups that this bump unblocks.

---

## 9. Open questions (calibrate — no magic)

1. **Which capabilities to actually adopt with the bump — vs just the version string?** This ticket deliberately bumps the *version* and does NOT auto-enable `tools:{listChanged:true}` / `tasks/*` / `2025-11-25` elicitation. Each newer capability is its own follow-up: (a) `listChanged` — quanta already *routes* `notifications/tools/list_changed` to an optional observer (`client.ts:872`) but does not *re-fetch* `tools/list` on it; acting on it is real work. (b) `tasks/*` — already capability-gated (`serverSupportsTasks`, `client.ts:462`), advertised honestly as `listChanged:false` (per backlog §1.5); the version bump doesn't change that. (c) the `2025-11-25` elicitation *form* schema (Codex's `ElicitRequestFormParams`) is a richer elicitation shape than quanta's current variants (backlog §1.4 notes the missing `url` variant). **Recommendation: ship version-negotiation alone first; gate each new-version-only capability behind its own knob, adopt on measured demand.**
2. **Should the offered default track `LATEST` or be conservative?** Offering newest is competitor parity (Cursor/Codex offer `2025-11-25`) and the §4.c downgrade makes it safe. But a fleet of known-old servers would eat one extra round-trip each on first connect. Is the `QUANTA_MCP_PROTOCOL_OFFER` knob enough, or do we want a per-server-config offered-version override (so a known-old server in `.mcp.json` skips the probe without a global env)? **Recommendation: global knob v1; per-server override only if a real fleet needs it (no speculative per-server field).**
3. **Header-version timing on HTTP.** The `mcp-protocol-version` header on the *`initialize` POST itself* must carry the OFFERED version (negotiation hasn't happened yet); only subsequent requests carry the PINNED one. Confirm no server requires the header to match the *eventually-negotiated* version on the initialize POST (would be a chicken-and-egg the spec doesn't impose, but verify against the corpus before locking).
4. **Fail-closed vs fail-tolerant on an unknown server-chosen version.** §4.b fails closed (typed `McpError`) when the server picks a version not in our set. Is hard-fail right, or should we attempt the floor anyway? **Recommendation: fail closed — proceeding on a version we don't implement is exactly the silent-mismatch bug this ticket exists to kill (Codex's `UNSUPPORTED_PROTOCOL` parity).**
