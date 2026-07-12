# jul-12 — OmO 흡수 (2 트랙)

OmO audit에서 출발한 흡수 계획. **두 개의 disjoint 트랙**으로 구성된다:

- **Track 1 — Agent Runtime Correctness Primitives** (`00`–`03`): process lifecycle ·
  async 상태머신 · stale-edit 복구. senpi-task lifecycle/chaos-bench/hashline 흡수.
- **Track 2 — UX / MCP / 세션-연속성** ([05-ux-mcp-track.md](05-ux-mcp-track.md)): 세션
  resume · MCP 연결 posture · 알림/관측 표면. omo-opencode hooks/features · pi-goal ·
  boulder-state · mcp/ 흡수.

두 트랙은 파일 경합이 거의 없고 hashline만 겹친다(거기서도 결론 동일 — 전체 에디터 흡수
금지, cheap-hint만; `03`과 `05 §3.5/3.7`이 일치).

## 권위와 상태

- **Track 1 SSOT**: [00-final-rfc.md](00-final-rfc.md) · **Track 2 SSOT**:
  [05-ux-mcp-track.md](05-ux-mcp-track.md)
- **상태**: 양 트랙 final design / implementation not started
- `01`–`03`은 Track 1의 조사·대안 기록이다. 점수나 순서가 충돌하면 각 트랙 SSOT가 우선한다.
- 이 디렉터리는 현재 feature catalog SSOT가 아니다. 구현 후 feature maturity를 변경할 때만
  관련 YAML과 생성 MD를 repo 규칙대로 갱신한다.

## 최종 primitive

| Primitive | 해결 목적 | 최종 방향 | 첫 proof |
|---|---|---|---|
| `ResourceScope` | process/resource orphan 방지 | OS containment + awaitable terminal receipt + AST effect fence | TERM-trapping descendant real E2E |
| `SimulationKernel` | async state-machine 순서 버그 검출 | model-based deterministic scheduler + shrink/replay + mutation | bash-bg command model |
| `VersionedWorkspace` | stale edit 안전 복구 | full-document revision base + safe three-way apply + typed conflict | overlap/ambiguity/CAS fault matrix |

## 실행 순서

```text
R0 test cleanup → R1 ResourceScope → R2 effect fence
                         └──────────→ S1 deterministic seams → S2 model rail

V1 revision CAS → V2 three-way edit → V3 shadow/A-B rollout
```

우선순위는 R lane이다. 정적 grep을 먼저 랜딩해 기존 분산 구조를 고정하지 않는다. 실제
descendant leak RED를 만든 뒤 owner 계약을 고치고 AST fence로 회귀를 막는다.

## 조사 문서

| 문서 | 보존하는 근거 | 최종 RFC에서 바뀐 핵심 |
|---|---|---|
| [01-destruction-port-single-writer.md](01-destruction-port-single-writer.md) | side-agent single-SIGTERM, raw effect 분산 | grep→AST capability fence, ppid-primary→OS containment, void kill→awaitable scope |
| [02-chaos-property-testing.md](02-chaos-property-testing.md) | bg registry failure classes, timer leak 회귀류 | custom seeded loop→reference model/scheduler/shrinking, callback count→resource invariant |
| [03-hashline-remap-selfcorrect.md](03-hashline-remap-selfcorrect.md) | full hashline token tax, failure feedback gap | synthetic neighborhood diff→base revision/three-way conflict, CLI 역수입 금지 |

## SOTA++ 최종어딧 재조정 (4-track, RFC §0)

- **스코프 컷**: kernel 아니라 3 독립 primitive. **Phase 0(지금 SHIP, <2일) = R1-stopgap + R0 + R2.** S2-full·V1/V2/V3는 **효능 baseline(RFC §11.1) 뒤로 DEFER**.
- **A 델타**: pidfd-first(generation nonce 대체) · freeze→cgroup.kill(uv fork-storm 실장애) · close-deadline(D-state) · Windows deferred.
- **B 델타**: reference-model→**실 reducer differential**(FDB식, model-drift 자기검증) · fast-check=sampling 정직표기 · swarm/buggify/temporal-inv.
- **C 델타**: full three-way **다운스코프 → cheap-hint(RFC 03)+histogram diff**. 진짜 SOTA 격차 = LCS→histogram, three-way 아님.
- **north-star 부채**: 프로그램이 6항목 중 0개 건드림 → lifecycle receipt를 `run-ledger/`에 배선하는 것만 유일 정렬점(별도 backlog).

## 현재 truth

- 구현 완료 slice: **0/8**
- 현재 코드에 존재하는 기반: `escalatingKill`, ppid-walk fallback, partial source ratchet,
  exact/fuzzy edit ladder, `expected_hash`, mtime guard, generic metrics.
- 현재 증명되지 않은 것: descendant terminal close, deterministic schedule coverage,
  content-addressed base snapshot, safe three-way edit, recovery A/B.
