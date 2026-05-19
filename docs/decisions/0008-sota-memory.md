# ADR-0008: SOTA++ 계층형 시맨틱 메모리

- **상태**: Accepted
- **날짜**: 2026-05-19
- **관련**: RFC-0001 §6.3(메모리), §3.1(슬라이스 격리), §12(위험표: "v2 마인드셋 재발" anti-bloat), §9.2(외부 시스템 통합 = ADR 트리거), ADR-0001(Biome 슬라이스 격리), ADR-0004(프롬프트 캐시)

## 결정

영속 메모리를 lexical 단일 테이블에서 **계층형 시맨틱 메모리**로 교체한다.
`tier`(`episodic`/`semantic`) + `kind`(`fact|decision|observation|preference`),
OpenAI `text-embedding-3-small`(1536d) 임베딩을 Float32 BLOB(sqlite)로 저장하고
코사인 유사도를 쓴다. 회상은 하이브리드 가중 합(`ranking.ts`): 벡터(지배항)
+ 텍스트 부분일치 + 태그 + freshness + importance + 접근 강화. **텍스트는
하드 필터에서 점수 항으로 강등**(태그만 하드 필터 유지). 세션 종료 시
raw 최종-텍스트 덤프 대신 `distillSession`이 LLM으로 구조화 레코드를 추출,
`findNearDuplicates`(코사인 OR 토큰-Jaccard) + LLM 중재
`arbitrateConsolidation`(`insert|skip|merge|supersede`)로 중복을 정리하고,
`planEviction`이 tier 정원·superseded 만료·archived 감쇠를 계획한다.
에이전트는 `memory_search/write/update` self-edit 도구로 자기 메모리를 수정한다.

슬라이스 격리는 유지: `src/memory/**`는 `@/llm`을 import하지 않는다(Biome 강제).
memory는 주입식 `EmbedderPort` 인터페이스만 소유하고, OpenAI 구현과 모든
LLM 주도 지능(임베딩·distill·consolidate)은 `@/agent`(유일 교차 슬라이스
importer)에 둔다. memory는 순수 저장+랭킹+벡터수학으로 남는다. 신규 npm
의존성 0 — 임베딩은 기존 `openai` SDK, 벡터 저장은 내장 `bun:sqlite` 재사용.

## 배경

종전 lexical-only 저장의 한계: (1) `query.text`가 하드 substring 필터라
paraphrase된 회상이 통째로 누락, (2) 세션 종료 시 최종 어시스턴트 텍스트를
그대로 1행 덤프 — 신호 대 잡음이 낮고 검색성 없음, (3) dedup 부재로 동일
지식이 세션마다 중복 적재. RFC §6.3 메모리는 "풀 구현"으로 표기됐으나 실제
회상 품질은 SOTA와 거리가 멀었다.

## 근거

- 벡터 임베딩 + 하이브리드 랭킹이 paraphrase-robust 회상의 표준이며, 텍스트
  miss가 벡터 hit를 죽이지 않게 텍스트를 점수 항으로 내린 것이 핵심 수정.
- distill/consolidate를 LLM에 맡기되 실패 시 휴리스틱으로 graceful degrade —
  메모리 영속은 advisory, 세션을 절대 깨지 않는다(`persistSession`은 throw 불가).
- `EmbedderPort` 주입으로 RFC §3.1 의존성 방향(memory↛@/llm)을 깨지 않고
  지능을 agent 슬라이스에 격리 → Biome override 무수정, 격리 계약 보존.
- 신규 엔트리 필드는 전부 optional, store 경계 `normalizeEntry`에서 정규화,
  sqlite는 open 시 레거시 컬럼 자동 ALTER → 구 행·구 호출자 무영향.

## 트레이드오프

- **얻은 것**: paraphrase-robust 회상, 잡음 제거된 구조화 지식, 중복 억제,
  tier별 수명 관리, 에이전트 self-edit. 격리·동작 보존 무손상. 후속 심화:
  tier가 회상 랭킹에 실제 작용(W_TIER=2, semantic>episodic — 초기 구현의
  "계층형 회상이 저장/eviction 한정"이던 빵꾸 해소), `memory_search`
  tier/kind/minImportance 필터, `memory.recallTiers` 제한, 그리고 메모리
  파이프라인 전구간 관측성(`AgentRecorder` memory.* 카운터, 반환형을 깨지
  않는 `onStats` 옵저버 시임).
- **잃은 것 / 비용**: 본 슬라이스는 RFC §12 anti-bloat 에토스("v2 마인드셋
  재발")를 **사용자의 명시적 지시로 의도적 override** — ROI 무관 SOTA++.
  LoC·이동 부품 증가, 임베딩의 네트워크·과금 의존, 세션 종료 시 distill/
  consolidate LLM 호출 비용. **완화**: 신규 dep 0, 전부 env-gated 기본 OFF,
  store/embedder 부재 시 루프 byte-for-byte 불변, 순수 결정론 코어
  (ranking/eviction/dedup/vector), 임베딩·LLM 실패는 lexical로 자동 강등,
  풀 테스트 피라미드.

## 대안

- **로컬 해싱 임베딩**(의존성 0): 과금·네트워크 없음. 기각 — 의미 표현력이
  낮아 paraphrase 회상 품질이 lexical 대비 유의미하게 개선되지 않음.
- **전용 vector DB 의존성 추가**(예: sqlite-vec/Chroma): ANN 인덱스. 기각 —
  RFC §12 "의존성 폭증" 위반, 현 규모(tier 정원 수백)에선 in-process 코사인
  full-scan으로 충분, 신규 dep 0 원칙 우선.

## 검증

- 코드 동작 후 작성(RFC §9.1): `tsc` 0, Biome 게이트 0·경고 0(슬라이스 격리
  포함), **523 테스트 통과**. 회상/eviction/dedup/벡터 수학·tier 가중은 결정론
  단위 테스트, distill/consolidate/embedder·`onStats`·메트릭은 fake 주입
  통합 테스트로 검증.
- 상세 아키텍처: RFC §6.3. 캐시 프리픽스 상호작용: ADR-0004.
