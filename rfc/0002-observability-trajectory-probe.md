# RFC-0002: Observability · Trajectory · Probe 플랫폼

- **상태**: Draft
- **작성일**: 2026-05-19
- **대상**: 실행 과정을 디버그 가능하게 만드는 관측 플랫폼 (특히 SWE-bench 다인스턴스 실행)
- **선행**: RFC-0001(아키텍처), ADR-0003(test-pyramid), ADR-0006(sandbox env-scrub)
- **원칙 상속**: anti-bloat(<20k LoC), 의존성 <5(신규 0), 슬라이스 격리(Biome 강제), `@/agent`/`apps`만 조립자

---

## 1. 목표

에이전트 1회 실행(특히 SWE-bench 인스턴스)의 **무슨 일이 왜 일어났는지를 사후 100% 재구성**할 수 있게 한다.

### 1.1 성공 기준 (측정 가능)

- 실패한 SWE-bench 인스턴스 1건을 **로그 추가 재실행 없이** 단일 아티팩트로 원인 진단 가능
- run_id → instance → attempt(Best-of-N) → turn → tool_use 까지 **상관키로 슬라이스 조회** 가능
- 유료 실행의 **인스턴스별 토큰·비용·지연**이 집계로 남음
- `bun run probe <run-dir>` 한 줄로 타임라인·실패분류·최슬로우·비용 렌더
- 신규 런타임 의존성 **0**, 전체 LoC 증분 **< 1.2k**, 슬라이스 경계 위반 0

### 1.2 Non-Goals

- ❌ OpenTelemetry/Jaeger/Prometheus **SDK 의존** (의미모델은 차용, 코드 의존 금지 — §9)
- ❌ 원격 수집기·DB·대시보드 서버 (로컬 파일이 1급, 외부는 후속 어댑터)
- ❌ 실시간 분산 트레이싱 (단일 프로세스, append-only 파일이면 충분)
- ❌ 관측이 에이전트 동작/결정에 영향 (관측은 순수 부수효과, 실패는 삼킴)
- ❌ 모든 슬라이스 계측 (에이전트 실행경로 + bench만; 라이브러리 내부는 메트릭만)

---

## 2. 배경 — 현 결함 (코드 감사 2026-05-19)

부품은 SOTA스럽게 존재하나 실행경로에 안 꿰임:

| 결함 | 근거 |
|---|---|
| bench 관측 불능 | `apps/bench/runner.ts` → `NullStream`(AgentEvent 전폐기), `metrics` 미주입. 산출=`[FAIL] id (turns=N)` 한 줄 |
| 상관 ID 부재 | run_id↔instance↔attempt↔turn↔tool_use 연결 없음 |
| 토큰/비용 미계측 | LLM 어댑터가 provider `usage`를 폐기 |
| 재현 아티팩트 부재 | 인스턴스별 replayable trajectory 없음 (`state.ts`는 최종 messages만) |
| 메트릭 비영속 | `Metrics.snapshot()` 존재하나 bench가 덤프 안 함 |
| 로거 이원화 | `@/shared`(휴먼) vs `@/observability`(구조화) 혼용, bench는 휴먼만 |

자산: `StructuredLogger`, `Metrics`(percentile), `AgentRecorder`(이름 정리됨), `AgentEvent` 스트림, `hooks` 버스, `state.ts` — 재사용 가능.

---

## 3. 설계 원칙

1. **이벤트가 진실의 단일원천.** trajectory(append-only JSONL) = 정본. 메트릭/요약/probe 출력은 전부 그로부터 파생.
2. **관측은 부수효과.** 레코더 실패는 삼키고 에이전트는 계속 (Non-Goal). 동작 보존: 미설정 시 바이트 동일.
3. **기존 슬라이스 확장 > 신규 슬라이스.** RFC-0001 §3.1 "구현 1개면 약식". 새 슬라이스 0, 새 app 1(`probe`).
4. **SOTA 의미모델 차용, SDK 비의존.** OTel GenAI 시맨틱 컨벤션의 *네이밍/스팬 트리 모양*만 채택, 코드 의존 금지(§9).
5. **상관키는 컨텍스트로 전파.** `RunContext` 옵셔널 — 있으면 모든 이벤트에 스탬프, 없으면 무영향.
6. **비밀 누출 0.** 레코더는 tool input/env를 기록 전 스크럽(ADR-0006 allowlist 재사용, 중복 금지).
7. **스키마 버전드.** trajectory 라인에 `v` 필드. 후방호환은 probe의 책임.

---

## 4. 아키텍처 — 컴포넌트 & 흐름

```
                 RunContext{runId,instanceId?,attempt?,turn,toolUseId}
                          │ (옵셔널, AgentConfig 경유 전파)
   llm 어댑터 ──usage──▶ │
                          ▼
[agent loop] ──AgentEvent──▶ StreamPort
                              ├── StdoutStream      (기존, 사람용)
                              ├── SseStream         (기존, HTTP)
                              └── TeeStream ─┬─▶ (위 둘 중 택)
                                             └─▶ JsonlRecorder ──▶ <run>/<instance>.<attempt>.jsonl
                                                       │                   ▲
   hooks 버스 ──lifecycle──────────────────────────────┤                   │ (정본 trajectory)
   AgentRecorder ──counter/timer──▶ Metrics ──snapshot──┴──▶ <run>/metrics.json
                                                                           │
                                                            bun run probe ◀┘  (read-only inspector)
```

데이터 흐름: 에이전트/어댑터/훅이 내는 모든 신호 → `TeeStream`이 사람용 출력과 `JsonlRecorder`로 분기 → 인스턴스별 JSONL = 정본 → `probe`가 읽어 타임라인/진단/비용 렌더. bench는 `NullStream` 대신 `Tee(silent, JsonlRecorder)` 주입.

---

## 5. 핵심 인터페이스

### 5.1 상관 컨텍스트 — `@/shared`

```typescript
export interface RunContext {
  runId: string                 // 1 회 bench/세션
  instanceId?: string           // SWE-bench instance
  attempt?: number              // Best-of-N (0-base)
  turn?: number                 // ReAct turn (loop가 갱신)
  toolUseId?: string            // 디스패치 중 도구 호출
}
```
`AgentConfig.run?: RunContext` (옵셔널, 미설정 시 무영향 — 프로젝트 표준 패턴).

### 5.2 Trajectory 스키마 v1 — `@/observability`

```typescript
export interface TrajectoryEvent {
  v: 1
  ts: number                    // epoch ms
  ctx: RunContext               // 상관키 스냅샷
  kind:
    | "session_start" | "session_end"
    | "turn_start"
    | "llm_request" | "llm_usage"        // usage: in/out/cache tokens, model
    | "assistant_text"                   // 델타는 합쳐 1건
    | "tool_call" | "tool_progress" | "tool_result"
    | "recovery"                          // backoff/compact/nudge/empty/malformed
    | "error" | "verify"                  // verify: bench 채점 결과
  data: Record<string, unknown> // kind별 페이로드 (스크럽 후)
}
```
append-only JSONL, 1 이벤트 1 라인. `AgentEvent`(stream) + 훅 lifecycle + `llm_usage` + bench `verify`를 한 스트림으로 정규화.

### 5.3 토큰/비용 — `llm` + `@/observability`

`StreamEvent`에 `{ type:"usage"; inputTokens; outputTokens; cacheReadTokens?; model }` 추가 → 어댑터가 provider 응답의 usage를 흘려보냄(현재 폐기 중). `AgentEvent`에 동형 `usage` 추가. 비용은 `@/observability`의 **정적 가격표**(모델→$/1M, 네트워크 0)로 파생; 미상 모델은 `cost:null`(에러 아님).

### 5.4 StreamPort 합성 — `@/stream`

기존 `StreamPort{emit}` 불변. 신규 어댑터 2개 (stream 슬라이스 어댑터 패턴 그대로):
- `TeeStream(...ports: StreamPort[])` — 팬아웃, 한 포트 throw해도 나머지 진행.
- `JsonlRecorder(dirOrPath, opts)` — `emit`을 `TrajectoryEvent`로 정규화·스크럽·append. 버퍼링/플러시, 파일 상한, 실패 삼킴. `RunContext`는 생성 시 주입 또는 이벤트별.

### 5.5 메트릭 (기존 확장, 무신설)

`AgentRecorder`에 `usage(in,out,model)` / `cost(usd)` 추가. bench 종료 시 `metrics.snapshot()`을 `<run>/metrics.json`으로 덤프.

---

## 6. 슬라이스 매핑 (격리 준수)

| 슬라이스 | 추가 | 비고 |
|---|---|---|
| `shared` | `RunContext` 타입 | 누구나 import 가능 (격리 OK) |
| `llm` | `StreamEvent.usage`; 어댑터가 usage emit | provider usage 흘리기 |
| `stream` | `TeeStream`, `JsonlRecorder` 어댑터 + `AgentEvent.usage` | stream만 import (격리 OK), 직렬화는 자체 |
| `observability` | `TrajectoryEvent` 스키마, 정적 가격표, `cost()` | `@/shared`만 의존 |
| `agent` | `AgentConfig.run?`; loop가 `ctx.turn` 갱신·usage/lifecycle를 stream으로 emit | 조립자, 모두 import 가능 |
| `apps/bench` | `NullStream`→`Tee`, 인스턴스/attempt 키, metrics.json, verify 이벤트 | apps |
| `apps/probe` | **신규 app** — read-only inspector CLI | apps (격리 무관) |

신규 슬라이스 0. `apps/probe` 신설은 RFC-0001 §9.2 ADR 트리거(앱 추가) → ADR 작성.

디렉토리 델타:
```
src/shared/run-context.ts                 # RunContext
src/observability/trajectory.ts           # TrajectoryEvent v1 + 가격표 + cost()
src/stream/adapters/tee.ts                # TeeStream
src/stream/adapters/jsonl-recorder.ts     # JsonlRecorder
src/apps/probe/{index,parse,render,triage}.ts
tests/unit/{trajectory,tee,jsonl-recorder,cost,probe}.test.ts
tests/integration/bench-observability.test.ts
docs/decisions/0009-observability-trajectory.md
```

---

## 7. `probe` 툴 (CLI 사양)

`bun run probe <run-dir | trajectory.jsonl> [--instance ID] [--failed] [--slow] [--cost] [--json]`

읽기 전용. 출력:
- **timeline**: turn별 assistant 요약 + tool_call→result(ok/err, ms) 들여쓰기 트리
- **triage**(`--failed`): 실패 인스턴스만, 종료사유·마지막 에러·최종 패치 유무·verify 로그 tail
- **hotspots**(`--slow`): 최슬로우 tool/llm 스팬 Top-N (Metrics percentile)
- **cost**(`--cost`): 인스턴스별 in/out 토큰·$ 합계·resolved 상관
- **`--json`**: 머신 출력(상위 도구가 파싱)

SOTA 대응: AISI Inspect `inspect view`, LangSmith run viewer, SWE-agent `*.traj`의 인하우스·무의존판.

---

## 8. SWE-bench 배선

`runInstance`(runner.ts): `NullStream` → `TeeStream(new NullStream(), new JsonlRecorder(<run>/<instanceId>.<attempt>.jsonl, {ctx}))`. Best-of-N attempt마다 별 파일. `verify()` 결과를 `kind:"verify"`로 emit. run 종료 시 `<run>/metrics.json` + `<run>/summary.json`(predictions·resolved 조인). `--observe-dir` / `QUANTA_OBSERVE_DIR` (기본 OFF → 현 동작 불변).

---

## 9. SOTA 정합 (의미모델 차용, SDK 비의존 근거)

| SOTA | 차용 | 우리 구현 |
|---|---|---|
| OTel GenAI 시맨틱 컨벤션 | 스팬 트리 모양·속성 네이밍(`gen_ai.usage.*` → `llm_usage`) | JSONL kind/ctx로 등가 표현 |
| AISI Inspect `.eval`/viewer | 인스턴스별 replayable 로그 + inspector | `<instance>.jsonl` + `probe` |
| LangSmith/Langfuse run tree | run→child span 상관 | `RunContext` 전파 |
| SWE-agent `*.traj` | 인스턴스 trajectory 파일 | 동형 JSONL(스키마 버전드) |

**SDK 비의존 근거**: RFC-0001 §12 의존성 폭증이 1순위 위험. OTel SDK = 트랜시티브 다수 + 런타임 무게. 단일 바이너리·로컬 우선 제품에 수집기 불필요. 의미모델만 차용하면 후속에 OTLP 익스포터를 *어댑터*로 추가 가능(아키텍처가 이미 포트/어댑터). → 지금 SDK 박는 건 YAGNI.

---

## 10. Phase 계획 (웨이브, 파일 소유 disjoint 병렬)

- **W-A (기반, 선행)**: `shared/RunContext`, `observability/trajectory`(스키마+가격표+cost), `StreamEvent.usage` + 양 어댑터 usage emit. (`shared`,`observability`,`llm`)
- **W-B (스트림, A 의존)**: `stream/TeeStream`+`JsonlRecorder` + `AgentEvent.usage`. (`stream`)
- **W-C (배선, B 의존)**: loop가 `RunContext.turn` 갱신·usage/lifecycle emit; CLI `--observe-dir`. (`agent`,`apps/cli`)
- **W-D (bench, B 의존, C와 파일 disjoint)**: runner Tee 주입·verify 이벤트·metrics/summary 덤프. (`apps/bench`)
- **W-E (probe, JSONL 스키마만 의존)**: `apps/probe` CLI + 렌더/triage. (`apps/probe`)

W-A→(B)→(C‖D), E는 스키마 확정 후 독립. 각 웨이브: tsc 0 / biome exit0·복잡도 0 / 전 테스트 green / 경계 probe.

---

## 11. 테스트 전략 (ADR-0003 피라미드)

- **unit**: 스키마 직렬화·스크럽(비밀 미기록), 가격표/cost(미상 모델 null), TeeStream 팬아웃·격리(throw 격리), JsonlRecorder append/플러시/상한, probe 파서·렌더 골든.
- **integration**: FakeLLM로 `runAgent` 구동 → JsonlRecorder가 정합 trajectory 생성 → `probe`가 파싱·triage 정확. bench: 합성 코퍼스 1건 → `<run>/{*.jsonl,metrics.json,summary.json}` 생성·일관.
- **결정성**: 시계/ts 주입, 무네트워크. contract/eval 티어 무관.

---

## 12. 위험 & 완화

| 위험 | 가능성 | 영향 | 완화 |
|---|---|---|---|
| 관측이 에이전트 동작 변경 | 중 | 큼 | 부수효과·실패삼킴·미설정 시 바이트동일, 회귀테스트 |
| 비밀 누출(tool input/env) | 중 | 큼 | 기록 전 스크럽(ADR-0006 allowlist 재사용, 단일원천) |
| JSONL 비대(500-instance) | 높 | 중 | 인스턴스별 파일·라인 상한·요약은 metrics.json |
| 스키마 드리프트 | 중 | 중 | `v` 필드 + probe 후방호환 + 골든테스트 |
| anti-bloat 침범 | 중 | 큼 | 신규 슬라이스 0·dep 0·LoC<1.2k 게이트, 신규 app만 ADR |
| OTel 미채택 후회 | 낮 | 중 | 포트/어댑터라 OTLP exporter 후속 추가 가능 |

---

## 13. ADR 트리거 (RFC-0001 §9.2)

- **ADR-0009**: 관측 플랫폼 + trajectory 스키마 v1 + SDK 비의존 결정 (앱 추가 `apps/probe` + 스키마 = 트리거). 코드 동작 후 1페이지.

---

## 14. 미해결 질문 (구현 중 결정)

1. trajectory 파일 회전/압축 — 라인 상한 vs gzip? (막힐 때)
2. `assistant_text` 델타 — 합쳐 1건 vs 토큰 스트림 보존? (probe 요구로 결정)
3. probe 출력 컬러/TUI 깊이 — Phase 1은 플레인, TUI는 수요 시
4. OTLP exporter 어댑터 — 별도 RFC 대상인가? (외부 통합 = ADR)
5. `RunContext`를 hooks 페이로드에도 넣을지 (관찰자 일관성 vs 표면 확대)

**원칙**: 막힐 때 결정. 미리 결정하지 않음. (RFC-0001 §13 상속)

---

## 15. 변경 이력

| 버전 | 날짜 | 변경 |
|-----|-----|-----|
| 0.1 | 2026-05-19 | 최초 작성 — 관측/trajectory/probe 플랫폼 구조 제안 (구현 전 RFC) |
