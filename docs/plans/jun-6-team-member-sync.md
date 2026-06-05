# RFC: G2 — team-member sync (real-time multi-USER collaboration)

> Status: **DESIGN (not implemented) · DEFER** · Author: agent audit · Date: 2026-06-06
> Scope: design doc only. No source file is modified by this RFC.
> Candidate ADRs: 0487 (presence/sync port) · 0488 (CRDT document model) — number assigned at impl time.
> Tier: **G (§7 카테고리 갭)** — very-high-cost, enterprise, surface-gated. RIGHT-SIZED sketch with an HONEST defer verdict.

---

## 1. 요약 (Summary)

G2 is **real-time multi-USER collaboration** — multiple *humans* editing the same
workspace/session concurrently with live cursor presence and edit sync (the Google-Docs /
Cursor-multiplayer model). It is explicitly **NOT** the multi-AGENT coordination quanta
already has: that axis (`src/subagent/coordination/`) synchronizes **AI workers** spawned
by one user inside one process. G2 is the **human-team axis** — N people, N machines, one
shared document, conflict resolution across the network.

**The honest framing up front (this RFC's main job):** G2 is **very-high-cost** and its
crux is **infrastructure quanta does not have and deliberately does not run** — a **sync
backend** (a persistent relay/server holding authoritative document state and fanning out
deltas). quanta is a local-first agent (CLI / Web-Tauri / CLI-embedded browser, [[surface-model]]),
with **no server, no multi-tenant identity, no presence channel**. The recommendation is
**DEFER** with a precise "defer-unless" condition (§8). This RFC records the protocol shape
(CRDT vs OT) and the cheapest non-trivial slice so that if an enterprise need lands, the
design is already scoped.

---

## 2. 경쟁사 레퍼런스 (Competitor reference)

### 2.1 Cursor — multiplayer / shared agent sessions

Cursor's collaboration model rides on a **hosted backend**: presence (who is in the file),
live cursors, and shared agent sessions are relayed through Cursor's servers, with an AI
sync DB (the v1→v2 tracking DB noted in [[cursor-3.2-absorption]]). The load-bearing fact:
**multiplayer requires a server**; it is not a peer-to-peer local feature.

### 2.2 Google-Docs / Figma — CRDT & OT lineage

The two industry-standard conflict-resolution families:
- **OT (Operational Transformation)** — Google Docs. Operations are transformed against
  concurrent ops; requires a **central server** to order/transform ops. Mature but
  server-coupled and notoriously hard to get correct.
- **CRDT (Conflict-free Replicated Data Type)** — Figma, Yjs/Automerge. Edits merge
  deterministically without a central authority; well-suited to **local-first +
  peer-sync**, but the document model (sequence CRDT for text) is heavy and the wire
  format is non-trivial.

### 2.3 Synthesis (what G2 would absorb)

| Concern | Cursor | Docs/Figma | quanta G2 (if ever) |
|---|---|---|---|
| Authority | hosted server | server (OT) / none (CRDT) | **none today** → CRDT preferred (local-first) |
| Presence | server relay | server relay | needs a presence channel (gap) |
| Conflict | server | OT / CRDT | **CRDT** (matches local-first posture) |
| Transport | WebSocket to backend | WS to backend | **no transport exists** (gap) |

The synthesis cue: **if** quanta ever does G2, CRDT (not OT) fits the local-first posture
because it does not mandate a single authoritative server — but it still needs a **relay**
for presence + delta fan-out, which is the unavoidable cost.

---

## 3. 현재 quanta 상태 (Ground truth — grep-verified)

### 3.1 What exists is multi-AGENT, single-USER (the thing G2 is NOT)

- `src/subagent/coordination/` — broker (`broker.ts`), DAG gate (`dag-gate.ts`,
  `dag.ts`), idle barrier (`idle-barrier.ts`). The broker synchronizes **AI workers**: a
  worker hitting a denied tool sends a **mailbox** `request`; a leader runs it through an
  injected `EscalationDeciderPort` and replies (`broker.ts:7-28`,
  `EscalationDeciderPort` `:61`). The mailbox (`MailboxPort`, `broker.ts:28`) is an
  **in-process, in-memory** channel mirrored from `@/agent/subagent-mailbox`
  (`broker.ts:63-64`).
- **This is single-user, single-process.** There is no second human, no network, no
  remote peer. The "sync" here is AI-worker admissibility, not human edit reconciliation.

### 3.2 No sync backend, no presence, no multi-user identity

- `grep` for a relay/presence/WebSocket-collab surface: none. The web surface is a Tauri
  app shell + CLI-embedded browser ([[surface-model]]) — a **local-first single-operator**
  posture. There is no server process, no multi-tenant session store, no identity beyond
  the single local user (`944899@naver.com` env).
- Session state is local JSONL (`src/session/store.ts`, [[codex-session-jsonl-envelope]]) —
  a **single-writer** model. There is no concept of concurrent remote writers or a merge
  function over session/file state.

### 3.3 What G2 requires that is entirely absent

A presence channel, a network transport (WS/WebRTC), a CRDT/OT document model, a relay (or
peer-discovery) for delta fan-out, and a multi-user identity/auth layer. **None exist.**
G2 is not an extension of an existing slice — it is a new subsystem plus external infra.

---

## 4. 설계 (Design — sketch only; this is deliberately thin)

### 4.1 The shape (if it were ever built): CRDT + injected relay

```
User A ─┐                                  ┌─ User B
        ├─► local CRDT replica ─► deltas ──► RelayPort ──► deltas ─► local CRDT replica ─┤
User C ─┘    (merge fn)            ▲          (fan-out)              (merge fn)            └─ ...
                                   └──────────── presence (cursor/selection) ─────────────┘
```

- **Document model:** a sequence CRDT (Yjs/Automerge-style) over the shared text/buffer.
  Edits are CRDT ops that merge **commutatively + idempotently** — no central transform.
- **RelayPort (closed-port DI — the only honest seam quanta can own):**

```
interface CollabRelayPort {
  join(room: string, identity: PeerIdentity): Promise<PeerHandle>
  broadcast(handle: PeerHandle, delta: CrdtDelta): Promise<void>
  onDelta(handle: PeerHandle, cb: (d: CrdtDelta, from: PeerId) => void): Unsubscribe
  presence(handle: PeerHandle, cursor: CursorState): Promise<void>
  onPresence(handle: PeerHandle, cb: (p: PresenceState) => void): Unsubscribe
  leave(handle: PeerHandle): Promise<void>
}
```

quanta would own the **CRDT merge core** (pure, testable, no network) and inject the
relay. The relay is the part quanta **cannot** own without becoming a hosted service.

### 4.2 Conflict resolution: CRDT chosen over OT

CRDT, because OT mandates a single authoritative ordering server (antithetical to local-
first), whereas a CRDT replica merges peer deltas deterministically and can run against a
dumb relay (or even peer-to-peer WebRTC) that only fans bytes out. The cost is the CRDT
document model's complexity and memory (tombstones, causal metadata).

### 4.3 What stays pure vs what is external

- **Pure (quanta-ownable, testable):** the CRDT merge function + a `FakeRelayPort` for
  deterministic multi-replica convergence tests.
- **External (NOT quanta):** the actual relay/presence server, identity/auth, transport.

---

## 5. 통합 (Integration)

- **Knob (default-OFF, and would stay OFF on every surface indefinitely):** gate
  `QUANTA_TEAM_SYNC`. Given the missing backend, this is a **dormant seam**, never seeded.
- **Surface gating:** even when built, G2 is **Web-Tauri-only** (it needs a UI for cursors/
  presence; the CLI surface has nowhere to render a second human's cursor). Per
  [[surface-model]] we don't gate ROI by surface in general — but G2 is *inherently* a
  graphical-multi-user feature, so the Tauri gate is intrinsic, not a policy choice.
- **No tool-surface entry** until there is a real impl — adding a `manifest.ts` row for a
  capability with no backend would be a hollow drift-guard liability.

---

## 6. 테스트 계획 (Test plan — sketch)

The only honestly testable part pre-backend is the **CRDT core**:
- **Convergence (the CRDT invariant):** N `FakeRelayPort` replicas apply interleaved
  concurrent edits in arbitrary delivery order → all replicas converge to the **same**
  document (commutativity + idempotency under reorder + duplicate delta).
- **Presence isolation:** a peer's cursor delta never mutates document state.
- **Causal metadata bound:** tombstone/metadata growth stays bounded under a GC policy
  (otherwise a long session OOMs).
- Default-OFF: `QUANTA_TEAM_SYNC` unset ⇒ nothing registers.

---

## 7. 단계 (Phasing)

- **Phase 0 — this RFC (record only).** Scope the protocol, pick CRDT-over-OT, identify the
  backend as the crux. **No code.** (Current recommendation stops here.)
- **Phase 1 — pure CRDT core + FakeRelay (only if a need lands).** The merge function +
  convergence hellgate, fully local, no network. Buildable without a backend; useless in
  production without one. ~moderate cost.
- **Phase 2 — RelayPort + a real transport (very-high-cost).** A WS/WebRTC relay (run by
  whom?) + presence + identity/auth + the Tauri cursor UI. This is the **enterprise** step
  and the bulk of the cost.

---

## 8. 리스크 / 대안 (Risks / alternatives — biggest section, and the verdict)

- **Why it's VERY-high-cost (the crux):** G2's hard dependency is a **sync backend** —
  a persistent relay holding/fanning authoritative state + presence + multi-user identity/
  auth. quanta is **local-first with no server** ([[surface-model]], §3.2); building G2
  means either standing up a hosted service (an operational + security + privacy surface
  quanta deliberately avoids) or a peer-to-peer WebRTC mesh (NAT traversal, signaling
  server, still not free). **There is no cheap version of "real-time multi-user."**
- **Cheapest non-trivial slice:** the **pure CRDT merge core + FakeRelay convergence
  tests** (Phase 1). It is buildable today with no backend and would de-risk the protocol —
  but it ships **zero user value** alone (it cannot connect two real humans). So even the
  cheapest slice is "infrastructure with no product until Phase 2."
- **DEFER — the honest verdict. Defer-unless ALL of:** (1) a concrete enterprise/multi-user
  requirement exists; (2) a decision is made to operate (or depend on) a relay backend —
  accepting the privacy/security/ops surface that contradicts the current local-first
  posture; (3) the Web-Tauri surface has matured enough to render live presence. Absent
  any one of these, G2 stays a recorded design with no code.
- **Security/privacy surface (a reason to defer hard).** Multi-user sync means other
  humans' edits + cursors + possibly file contents cross a network through a relay. That is
  a fundamentally different trust model from the single-operator local agent — it would
  need an identity/auth/permission layer that does not exist and would not be cheap or
  safe to bolt on.
- **Alternative — async collaboration via git (already supported, recommend this instead).**
  Teams already collaborate on quanta-edited code **asynchronously through git** (the git
  axis, [[may-23-git-axis-absorption]]: PR authoring, blame, shadow ODB). For most "team"
  needs this is the right answer — durable, auditable, no backend, no privacy surface.
  Real-time cursor-sync is a *different, much narrower* need that async git does not cover,
  but async git covers the 90% case at zero infra cost. **Prefer git-async; defer G2.**
- **Alternative — OT instead of CRDT.** Rejected: OT's central-transform-server requirement
  is strictly worse for a local-first tool than CRDT's relay-agnostic merge.
- **Do NOT conflate with `src/subagent/coordination/`.** That slice's mailbox/broker is
  in-process AI-worker sync; reusing it for human multi-user would be a category error
  (no network, no human presence, no CRDT). G2 is a new subsystem, not an extension.

---

## 9. 코드 위치 요약 (Code-location summary)

**New (only if Phase 1+ is ever undertaken):**
- `src/collab/` (new subsystem) — `crdt.ts` (pure merge core, imports only `zod`),
  `port.ts` (`CollabRelayPort`), `fake-relay.ts` (test double). + an ADR at impl time.

**Audited ground truth (cited, NOT modified) — proving the gap + the contrast:**
- `src/subagent/coordination/broker.ts:7-64` + `dag.ts` + `idle-barrier.ts` — the
  multi-AGENT, single-USER, in-memory coordination G2 is explicitly NOT.
- `src/session/store.ts` — single-writer local JSONL session state (no concurrent remote writers).
- [[surface-model]] + [[may-23-git-axis-absorption]] — local-first posture + the async-git
  alternative that covers most "team" needs without a backend.
