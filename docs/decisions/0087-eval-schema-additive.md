# ADR-0087: eval 스키마 additive 필드 — keyed metrics / token·cost / run status·params (Cursor `EvalTrackingService` 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-22
- **관련**: `cursor-3.2-absorption`(on-disk audit), `docs/analysis/code-agent-loop/cursor-deep-dives.md` §7.3(`aiserver.v1.EvalTrackingService`), ADR-0085(cost/cache dashboard).

## 맥락

quanta의 로컬 eval 저장은 JSONL append-only(`src/apps/eval/storage/schema.ts`)다. 한 줄 = 한 `EvalRecord` 엔벨로프 + tier별 payload. 현재 점수 신호는 `SyntheticPayload.score?: number` 단일 스칼라뿐이고, 토큰/비용 회계나 run 라이프사이클 상태, 재현용 파라미터 스냅샷은 없다.

Cursor `aiserver.v1.EvalTrackingService`의 Eval⊃Run 스키마는 **원격 학습 sink**(Ray 잡 / cron 스케줄 / RPC 스트리밍 메트릭)다. 통째로 들이는 건 quanta 슬라이스 격리·로컬-우선 원칙에 반한다. 하지만 그 안의 3개 작은 typed shape + 토큰/비용 필드는 quanta 로컬 eval에 그대로 가치가 높다.

## 결정

`schema.ts`(plain TS interface, **zod 없음**)에 **OPTIONAL·additive** 필드만 추가한다.

1. `export interface Metric { key; value; unit?; step? }` — keyed metric. Cursor `RunMetricItem` 흡수. 단일 `score`보다 우월: 임의 named axis + 선택 unit + 선택 step(턴 인덱스).
2. `export interface TokenUsage { prompt; completion; cacheRead?; cacheWrite? }` — Cursor Run 토큰 필드.
3. `SyntheticPayload` / `PublicPayload`에 `metrics?: readonly Metric[]`, `tokens?: TokenUsage`, `costUsd?: number` 추가(둘 다 agent run을 실제 실행하는 tier이므로 두 payload에 부착; audit/trajectory/compare는 제외).
4. `RunSummaryRecord`에 `status?: "running" | "finished" | "failed" | "killed"`(Cursor `EvalRunStatus`의 terminal subset), `params?: Readonly<Record<string, string|number|boolean>>`(Cursor `RunParamKV`, 재현용 — winning tier attributes ↔ param delta 비교 가능).

## 근거

- **3 shape만**: RPC/Ray/cron 머신은 흡수 안 함(negative invariant). quanta는 단일 CLI 호출 = 한 run, JSONL append. 원격 스트리밍 sink·잡 스케줄러는 슬라이스 모델과 충돌.
- **protobuf 아님 / `any` 아님 / 센티넬 아님**: 전부 plain TS union·interface. JSON 라운드트립으로 JSONL on-disk 포맷 그대로 보존.
- **`metrics[]` > 단일 `score`**: 한 run이 여러 named axis(judge.helpfulness, tokens.per_turn …)를 step별로 실어 보낼 수 있음.
- **status terminal subset만**: Cursor 전체 `EvalRunStatus` 대신 quanta가 실제로 구분하는 4개만.

## 대안

- **Cursor Eval⊃Run 스키마 통째 import**: 기각 — 원격 학습 sink, 슬라이스 격리·로컬-우선 위반.
- **`score`를 `Metric[]`으로 교체**: 기각 — non-additive, 기존 `score?` 소비부·테스트 깨짐. `metrics`는 `score`를 보강(병존)한다.
- **새 payload kind 추가**: 기각 — `PAYLOAD_KINDS` 디스크리미네이터 셋이 바뀌면 `result-store.readAll`/`coverage-matrix` narrowing 회귀.

## 결과·트레이드오프

- **얻은 것**: eval run이 keyed metric·토큰·비용·라이프사이클 상태·재현 파라미터를 실을 수 있음. 4 unit green / 20 expects. 기존 76 eval unit 무수정 통과.
- **비용**: seam만 추가 — runner/report 측 채택은 후속(이 ADR 범위 밖, 파일 미터치).

## 한계 (LIMITATIONS)

- (a) eval runner는 아직 새 필드를 채우지 않음 — schema seam만. 채택 점진적.
- (b) `report/`는 아직 `metrics`/`tokens`/`status`/`params`를 렌더 안 함 — 다른 트랙 소유 파일.
- (c) `Metric.key`/`params` 키 네임스페이스 컨벤션은 미정의(free-form string).

## 불변식 영향

- **byte-identical additive**: 모든 신규 필드 OPTIONAL(`exactOptionalPropertyTypes` ON — omit 시 `undefined` 미할당). 기존 record 전부 유효, JSON 라운드트립 동일. `SCHEMA_VERSION` 무변경(additive는 비파괴).
- **기존 의미 불변**: `score`/기존 payload 필드 의미·required-ness 무변경. `metrics`는 `score`를 대체하지 않음.
- **슬라이스 격리 유지**: `schema.ts` 한 파일 + 신규 테스트만 수정. runner/compare/report 미터치.
