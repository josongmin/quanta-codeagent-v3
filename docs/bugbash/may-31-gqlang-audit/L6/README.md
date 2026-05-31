# L6 Audit — LLM / Stream / Protocol / Realtime / Auth

**Date:** 2026-05-31
**Scope:** Lane L6 (~14.7k LOC, 106 non-test files) — `src/llm` + `src/stream` + `src/protocol` + `src/realtime` + `src/auth`
**Lenses:** code quality, missing features, silent errors, error swallowing, 짜치는 코드, SOLID violations, race/cancellation, security
**Method:** 10 review chunks × (Round 1 objective find → Round 2 adversarial re-find + per-finding adversarial verification) parallel pipeline. 73 agents total.

## Result summary

| | count |
|---|---|
| Confirmed objective findings (passed adversarial verify) | 38 |
| Adversarial-pass candidates (2nd-pass skeptic) | 79 |
| Documented after dedupe | 2 critical · 10 high · 14 medium · 3 low groups |

## Verification status legend

- **[확인됨]** — verifier 통과 + 본 문서 작성 중 소스 직접 재확인 (Claude 본인)
- **[검증됨]** — objective finder 보고 → adversarial verifier가 confirmed/overstated 판정
- **[적대적-미검증]** — adversarial 2-pass 단독 발견, 독립 재실행 안 됨 (일부는 synthesis 중 spot-check). **수정 착수 전 라인 재확인 필수.**

## Documents

- [01-critical-high.md](01-critical-high.md) — 2 CRITICAL + 10 HIGH, evidence/file:line/why/fix. **여기서 시작.**
- [02-medium-low.md](02-medium-low.md) — 14 medium + low cleanups + cross-cutting themes.

## Top-priority fix set (highest ROI — small fixes, real contract violations)

| # | severity | issue | file:line | 상태 |
|---|---|---|---|---|
| 1 | CRITICAL | 동시 `close()` hang (가드에 `"closing"` 누락) | [default-adapter.ts:288](../../../../src/realtime/default-adapter.ts#L288) | 확인됨 |
| 2 | CRITICAL | iterator throw 시 stream-timeout 타이머 누수 | [stream-timeout.ts:184](../../../../src/llm/stream-timeout.ts#L184) | 확인됨 |
| 3 | HIGH | Responses wire bare 콜백이 스트림 abort (systemic) | [openai-responses-wire.ts:444](../../../../src/llm/openai-responses-wire.ts#L444) | 확인됨 |
| 4 | HIGH | `finalizeCalls`가 try-catch 밖 → agent-loop 분류 깨짐 | [openai.ts:446](../../../../src/llm/adapters/openai.ts#L446) | 확인됨 |
| 5 | HIGH | OAuth refresh 빈 토큰/비검증 `expires_in` | [refresh.ts:44](../../../../src/auth/chatgpt-oauth/refresh.ts#L44) | 검증됨 |
| 6 | HIGH | Snapshot 디코더 중첩 필드 검증 전무 (DoS) | [codec.ts:100](../../../../src/protocol/session/codec.ts#L100) | 검증됨 |
| 7 | HIGH | ChatGPT-OAuth 모델 카탈로그 thundering herd | [chatgpt-oauth.ts:162](../../../../src/llm/adapters/chatgpt-oauth.ts#L162) | 검증됨 |

## Cross-cutting themes (요약 — 상세는 02 문서)

1. 관측성 없는 조직적 **error-swallowing** (~15곳) — 공유 `onError`/logger 훅 하나로 봉합
2. **bare 콜백 vs `notifyChunkArrival` 표준** 불일치 — generator 내 host 콜백 일괄 래핑
3. LLM lane 전반 **비대칭 AbortSignal 전파**
4. 프로토콜 디코더가 **presence만 검증, shape/type 미검증** (DoS surface)
5. **토큰/credential 검증 drift** (구버전 검증, chatgpt-oauth 신규 경로 누락)
6. realtime + lock의 **lifecycle idempotency/race** cluster (check-then-act, exclusive 가드 부재)
