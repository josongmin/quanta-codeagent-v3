---
instance_id: pytest-dev__pytest-7324
repo: pytest-dev/pytest
base_commit: 19ad5889353c7f5f2b65cc2acd346b7a9e95dfcd
version: "5.4"
difficulty: "15 min - 1 hour"
created_at: 2020-06-05T13:00:07Z
fail_to_pass: 3
pass_to_pass: 58
gold_files: [src/_pytest/mark/expression.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

## 문제 요약

`-k`/`-m` match expression 컴파일러는 식별자 토큰을 그대로 `ast.Name`으로 변환한다. 그런데 `True`/`False`/`None`은 합법적인 match expression 식별자지만 CPython의 합법 식별자가 아니다. 그래서 `Expression.compile("False")`가 만든 AST를 `compile()`하면 debug build CPython 3.8+에서 `compiler_nameop`의 assertion이 깨지며 인터프리터가 abort(core dump)한다. release build에선 조용히 잘못된 동작이 된다.

## 유형 (정형화)

- **L (Localization) = L1**: 스택트레이스가 `Python/compile.c:compiler_nameop`을 가리키지만 그건 CPython 내부다. 픽스 지점은 "match expression → AST" 변환부, 즉 `src/_pytest/mark/expression.py`의 `not_expr`(`ast.Name` 생성)로 키워드+레포 구조로 좁게 수렴한다. 단일 파일, 약간의 탐색.
- **S (Repair Strategy) = S2 (+S6)**: 고칠 지점(`ast.Name(ident.value, ...)`)은 명백하나, "예약어 충돌을 어떻게 우회할 것인가"라는 올바른 식을 추론·합성해야 한다. 골드는 모든 식별자에 sentinel 프리픽스 `$`를 붙이는 불변식을 도입하고(`IDENT_PREFIX`), `MatcherAdapter.__getitem__`에서 그 프리픽스를 다시 떼는 **양쪽 조율 변경**(S6 성격)을 한다. 단순 가드 추가가 아니라 인코딩 규약을 설계하는 추론이라 S1이 아니다.
- **K (Knowledge) = K-Domain**: CPython이 `True/False/None`을 `ast.Name`으로 컴파일하는 걸 금지한다는 internals 지식과, pytest의 expression 평가가 `eval` + `MatcherAdapter` locals 매핑으로 돈다는 내부 구조 지식이 필요하다.
- **primary type = T-ConstraintReason**: 위치는 좁게 잡히고, 핵심 난점은 "예약어가 아닌 식별자 공간으로 매핑"이라는 올바른 불변식을 추론으로 합성하는 데 있다.

## 난이도 티어

**T3 (중간)**. 구조 피처: 1파일, 실질 변경 3헌크(상수 도입 + `ast.Name` 생성부 + adapter 역변환)로 ~6줄. has-repro(네이티브 assertion 스택)가 강한 easiness 신호다. 그러나 localize는 L0가 아니고(스택이 CPython 내부를 가리켜 한 단계 매핑이 필요), 픽스는 S1 템플릿이 아니라 프리픽스 인코딩 규약을 만들고 생성·소비 두 지점을 함께 맞춰야 하는 S2/S6다. 또 hints의 "타입별 `ast.Constant` 분기" 같은 더 무거운 대안 대신 균일 프리픽스를 골라야 일반화가 깔끔하다. 공식 라벨 "15분~1시간"과 일치하며, 추론 강도와 양면 조율 때문에 T2가 아닌 T3로 둔다.

## 골드패치 분석

- **파일**: `src/_pytest/mark/expression.py`
- **건드린 심볼**: 모듈 상수 `IDENT_PREFIX = "$"` 신설, `not_expr()` 내 `ast.Name(ident.value, ast.Load())` → `ast.Name(IDENT_PREFIX + ident.value, ...)`, `MatcherAdapter.__getitem__()`의 `self.matcher(key)` → `self.matcher(key[len(IDENT_PREFIX):])`.
- **근본 원인**: match expression 식별자를 Python 식별자로 그대로 사용. `True/False/None`은 match 문법상 합법이나 CPython이 이를 `ast.Name`으로 컴파일하는 걸 금지(debug build assert).
- **수정 요지**: 모든 식별자에 Python 식별자로는 합법이지만 예약어와 절대 충돌하지 않는 sentinel 문자 `$`를 프리픽스로 붙여 컴파일하고, 평가 시 `MatcherAdapter`가 locals 키 조회에서 프리픽스를 떼어 원래 식별자로 매처에 넘긴다. 인코딩/디코딩이 정확히 대칭이라 사용자 관점 의미는 불변.

## 검증 (test_patch)

- **FAIL_TO_PASS (3)**: `test_valid_idents[True]`, `test_valid_idents[False]`, `test_valid_idents[None]`. test_patch는 `test_syntax_errors`의 거부 식별자 목록에 `"None"`을 추가하고, `test_valid_idents` 파라미터화가 `True/False/None`을 합법 식별자로 평가하도록 한다. 픽스 전엔 이 셋이 컴파일 시 abort/오류, 픽스 후엔 일반 식별자로 정상 평가된다.
- **픽스 증명**: 프리픽스 도입으로 `True`→`$True`(합법 Python Name)로 컴파일되어 assert를 우회하고, adapter가 `$`를 떼어 매처에 `"True"`를 그대로 전달 → 의미 보존.
- **overfit/regression 관점**: FAIL_TO_PASS는 얇지만(3) PASS_TO_PASS가 59개로 두껍다 — 유니코드 식별자(`א...`), `1234and`, `not_and_or`, `a[bcd]`, `$` 자체를 invalid로 보는 케이스 등 식별자 공간 전반을 커버해 프리픽스가 다른 식별자 의미를 깨지 않음을 강하게 검증한다. 그래서 `regression-trap` 플래그. special-case(`if name in (...)`) 분기로도 FAIL_TO_PASS는 통과하나, 균일 프리픽스가 더 일반적이고 P2P가 그 일반성을 강제한다.

## 모범답안 (오라클 기반)

1. **localize**: 스택의 `compiler_nameop` assert는 CPython이 `True/False/None`을 `ast.Name`으로 만드는 걸 금지함을 뜻한다. "어디서 `ast.Name`을 사용자 토큰으로 만드나"를 레포에서 찾으면 `expression.py`의 `not_expr` → `ast.Name(ident.value, ...)` 한 곳으로 수렴.
2. **픽스 / 일반화 근거**: 충돌하는 세 키워드만 특수 분기하는 대신, 모든 식별자에 예약어와 불가능한 sentinel `$`를 붙여 식별자 namespace 전체를 안전 영역으로 옮긴다. 생성부(`not_expr`)와 소비부(`MatcherAdapter.__getitem__`)를 대칭으로 맞추면 사용자 의미 불변. 이게 special-case보다 올바른 일반화인 이유: 미래에 추가될 어떤 예약어/엣지에도 견고하고, 변환이 전역 균일이라 추론 부담이 한 규약으로 끝난다.
3. **regression 안전**: 59개 P2P가 invariant. 특히 (a) 유니코드/숫자/괄호 포함 식별자가 그대로 매처에 도달해야 하고(adapter slice가 정확히 `len(IDENT_PREFIX)`만 떼야 함), (b) `$`를 invalid ident로 거부하는 케이스, (c) `not/and/or` 연산자가 식별자로 오인되지 않아야 함. adapter에서 프리픽스 길이를 하드코딩하지 말고 `len(IDENT_PREFIX)`로 묶어 생성·소비 일관성을 보장하는 게 핵심.
4. **함정 회피**: (1) hints처럼 `True/False/None`만 `ast.Constant`/`NameConstant`로 특수 분기하면 FAIL_TO_PASS는 통과하나 코드가 버전 분기로 지저분해지고 빈 식(`expression()`의 `ast.NameConstant(False)`)과 일관성이 갈린다 — 균일 프리픽스가 더 깔끔. (2) 생성부만 고치고 `MatcherAdapter.__getitem__` 역변환을 빠뜨리면 매처가 `$foo`를 받아 모든 매칭이 깨진다(P2P 대량 실패) — 양면 조율이 필수. (3) 프리픽스로 `_` 등 합법 식별자 문자를 쓰면 실제 식별자와 충돌 가능 — `$`처럼 Python 식별자에 등장 불가한 문자를 골라야 sentinel이 성립.
