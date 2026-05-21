# ADR-0061: rememberPatterns — 권한 패턴 학습 + cascade 자동해소 (v0.dev 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: ADR-0029(3-tier reviewer + 8-state ApprovalOutcome), ADR-0020(HITL 4-tier), `v0-dev-feature-review.md` §S급-7(권한 학습). v0.dev anon 크롤.

## 맥락

v0.dev 번들에서 권한 학습 메커니즘이 노출됐다. 모델이 필요 권한을 직접 제안(`suggestedPermissions`)하고 위험을 자가표시(`isMaybeDangerous`)하며, 핵심은 cascade 필터(번들 verbatim):

```js
filter(t => t.id!==excludeId && !resolved[t.id]
         && t.rememberPatterns.length>0
         && t.rememberPatterns.every(p => allowedPatterns.has(p)))
```

즉 "패턴 허용" 1회 → **대기 중인 모든 다른 tool 요청을 재평가**해 rememberPatterns가 전부 allowed 집합에 포함된 것을 자동 해소. 단순 "기억"이 아니라 **큐 전파(cascade)**가 본질이다. v3의 `user_approved_for_session`(ADR-0029)은 actionKey 단위 기억까지는 있으나 패턴-단위 + cascade는 없었다.

## 결정

신규 순수 모듈 `src/permission/remember-patterns.ts`:

- `PendingPermission { toolCallId, rememberPatterns, suggestedPermissions, isMaybeDangerous }`.
- `autoResolvable({ allowedPatterns, pending, excludeToolCallId?, alreadyResolved })`: v0 필터 미러 — 자동 통과 가능한 pending 반환. `rememberPatterns.length === 0`이면 절대 자동통과 안 함.
- `grantPatterns(allowed, patterns)`: 순수 합집합(새 Set 반환).
- `PatternGrantStore`: 세션 allowed-pattern 집합 보유 — `grant`/`isCovered`/`cascade(pending, justResolvedId)`.
- **v0 대비 하드닝**: `isMaybeDangerous` 요청은 패턴이 모두 covered여도 명시적 `allowDangerous` 없이는 자동해소 제외(코드 주석에 명기).

default-OFF: 기존 admissibility-gate 배선은 follow-up.

## 근거

- **cascade가 ROI의 핵심**: 매 tool마다 confirm을 묻는 마찰을, "한 번 허용 → 동류 미래 요청 무마찰"로 줄인다. UX 이득의 대부분이 큐 전파에서 나온다.
- **`isMaybeDangerous` 하드닝**: v0는 패턴만 맞으면 통과시키지만, 위험 자가표시 요청까지 자동통과시키면 학습이 보안 구멍이 된다. 명시 opt-in으로 fail-safe.
- **순수 모듈, 슬라이스 격리**: `@/permission`은 `@/llm`/`@/agent` 미import. clock/IO 0 — 결정론 테스트.
- **기존 8-state와 보완**: `user_approved_for_session`(actionKey 기억)의 상위 레이어 — actionKey가 아닌 named pattern으로 더 일반화.

## 대안

- **actionKey 단위만(기존 `user_approved_for_session`)**: 기각 — 구조적으로 동일한 invocation만 기억, 패턴(예: "write under src/")의 일반화 불가.
- **cascade 없이 단순 기억**: 기각 — 대기 큐 전파가 UX 이득의 본체. 빠짐.
- **`isMaybeDangerous`도 자동통과(v0 그대로)**: 기각 — 학습이 위험 행위 무마찰 통과로 악화.

## 결과·트레이드오프

- **얻은 것**: 패턴-단위 권한 학습 + cascade seam, 위험 하드닝. 15 unit green. tsc/biome clean.
- **비용**: admissibility-gate 미배선 — 현재는 opt-in 모듈(즉시 채택 가능, 기존 동작 0 변경).

## 한계 (LIMITATIONS)

- (a) admissibility-gate(`reviewAction`)에 `PatternGrantStore` 세션 주입 + cascade 호출은 `// TODO` follow-up.
- (b) `suggestedPermissions`/`rememberPatterns`/`isMaybeDangerous`를 모델이 실제 산출하려면 도구 스키마/프롬프트 측 노출 필요 — 별도 작업.
- (c) 패턴 문자열의 의미론(glob? prefix?)은 호출자 책임 — 모듈은 set 멤버십만 본다.

## 불변식 영향

- **byte-identical default**: 모듈 미배선 시 기존 권한 경로 무변경.
- **슬라이스 격리 유지**: `@/permission`은 상향 import 0.
- **신규 npm dep 0**.
- **fail-safe**: 위험 자가표시 요청은 명시 opt-in 없이 자동통과 불가.
