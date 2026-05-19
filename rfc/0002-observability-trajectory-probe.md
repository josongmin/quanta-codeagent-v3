# RFC-0002: Observability · Trajectory · Probe 플랫폼

- **상태**: Draft — W-A~W-E 구현됨 (v0.3, §15 참조; ADR-0010)
- **작성일**: 2026-05-19
- **대상**: 실행 과정을 디버그 가능하게 만드는 관측 플랫폼 (특히 SWE-bench 다인스턴스 실행)
- **선행**: RFC-0001(아키텍처), ADR-0003(test-pyramid), ADR-0006(sandbox env-scrub)
- **원칙 상속**: anti-bloat(신규 dep 0 · 슬라이스 최소 · 경계 0; **LoC 캡 없음**, ADR-0012), 의존성 <5(신규 0), 슬라이스 격리(Biome 강제), `@/agent`/`apps`만 조립자
- **리뷰 반영(v0.2)**: "100% 재구성" 표현 정정 · eval 모드 관측실패 hard-fail · pricingVersion · assistant_text 보존 · stream↛observability 경계 수정 · span/seq/schema-registry/patch·sandbox·verifier 증거 · redaction 게이트화 · probe 비권위

---

## 1. 목표

에이전트 1회 실행(특히 SWE-bench 인스턴스)의 **관측 가능한 의사결정·도구호출·검증 결과를 로그 추가 재실행 없이 재구성**할 수 있게 한다.

> "완전(100%) 재현"은 명시적 비목표다(§1.2). 모델 내부 상태·비결정성·외부 시스템 전체 상태는 캡처 대상이 아니며, 우리가 보장하는 건 *관측 가능한 증거*의 무손실 보존이다.

### 1.1 성공 기준 (측정 가능)

- 실패한 SWE-bench 인스턴스 1건을, **로그 추가 재실행 없이** 단일 아티팩트로 원인을 *진단*(단정 아님)할 수 있다 — 다음 증거가 모두 그 안에 있다: 의사결정 turn열, tool 호출/결과(+stdout/stderr tail·exit·소요), LLM usage, 생성 patch diff, sandbox 스냅샷, verifier 입력/출력.
- run_id → instance → attempt(Best-of-N) → turn → span(tool/llm) → tool_use 까지 **상관키로 슬라이스 조회** 가능.
- 유료 실행의 **인스턴스별 토큰·비용·지연**이 집계로 남고, 비용은 **pricingVersion이 박혀 사후 재계산 가능**.
- `bun run probe <run-dir>` 한 줄로 timeline·triage(가설, 권위 아님)·hotspots·cost 렌더.
- 신규 런타임 의존성 **0**, 슬라이스 경계 위반 0, redaction 골든 테스트 통과. **anti-bloat 게이트**: 신규 dep 0 · 신규 슬라이스 최소 · 경계 위반 0 (전역 LoC 캡 없음, ADR-0012).

### 1.2 Non-Goals

- ❌ **완전 재현/replay** (LLM 비결정성·외부 상태 전체는 대상 아님 — 관측 가능 증거만)
- ❌ OpenTelemetry/Jaeger/Prometheus **SDK 의존** (의미모델은 차용, 코드 의존 금지 — §9)
- ❌ 원격 수집기·DB·대시보드 서버 (로컬 파일이 1급, 외부는 후속 OTLP 어댑터)
- ❌ 실시간 분산 트레이싱 (단일 프로세스, append-only 파일이면 충분)
- ❌ 관측이 에이전트 **동작/결정**에 영향 (관측은 순수 부수효과)
- ❌ probe가 **권위적 진단(authoritative verdict)** 을 내림 (inspector — 가설·신뢰도만)
- ❌ 모든 슬라이스 계측 (에이전트 실행경로 + bench만; 라이브러리 내부는 메트릭만)

> **보안 자세 (S6/S7 — secure-by-default, 강제됨)**: 이전의
> "수용/유예된 S6/S7 자세"(무-jail·무인 `acceptEdits`)는 더 이상
> 유효하지 않다. read/write/edit는 단일 초크포인트
> `storage.resolvePath`(lexical + realpath, symlink-탈출 불가)에서
> 강제되는 `ctx.cwd` jail에 갇힌다 — 절대-경로-바깥 / `..`-상승 /
> symlink 탈출은 거부(`ok:false`, throw 없음, 부분 쓰기 없음). 도구가
> baseDir를 넘길 때만 적용되며, 옵트아웃은 `QUANTA_FS_JAIL=off`. CLI
> 기본 권한 모드는 묵시적 `acceptEdits` → `default`로 변경(변경 시
> 확인; 읽기 전용은 그대로 자동 허용; 명시적 `QUANTA_PERMISSION`은
> 계속 존중). HARD_DENY는 보수적 심층방어를 추가(크리덴셜 유출,
> decode-후-실행, 다운로드-파이프-인터프리터, 원시 블록디바이스 쓰기).
> RFC §1.2대로 denylist는 여전히 best-effort이며 샌드박스가 아니다 —
> jail/권한이 1차 경계, 레닥션(S1/S4/S2)·HARD_DENY(S3)는 심층방어.

---

## 2. 배경 — 현 결함 (코드 감사 2026-05-19)

부품은 SOTA스럽게 존재하나 실행경로에 안 꿰임:

| 결함 | 근거 |
|---|---|
| bench 관측 불능 | `apps/bench/runner.ts` → `NullStream`(AgentEvent 전폐기), `metrics` 미주입. 산출=`[FAIL] id (turns=N)` 한 줄 |
| 상관 ID 부재 | run_id↔instance↔attempt↔turn↔tool_use 연결 없음 |
| 토큰/비용 미계측 | LLM 어댑터가 provider `usage`를 폐기 |
| 재현 아티팩트 부재 | 인스턴스별 trajectory 없음 (`state.ts`는 최종 messages만) |
| 메트릭 비영속 | `Metrics.snapshot()` 존재하나 bench가 덤프 안 함 |
| 로거 이원화 | `@/shared`(휴먼) vs `@/observability`(구조화) 혼용, bench는 휴먼만 |

자산: `StructuredLogger`, `Metrics`(percentile), `AgentRecorder`, `AgentEvent` 스트림, `hooks` 버스, `state.ts` — 재사용.

---

## 3. 설계 원칙

1. **이벤트가 진실의 단일원천.** trajectory(append-only JSONL) = 정본. 메트릭/요약/probe 출력은 전부 그로부터 파생.
2. **관측은 부수효과 — 단, 실패 처리는 모드 의존.**
   - *product/세션 모드*: 레코더 실패는 에이전트를 막지 않음. 그러나 **삼키지 않고 `observability_degraded` 이벤트 + 카운터로 흔적을 남김** (droppedEvents 포함).
   - *eval/benchmark 모드*(`QUANTA_OBSERVE_STRICT=1`, bench 기본 ON): 레코더 실패 = **hard-fail 또는 해당 인스턴스 verdict를 `degraded`로 마킹**. 관측 불능인 결과를 정상 점수로 집계하지 않는다.
   - 공통: 미설정 시 현 동작 바이트 동일.
3. **기존 슬라이스 확장 > 신규 슬라이스.** 새 슬라이스 0, 새 app 1(`probe`). 크로스커팅 타입은 `@/shared`(누구나 import — 격리 합법).
4. **SOTA 의미모델 차용, SDK 비의존.** OTel GenAI 컨벤션의 *스팬 트리·네이밍*만 채택(§9).
5. **상관키는 컨텍스트로 전파.** `RunContext` 옵셔널. **span 모델 명시**: `spanId`/`parentSpanId`로 `llm_request→llm_usage`, `tool_call→tool_result`를 짝지음.
6. **비밀 누출 0 — 선언이 아니라 게이트.** 기록 전 스크럽(ADR-0006 allowlist 단일원천) + **redaction 골든 테스트가 머지 게이트**(§11).
7. **스키마는 레지스트리.** 라인에 `schema:"quanta.trajectory.v1"` + `producer{name,version,gitSha}` + `seq`(시계 스큐 무관 순서) + `pricingVersion`. 후방호환은 probe 책임.
8. **probe는 inspector.** 원인은 `triage_hint`/`likely_failure_class`/`confidence`로만 — 단정 금지.

---

## 4. 아키텍처 — 컴포넌트 & 흐름

```
   RunContext{runId,instanceId?,attempt?,turn?,toolUseId?}  (옵셔널, AgentConfig 경유)
   llm 어댑터 ──usage(in/out/cache,model)──┐
                                            ▼
[agent loop] ──AgentEvent(+span)──▶ StreamPort
                                     ├── StdoutStream / SseStream      (기존, 사람/HTTP)
                                     └── TeeStream ─┬─▶ (위 중 택, 없으면 NullStream)
                                                    └─▶ JsonlRecorder ─▶ <run>/<instance>.<attempt>.jsonl
   hooks ──lifecycle─────────────────────────────────┤   (정본 trajectory: 1 line/event)
   bench ──patch_*/sandbox/verify────────────────────┤
   AgentRecorder ──counter/timer/usage/cost─▶ Metrics ─┴─▶ <run>/metrics.json
   레코더 실패 ──observability_degraded──────────────┘                 │
                                                       bun run probe ◀─┘  (read-only, 비권위)
```

bench는 `NullStream` 대신 `Tee(humanOrNull, JsonlRecorder)` 주입. eval 모드는 recorder 실패를 verdict에 반영.

---

## 5. 핵심 인터페이스

### 5.1 상관 컨텍스트 — `@/shared`

```typescript
export interface RunContext {
  runId: string            // 1 회 bench/세션
  instanceId?: string      // SWE-bench instance
  attempt?: number         // Best-of-N (0-base)
  turn?: number            // ReAct turn (loop가 갱신)
  toolUseId?: string       // 디스패치 중 도구 호출
}
```
`AgentConfig.run?: RunContext` (옵셔널, 미설정 시 무영향 — 프로젝트 표준 패턴).

### 5.2 Trajectory 스키마 v1 — `@/shared` (경계상 stream이 import해야 하므로 shared에 둠, §6)

```typescript
export interface TrajectoryEvent {
  schema: "quanta.trajectory.v1"        // 스키마 레지스트리 키
  v: 1                                   // 메이저 (probe 후방호환 분기)
  seq: number                            // 프로세스-단조 증가 (시계 스큐 무관 정렬)
  ts: number                             // epoch ms (벽시계, 표시용)
  monotonicNs?: number                   // performance 시계 (지연 계산용)
  ctx: RunContext
  spanId?: string                        // 이 이벤트가 속한 스팬
  parentSpanId?: string                  // 스팬 트리
  producer: { name: string; version: string; gitSha?: string }
  pricingVersion?: string                // cost 파생에 쓰인 가격표 버전
  redaction: { policy: string; applied: boolean }   // 스크럽 정책·적용 여부
  kind:
    | "session_start" | "session_end"
    | "turn_start"
    | "llm_request" | "llm_usage"
    | "assistant_text"                   // 델타 보존(합치지 않음) — §14
    | "tool_call" | "tool_progress" | "tool_result"
    | "recovery"                         // backoff/compact/nudge/empty/malformed
    | "patch_generated" | "patch_applied" | "patch_rejected"
    | "sandbox"                          // 1회 스냅샷 (인스턴스 시작 시)
    | "verify"                           // bench 채점 증거
    | "error"
    | "observability_degraded"           // 레코더가 무언가 흘렸다는 흔적
  data: Record<string, unknown>          // kind별 페이로드 (스크럽 후, 아래)
}
```

kind별 `data` 최소 계약 (probe·골든테스트가 의존):

| kind | data |
|---|---|
| `llm_usage` | `model, inputTokens, outputTokens, cacheReadTokens?, costUsd|null` |
| `tool_result` | `name, ok, exitCode?, durationMs, stdoutTail, stderrTail, fullLogPath?` |
| `patch_generated`/`_applied`/`_rejected` | `diffPath, filesChanged, hunks, applyStatus` |
| `sandbox` | `repoCommit, baseCommit, worktreeDirty, runtime{bun?,node?,python?}, envPolicyVersion` |
| `verify` | `command, exitCode, passed, failedTests, logTail, reportPath` |
| `observability_degraded` | `component, reason, droppedEvents` |

append-only JSONL, 1 이벤트 1 라인. `AgentEvent`(stream) + 훅 lifecycle + `llm_usage` + bench `patch_*`/`sandbox`/`verify`를 한 스트림으로 정규화.

> **§5.2 개정 (Phase-1 현실 정합, 2026-05-19)**: Group C/E 구현은
> `session_start`·`recovery`를 실제 방출하고 `tool_result`를
> `durationMs`/`stderrTail`/`exitCode`로 보강한다. **`llm_request` 유예
> 해제(개정 2)**: 이제 매 turn의 모델 스트림 소비 **직전**에
> `{kind:"llm_request", data:{model}}`을 실제 방출한다(`LLMPort`는
> 프리-스트림 모델 접근자가 없어 어댑터가 전송하는 설정 모델을 좁은
> 런타임 프로브로 읽고, 없으면 `"unknown"`). 레코더는 `llm_request`와
> 그 turn의 `llm_usage`에 **동일 llm 스팬**(`llm:${turnSpan}`,
> parent=turnSpan)을 부여 — turn당 request 1 / usage 1 이므로
> `request.spanId === usage.spanId`가 결정적으로 성립한다. 따라서 §11
> `llm_request↔llm_usage` span-짝 골든은 **유예가 아니라 실제 활성**
> (`llm_usage` 단독 고정이 아님). `tool_call↔tool_result` 짝은 그대로
> 유효. 방출은 순수 부수효과(NullStream이 삼킴) — 미설정 시 동작
> 바이트 동일·제어흐름 불변.

### 5.3 토큰/비용 — `llm` + `@/observability`

`StreamEvent`에 `{ type:"usage"; inputTokens; outputTokens; cacheReadTokens?; model }` 추가 → 어댑터가 provider 응답 usage를 흘려보냄(현재 폐기 중). `AgentEvent`에 동형 추가. 비용은 `@/observability`의 **버전드 정적 가격표**(`pricing.v<N>`, 모델→$/1M, 네트워크 0)로 파생; 결과 이벤트에 `pricingVersion` 박음(사후 재계산 가능). 미상 모델 → `costUsd:null`(에러 아님).

### 5.4 StreamPort 합성 — `@/stream`

기존 `StreamPort{emit}` 불변. 신규 어댑터 2개:
- `TeeStream(...ports)` — 팬아웃. 한 포트 throw 시: product=격리 후 진행 + `observability_degraded`; strict(eval)=에러 전파(호출측이 verdict degraded 처리).
- `JsonlRecorder(dirOrPath, opts)` — `AgentEvent`→`TrajectoryEvent` 정규화·스크럽·`seq`/`span` 부여·append. 버퍼링/플러시/파일 라인 상한. 실패 처리는 `opts.strict`로 모드 분기. `@/shared`의 스키마만 import(경계 합법).

### 5.5 메트릭 (기존 확장, 무신설)

`AgentRecorder`에 `usage(in,out,model)`/`cost(usd,pricingVersion)`/`degraded(component)` 추가. bench 종료 시 `metrics.snapshot()`→`<run>/metrics.json`.

---

## 6. 슬라이스 매핑 (격리 준수 — v0.2 수정)

`src/stream/**`는 Biome상 `@/observability` import **금지**(@/shared만 허용). 따라서 **`TrajectoryEvent`·`RunContext`는 `@/shared`** 에 둔다(크로스커팅 타입, 누구나 import — memory↛llm 때와 동일 패턴). 가격표/`cost()`는 `@/observability`(조립자·probe만 사용).

| 슬라이스 | 추가 | 경계 |
|---|---|---|
| `shared` | `RunContext`, `TrajectoryEvent v1` 스키마 | 누구나 import (OK) |
| `llm` | `StreamEvent.usage`; 어댑터 usage emit | @/shared만 |
| `stream` | `TeeStream`, `JsonlRecorder`(+`AgentEvent.usage`) | **@/shared만** import (스키마 거기 있음 → 합법) |
| `observability` | 버전드 가격표, `cost()` | @/shared만 |
| `agent` | `AgentConfig.run?`; loop가 `turn`/span 갱신·usage/lifecycle emit | 조립자 |
| `apps/bench` | `NullStream`→`Tee`, patch_*/sandbox/verify emit, strict=ON, metrics/summary | apps |
| `apps/probe` | **신규 app** — read-only, 비권위 inspector | apps |

신규 슬라이스 0. `apps/probe` 신설 = RFC-0001 §9.2 ADR 트리거.

디렉토리 델타:
```
src/shared/run-context.ts                 # RunContext
src/shared/trajectory.ts                  # TrajectoryEvent v1 (스키마 레지스트리)
src/observability/pricing.ts              # 버전드 가격표 + cost()
src/stream/adapters/tee.ts                # TeeStream
src/stream/adapters/jsonl-recorder.ts     # JsonlRecorder (seq/span/redaction)
src/apps/probe/{index,parse,render,triage}.ts
tests/unit/{trajectory,tee,jsonl-recorder,pricing,redaction,probe}.test.ts
tests/integration/bench-observability.test.ts
docs/decisions/0010-observability-trajectory.md
```

---

## 7. `probe` 툴 (read-only, **비권위**)

`bun run probe <run-dir | trajectory.jsonl> [--instance ID] [--failed] [--slow] [--cost] [--json]`

- **timeline**: turn별 assistant 요약 + span 트리(tool_call→result: ok/err, exit, ms)
- **triage**(`--failed`): 실패 인스턴스만 — `triage_hint`, `likely_failure_class`, `confidence`(0–1). **단정 아님**; 종료사유·마지막 에러·patch 유무·verify logTail·reportPath 원증거를 함께 제시해 사람이 판단.
- **hotspots**(`--slow`): 최슬로우 span Top-N (monotonicNs 기반)
- **cost**(`--cost`): 인스턴스별 in/out 토큰·$ (pricingVersion 명시)·resolved 상관
- **`--json`**: 머신 출력. probe는 어떤 필드도 "확정 원인"으로 라벨하지 않는다.

SOTA 대응: AISI Inspect viewer / LangSmith run viewer / SWE-agent `*.traj` 의 인하우스·무의존·비권위판.

---

## 8. SWE-bench 배선

`runInstance`(runner.ts): `NullStream` → `TeeStream(NullStream, JsonlRecorder(<run>/<instanceId>.<attempt>.jsonl, {ctx, strict:true}))`. attempt마다 별 파일. 추가로:
- 인스턴스 시작 시 `kind:"sandbox"` 1건(repoCommit/baseCommit/worktreeDirty/runtime/envPolicyVersion).
- 패치 라이프사이클 `patch_generated|applied|rejected`(diffPath/filesChanged/hunks/applyStatus).
- `verify()` → `kind:"verify"`(command/exitCode/passed/failedTests/logTail/reportPath).
- recorder 실패 → 해당 인스턴스 `verdict:"degraded"`(resolved 집계에서 제외, summary에 별도 표기).
- run 종료: `<run>/metrics.json` + `<run>/summary.json`(predictions·resolved·degraded 조인).
- `--observe-dir`/`QUANTA_OBSERVE_DIR`(기본 OFF → 현 동작 불변), bench는 strict 기본 ON.

---

## 9. SOTA 정합 (의미모델 차용, SDK 비의존 근거)

| SOTA | 차용 | 우리 구현 |
|---|---|---|
| OTel GenAI 시맨틱 컨벤션 | 스팬 트리·`gen_ai.usage.*` 네이밍 | `spanId/parentSpanId` + `llm_usage` JSONL |
| AISI Inspect viewer | 인스턴스별 replayable 로그 + inspector | `<instance>.jsonl` + `probe` |
| LangSmith/Langfuse run tree | run→span 상관 | `RunContext` + span |
| SWE-agent `*.traj` | 인스턴스 trajectory + patch | 동형 JSONL(스키마 레지스트리) + `patch_*` |

**SDK 비의존 근거**: RFC-0001 §12 의존성 폭증=1순위 위험. OTel SDK=트랜시티브 다수+런타임 무게. 포트/어댑터라 후속 OTLP exporter를 *어댑터*로 추가 가능 → 지금 박는 건 YAGNI.

---

## 10. Phase 계획 (웨이브, 파일 소유 disjoint 병렬)

- **W-A (기반, 선행)**: `shared/{run-context,trajectory}`, `observability/pricing`, `StreamEvent.usage` + 어댑터 usage emit. (`shared`,`observability`,`llm`)
- **W-B (스트림, A 의존)**: `stream/{tee,jsonl-recorder}`(seq/span/redaction/strict) + `AgentEvent.usage`. (`stream`)
- **W-C (배선, B 의존)**: loop가 `turn`/span 갱신·usage/lifecycle emit; CLI `--observe-dir`. (`agent`,`apps/cli`)
- **W-D (bench, B 의존, C와 파일 disjoint)**: runner Tee·sandbox/patch_*/verify emit·strict·metrics/summary. (`apps/bench`)
- **W-E (probe, JSONL 스키마만 의존)**: `apps/probe` 비권위 inspector. (`apps/probe`)

W-A→(B)→(C‖D), E는 스키마 확정 후 독립. 각 웨이브: tsc 0 / biome exit0·복잡도 0 / 전 테스트 green / 경계 probe / **redaction 골든 통과**.

---

## 11. 테스트 전략 (ADR-0003 피라미드)

- **redaction 골든 = 머지 게이트(blocking)**: env secret / tool input secret / prompt 내 secret / stacktrace 내 token 4종이 trajectory에 절대 안 박힘을 골든으로 고정. 실패 시 머지 불가.
- **unit**: 스키마(schema/v/seq/producer/pricingVersion 필수), span 짝(llm_request↔llm_usage, tool_call↔tool_result parentSpanId), 가격표/cost(미상→null, pricingVersion 박힘), TeeStream 격리 vs strict 전파, JsonlRecorder append/플러시/상한/degraded 이벤트, probe 파서·triage(confidence 범위, 단정 라벨 부재) 골든.
- **integration**: FakeLLM `runAgent` → JsonlRecorder 정합 trajectory → `probe` 파싱·triage 정확. bench: 합성 코퍼스 1건 → `<run>/{*.jsonl,metrics.json,summary.json}` + sandbox/patch_*/verify 이벤트 존재·일관, recorder 강제 실패 시 verdict=degraded.
- **결정성**: 시계/seq/ts 주입, 무네트워크.

---

## 12. 위험 & 완화

| 위험 | 가능성 | 영향 | 완화 |
|---|---|---|---|
| 관측이 에이전트 동작 변경 | 중 | 큼 | 부수효과·미설정 바이트동일·회귀테스트 |
| **관측 실패가 eval 점수 오염** | 중 | 큼 | eval=strict: hard-fail/`verdict:degraded`, resolved 집계 제외 |
| 비밀 누출 | 중 | 큼 | 스크럽 단일원천 + **redaction 골든 머지게이트** |
| **비용 재현 불가(가격표 드리프트)** | 중 | 중 | 이벤트에 `pricingVersion` 박음, 가격표 버전드 |
| span 짝 오류(상관 깨짐) | 중 | 중 | span 짝 골든테스트, loop가 단일지점서 발급 |
| JSONL 비대(500-instance) | 높 | 중 | 인스턴스별 파일·라인상한·tail+path(전체 저장 금지)·요약은 metrics.json |
| 스키마 드리프트 | 중 | 중 | `schema`+`v`+골든, probe 후방호환 |
| probe 오진을 단정으로 오용 | 중 | 중 | 비권위 설계(hint/confidence), 원증거 동시 제시 |
| anti-bloat 침범 | 중 | 큼 | 신규 슬라이스 최소·dep 0·경계 0 게이트(LoC 캡 없음, ADR-0012), 신규 app만 ADR |

---

## 13. ADR 트리거 (RFC-0001 §9.2)

- **ADR-0010**: 관측 플랫폼 — trajectory 스키마 레지스트리 v1, eval 모드 관측실패 정책(strict→degraded), SDK 비의존, `apps/probe` 신설. 코드 동작 후 1페이지. (0009는 lsp-diagnostics-tool로 선점됨 → 0010)

---

## 14. 미해결 질문 (구현 중 결정)

1. trajectory 파일 회전/압축 — 라인 상한 vs gzip? (막힐 때)
2. `assistant_text` — **델타 보존이 기본**(streaming/tool-interleave 디버깅). 축약은 probe 렌더 책임. 남은 질문: 초장문 응답의 라인 상한 정책.
3. probe TUI 깊이 — Phase 1 플레인, TUI는 수요 시.
4. OTLP exporter 어댑터 — 별도 RFC + 외부 통합 ADR 대상.
5. `RunContext`를 hooks 페이로드에도 넣을지 (관찰자 일관성 vs 표면 확대).
6. `sandbox`/`patch_*` 증거의 보존 상한(diff 전체 vs hunk 메타+path).

**원칙**: 막힐 때 결정. 미리 결정하지 않음. (RFC-0001 §13 상속)

---

## 15. 변경 이력

| 버전 | 날짜 | 변경 |
|-----|-----|-----|
| 0.1 | 2026-05-19 | 최초 작성 — 관측/trajectory/probe 플랫폼 구조 제안 (구현 전 RFC) |
| 0.2 | 2026-05-19 | 리뷰 반영: "100%재구성"→관측증거 재구성 / eval 관측실패 strict→degraded / pricingVersion·버전드 가격표 / assistant_text 델타 보존 / **stream↛observability 경계 위반 수정**(스키마 @/shared 이동) / span(spanId·parentSpanId)·seq·schema 레지스트리·producer / patch_*·sandbox·verify 증거 / observability_degraded / redaction 골든 머지게이트 / probe 비권위(hint·confidence) |
| 0.3 | 2026-05-19 | **구현 완료**(W-A~W-E, 전 웨이브 TDD red→green): @/shared trajectory 스키마+RunContext+redactValue, @/observability pricing.v1, @/llm StreamEvent.usage(anthropic·openai), @/stream TeeStream+JsonlRecorder(seq·결정적 span·strict/degraded·line-cap), agent/cli RunContext+usage 브리지+`--observe-dir`, bench Tee+sandbox/patch_*/verify+strict-degraded+metrics/summary, **신규 앱 apps/probe**(비권위 inspector). 신규 의존성 0·신규 슬라이스 0. redaction 골든(§11 머지게이트) 랜딩. RFC-0002 산출 10파일 tsc0/biome0, 단위+통합 피라미드 그린·경계 유지(하드 카운트 비고정). ADR-0010 작성·채택(0009=lsp-diagnostics 선점). |
