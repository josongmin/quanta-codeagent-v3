# L9 Audit — Platform Infra + Persistence

**Date:** 2026-05-31
**Scope:** Lane L9 (~38k TS LOC, non-test) — `src/observability` (11.3k) · `src/scheduler` (3.0k) · `src/reactor` (0.8k) · `src/remote` (1.2k) · `src/connectors` (1.6k) · `src/integrations` (2.3k) · `src/ipc` (2.2k) · `src/mcp` (3.5k) · `src/shared` (3.0k) · `src/session` (2.9k) · `src/storage` (1.9k) · `src/migration` (0.8k) · `src/git` (1.7k) · `src/voice` (1.5k) · `src/media` (0.6k)
**Lenses:** code quality, missing features, silent errors, error swallowing, 짜치는 코드, SOLID violations, **integration-boundary · durability · determinism** (이 레인의 1순위 렌즈)
**Method:** 13 슬라이스 × (객관 Round 1 + 적대 Round 2) 파이프라인 병렬 dispatch. 적대 패스는 매 Round-1 finding을 **소스 재정독으로 confirmed/overstated/false-positive 판정** + 놓친 결함 2차 발굴. 1차 실행이 서버측 session-limit 윈도우에 걸려 5개 슬라이스(reactor+remote / connectors / integrations / ipc + scheduler 적대)가 비어 **gap-fill 재실행**으로 완주. 총 72 에이전트 / ~2.5M 토큰. 모든 headline finding은 synthesis 단계에서 Claude가 `grep`/`Read`로 file:line 재실증.

## Result summary

| | count |
|---|---|
| **Confirmed CRITICAL** | **1** |
| **Confirmed HIGH** | **13** |
| Medium | 18 |
| Low / Info | 다수 (02 문서) |
| 적대 패스가 기각/강등한 오탐 | 10 |
| 잘 된 것 (positive controls) | 슬라이스별 기록 |

## Verification status legend

- **[적대-확인]** — Round 2 적대 에이전트가 인용된 코드를 재정독하여 confirmed (+ synthesis 단계 Claude spot-check)
- **[적대-신규]** — Round 1이 놓치고 Round 2 적대 패스가 발굴
- **[미배선-잠복]** — 결함은 실재하나 `grep`상 현재 production 호출처 없음. 배선되는 순간 활성화되는 지뢰

## Documents

- [01-critical-high.md](01-critical-high.md) — 1 CRITICAL + 13 HIGH, evidence/file:line/why/fix. **여기서 시작.**
- [02-medium-low.md](02-medium-low.md) — 18 medium + low/info + positive controls + cross-cutting themes.
- [03-false-positives.md](03-false-positives.md) — 적대 패스가 기각/강등한 10건 (재제기 방지).

## Top-priority fix set (highest ROI)

| # | severity | issue | file:line | 상태 |
|---|---|---|---|---|
| 1 | CRITICAL | lima 어댑터 셸 커맨드 인젝션 — `[image,...cmd].join(" ")`를 `bash -c`에 raw 보간 (docker는 argv 배열로 회피하는데 lima만 회귀) | [lima-adapter.ts:68,76](../../../../src/remote/runner/lima-adapter.ts#L68) | 적대-확인 |
| 2 | HIGH | OTel export POST에 `signal`/타임아웃 없음 → hang 1건이 `inFlight` 게이트로 전체 exporter + `teardown()` 영구 wedge | [otel-exporter.ts:397-423](../../../../src/observability/otel-exporter.ts#L397) | 적대-확인 |
| 3 | HIGH | OTel 버퍼가 죽은 collector에 무한 push (splice는 `if(ok)`만) → OOM. "batchSize가 캡한다" 주석 거짓 | [otel-exporter.ts:425-445](../../../../src/observability/otel-exporter.ts#L425) | 적대-확인 |
| 4 | HIGH | whisper.cpp stdout 미배수 → 파이프 버퍼 차면 child가 write에서 block, `child.exited` 영영 안 옴 | [local-whisper-transcriber.ts:60,164](../../../../src/voice/transcriber/local-whisper-transcriber.ts#L164) | 적대-확인 |
| 5 | HIGH | scheduler errored automation 영구 사망 (`next()`는 scheduled만 select) — **테스트가 깨진 동작 박제** → retry 계약 도달 불가 | [ticker.ts:80](../../../../src/scheduler/automation-engine/ticker.ts#L80) + [sqlite.ts:309](../../../../src/scheduler/automation-engine/sqlite.ts#L309) | 적대-확인 |
| 6 | HIGH | reactor pr-comment `repoSlug`/`prNumber` raw 보간 → `gh api` 경로 (watermark만 escape) → path/query injection | [trigger-source-pr-comment.ts:89](../../../../src/reactor/trigger-source-pr-comment.ts#L89) | 적대-신규 |
| 7 | HIGH | connectors `list()`가 `refresh()` outcome 폐기 → "서버 다운+캐시없음"이 빈 카탈로그(`[]`)와 구분 불가 | [rest-registry.ts:139-145](../../../../src/connectors/rest-registry.ts#L139) | 적대-신규 |
| 8 | HIGH | custom-3p 레지스트리 in-place write (tmp+rename 미적용) → 크래시 시 torn, `_seed` clear-then-repopulate가 영구 데이터 손실로 증폭 | [jsonl-store.ts:119-123](../../../../src/connectors/custom-3p/jsonl-store.ts#L119) | 적대-확인 |
| 9 | HIGH | webhook 멱등 `persistPath` 받지만 읽지도 쓰지도 않음 = 순수 in-memory → 재시작 시 dedup 소실, GH 재전송이 트리거 재발화 | [github/idempotency.ts:44-62](../../../../src/integrations/github/idempotency.ts#L44) | 적대-확인 |
| 10 | HIGH | dedup이 `postComment`에만 wired → `postReview`/`postReviewComment`는 retry 시 중복 POST | [github/pr-output-sink.ts:121-128](../../../../src/integrations/github/pr-output-sink.ts#L121) | 적대-확인 |
| 11 | HIGH | 양수 `timeoutMs` 무시 (docker는 `===0`만, **lima/vz는 참조 0개**) → wall-clock budget 미집행 (HELL-RR-07 위반) | [docker-adapter.ts:104](../../../../src/remote/runner/docker-adapter.ts#L104) | 적대-확인 |
| 12 | HIGH | MCP HTTP-SSE POST `signal` 없음, `close()`는 GET만 abort → POST/SSE 소켓·스트림 누수 | [http-sse.ts:184-217](../../../../src/mcp/transports/http-sse.ts#L184) | 적대-확인 |
| 13 | HIGH | STT 어댑터(deepgram/openai) 타임아웃·취소 전무 (ADR-0208 형제는 됨) → hang 연결이 호출자 영구 차단 | [media/stt/deepgram-adapter.ts:64](../../../../src/media/stt/deepgram-adapter.ts#L64) | 적대-확인 |
| 14 | HIGH | git conflict 파서 548 LOC 통째 중복 + **이미 분기** (배럴 export 쪽 소비자 0, wired는 다른 쪽) | [git/conflict-parser.ts](../../../../src/git/conflict-parser.ts) vs [tool/git/conflict-parser/parse.ts](../../../../src/tool/git/conflict-parser/parse.ts) | 적대-확인 |

## Cross-cutting themes (요약 — 상세는 02 문서)

1. **fsync 없는 "atomic" write가 슬라이스마다 재구현.** session([store.ts](../../../../src/session/store.ts#L61)/[envelope-encoder.ts](../../../../src/session/envelope-encoder.ts#L180)) · storage([atomic-write.ts](../../../../src/storage/atomic-write.ts#L71)) · migration([persistence.ts](../../../../src/migration/persistence.ts#L78)) · connectors([jsonl-store.ts](../../../../src/connectors/custom-3p/jsonl-store.ts#L119)) 전부 `Bun.write`+`rename`만, fd/dir fsync 없음. rename은 atomicity만 주고 power-loss durability는 안 줌. 메모리 `lib-swap-wheel-reinvention`가 `write-file-atomic`로 갈아탔던 그 패턴 — **공용 atomic-write 포트 하나로 통합**하면 4곳 동시 수정. (적대 패스가 "로컬 dev 툴엔 fsync 생략이 업계 표준"이라며 HIGH→MEDIUM 강등, 단 connectors는 `_seed` 증폭으로 HIGH 유지.)
2. **외부 경계 타임아웃/취소 누락.** otel(POST) · mcp(POST/GET) · STT(fetch) · connectors(rest/oauth fetch) · integrations(gh subprocess) — 모든 `fetchFn`/`run`에 `signal` 미전달. hang 하나가 호출자 영구 차단. **포트 레벨 기본 deadline 주입**이 횡단 수정.
3. **죽은 `AbortController().signal`.** reactor(ci/pr-comment) · integrations(webhook) — `new AbortController().signal`만 보관, 컨트롤러는 즉시 GC → 영원히 abort 불가. 취소 채널 있는 척하는 가짜 — 소비자가 `trigger.abortSignal`로 취소 배선하면 절대 안 fire.
4. **비-canonical 직렬화가 무결성/dedup 키를 깸.** session digest([import-export.ts:347](../../../../src/session/import-export.ts#L347)) · GH delivery fallback([github/event-payload.ts:227](../../../../src/integrations/github/event-payload.ts#L227)) 둘 다 `JSON.stringify(raw)` (키순서 의존). canonical serializer가 같은 슬라이스 안에 있는데 안 씀 → 재직렬화 프록시 통과 시 false-mismatch / dedup 실패.
5. **observability 없는 안전-방향 swallow.** scheduler load([store-jsonl.ts:259](../../../../src/scheduler/store-jsonl.ts#L259)) · connectors corrupt-row · ipc fanOut · session index-read 예외가 무관측 삼킴. 안전 방향이긴 하나 "고장"과 "비어있음"이 구분 불가.

## Coverage 정직성 고지

1차 병렬 실행이 서버 session-limit 윈도우에 걸려 5개 슬라이스가 빈 응답("resets 6:30am")을 받았고, 이를 RL-필터가 못 걸러 1차 결과에 공백으로 남았다 → gap-fill 재실행으로 전부 완주. **observability/scheduler/storage/git/voice는 적대 2-pass 완료**, gap-fill 슬라이스(reactor/remote/connectors/integrations/ipc)도 동일 2-pass를 받았으나 적대 패스가 1차와 **동일 세션 연속 실행**이라 일부 결함은 객관+적대 단일 에이전트 시각에 가깝다(적대 신규 발굴은 명시). `.js` mirror 파일은 git-ignored 빌드 산출물로 스코프 제외.
