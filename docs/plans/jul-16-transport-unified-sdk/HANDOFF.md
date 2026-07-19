# HANDOFF — transport-unified-sdk closeout

**Status:** COMPLETE (2026-07-19, baseline HEAD `7d8aa9fd6`)

이 문서는 과거 “구현 0줄” 핸드오프를 대체한다. live 상태 SSOT는
[README.md](README.md), 발견·처리 이력은
[audit-followups-jul17.md](audit-followups-jul17.md)다. 과거 실행 순서는
[ROADMAP-unified.md](ROADMAP-unified.md)에 historical 기록으로 남긴다.

## Landed stack

| 축 | 커밋 | 종료 증거 |
|---|---|---|
| 01 public SDK door | c89bc49c1 + 후속 hardening | `connect()`/`SessionHandle`, ws/stdio, liveness, typed rejection, conformance |
| 02 serve --stdio | a83e28cd4 + 5b4110f18 | strict default-OFF gate, honest transport stamp, wire approval, 8 real-spawn scenarios |
| 03 protocol convergence | 896b0ae86 + 9080a8853 | field-shape ratchet + generated bundle; client merge는 경계상 hold |
| 04 full fidelity | bbd289d40 | peer-local opt-in negotiation, default preview byte identity, strip/leak rails |
| 05 durable resume | 527f78811 + a38ee957f + 1f578f28f | JSONL event log, seq continuity, durable replay, explicit `resumed` caught-up marker |
| SDK type delivery | 6f2608fce | shim-free `.d.ts`, external `file:` consumer `tsc --noEmit` |
| daemon continuation | 9ea77c2c7 + 27e191b5a | server-owned approval continuation + exact multi-peer adoption |
| handshake ordering | 29f8359eb | per-peer send tail prevents replay/live interleave |
| transcript privacy | 0ca4fe8c2 + b177f24af | event log and sqlite owner-only permissions |

## Current closeout posture

- `serve --stdio` explicitly owns wire approval delivery. Ambient
  `QUANTA_INLINE_APPROVAL_RESOLVER=1` cannot bypass `connect({onApproval})`;
  unattended callers use explicit permission modes.
- DOF-10 authentic operator proof mints a real pending approval and resolves the
  exact published id. Unknown ids remain a separate no-event survivability edge.
- Feature catalog YAML is authoritative; regenerate
  `docs/10.feature-catalog.md` with `bun fc build` after YAML edits.
- The only intentionally deferred item is the direct spawned-serve
  deny/multiple-approval duplication rail. Kernel and web-daemon real paths
  already cover the semantics; it is LOW and not a product blocker.

## Re-open conditions

Re-open this plan only for a regression in one of these contracts:

1. old/silent peers stop remaining preview-compatible;
2. `awaitTurnEnd` can hang on caught-up resume or approval continuation;
3. wire approval is bypassed without an explicit permission posture;
4. replay/live fan-out loses sequence ordering;
5. event-log/sqlite transcript files become group/world-readable.

New transport features should get a new plan rather than appending work to this
completed packet.
