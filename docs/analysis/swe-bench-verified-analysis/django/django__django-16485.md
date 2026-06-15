---
instance_id: django__django-16485
repo: django/django
base_commit: 39f83765e12b0e5d260b7939fc3fe281d879b279
version: 5.0
difficulty: 15 min - 1 hour
created_at: 2023-01-18T22:03:52Z
fail_to_pass: 1
pass_to_pass: 9
gold_files: [django/template/defaultfilters.py]
primary_type: T-ConstraintReason
tier: T2
loc_axis: L0
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [regression-trap, has-repro]
---

# django__django-16485

## 문제 요약
템플릿 필터 `floatformat()`이 정밀도 인자 `0`과 함께 `"0.00"`(또는 `Decimal("0.00")`)을 받으면 크래시한다. 두 호출 모두 `ValueError: valid range for prec is [1, MAX_PREC]`를 던진다. 사용자는 `floatformat("0.00", 0)`이 정상적으로 `"0"`을 반환하기를 기대했다. `problem_statement`에 실행 가능한 4줄 재현 스니펫(import + 두 번의 크래시 호출)이 포함되어 있고, hints는 알파 릴리즈 회귀임을 명시하며 유입 커밋(`08c5a787262c1ae57f6517d4574b54a5fcaad124`)까지 지목한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** 이슈 본문이 `floatformat`을 심볼 단위로 직접 명시하고, 에러 메시지 `valid range for prec is [1, MAX_PREC]`는 Decimal `Context(prec=...)` 시그니처라 `django/template/defaultfilters.py`의 `floatformat` 단일 함수로 grep 한 방에 수렴한다. 후보 탐색 사실상 0. 게다가 회귀 커밋 SHA가 hints에 박혀 있어 `git blame`/`git show`로 변경 지점을 곧장 짚을 수 있다.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S1).** 고칠 *지점*(0-값 단축 가드 `if not m and p < 0:`)은 자명하지만, 올바른 *경계 조건*을 추론으로 합성해야 한다. `m`(가수 유무)·`p`(소수 자릿수)의 의미와 Decimal prec 하한(≥1)이라는 불변식을 따져 "`< 0`을 `<= 0`으로 넓혀야 `p == 0` 케이스가 정수 경로로 빠진다"를 도출하는 것이 핵심이다. 최종 픽스가 한 글자(`<` → `<=`)라 외형은 S1 템플릿(off-by-one 경계 수정)이지만, 그 글자가 옳은 이유는 엣지케이스/불변식 추론이라 dominant는 S2이고 결과 형태가 S1을 보조한다.
- **K (Knowledge) = K-Domain.** Python decimal 모듈의 `Context(prec)` 하한 제약을 알아야 하고(여기까진 K-Gen 경계), 더 본질적으로 django의 `floatformat` 내부 알고리즘(가수 `m` 분해 → 정수 단축 경로 vs Decimal 양자화 경로 분기)을 읽어야 "왜 이 분기에서 빠져나가야 하는지"가 보인다. 따라서 일반 Python 추론만으로는 부족, 프레임워크 내부 동작 이해가 필요해 K-Domain.
- **Primary type = T-ConstraintReason.** 위치는 명확(L0)하나 픽스 정당성이 경계 조건 추론(S2)에 달려 있어 T-ConstraintReason. T-DirectMap이 아닌 이유: 이슈가 "`<=`로 바꿔라"를 명세하지 않으며, `try/except`로 ValueError를 삼키는 등 plausible-but-wrong 대안이 존재해 기계적 매핑이 아니다.

## 난이도 티어
**T2 (쉬움).** 이 티어로 미는 구조적 피처:
- **수정 범위 극소** — 1파일·1함수·1줄(한 글자) 변경. ICLR 2024 컷에서 1파일·<5줄 ≈ 48% solve 구간.
- **localize 직접성 최상(L0)** — 심볼 직접 명시 + prec 에러 메시지 + 회귀 커밋 SHA. 탐색 노력 거의 없음.
- **has-repro** — 실행 가능한 4줄 재현 스니펫 존재(가장 강한 easiness 신호, 해결률 ~87%).
- 티어를 T1로 내리지 않은 이유: 이슈가 픽스(`<=`)를 적어주지 않고, 경계 조건의 옳음을 `m`/`p` 의미로 논증해야 하는 약한 추론(S2)이 끼어 있으며, `regression-trap`(아래)이 잠재한다. 순수 S1·픽스자명(T1)보다 한 칸 위.
- **공식 difficulty 라벨(15분-1시간)과의 관계:** 공식 라벨이 T2(쉬움)보다 다소 높아 보이나, 라벨은 "개발자 구현시간"이고 여기엔 *회귀 원인 디버깅*(어느 분기에서 prec=0이 새는지 역추적)이 포함돼 시간이 붙은 것이다. 에이전트 관점에선 localize가 공짜(L0+repro)라 실제 난이도는 T2가 더 정확하다. 시간라벨이 못 잡는 것은 localize 비용인데, 이 케이스는 그게 0에 가깝다.

## 골드패치 분석
- **건드린 파일·함수:** `django/template/defaultfilters.py` 의 `floatformat(text, arg=-1)`.
- **근본 원인:** 값이 0(`not m`, 즉 정규화된 가수가 비어 있음)이고 정밀도 `p`가 `0`일 때, 정수 단축 경로(`mark_safe(formats.number_format("%d" % int(d), ...))`)로 빠지지 못하고 아래의 Decimal 양자화 경로로 흘러가 `prec`이 `p`(=0)로 설정된 컨텍스트 연산을 호출한다. Python decimal의 prec 유효범위는 `[1, MAX_PREC]`라 `p=0`에서 `ValueError`가 발생한다. 기존 가드 `if not m and p < 0:`는 `p < 0`만 단축 처리하고 `p == 0` 경계를 빠뜨린 off-by-one이다(회귀 커밋 `08c5a78`에서 이 가드가 도입되며 `<=`가 아닌 `<`로 잘못 들어감).
- **수정 요지:** 단축 가드 조건을 `if not m and p < 0:` → `if not m and p <= 0:`로 한 글자 변경. 이제 값이 0이고 정밀도가 0 이하면 정수 포맷 경로로 빠져나가 prec 위반 Decimal 연산을 아예 타지 않고 `"0"`을 반환한다. 가드가 여전히 `not m`(값=0)으로 게이트돼 있어, 0이 아닌 값의 `p=0` 처리(반올림 동작)에는 영향이 없다.

## 검증 (test_patch)
- **FAIL_TO_PASS 동작:** `test_zero_values` (`template_tests.filter_tests.test_floatformat.FunctionTests`). 이 테스트는 `floatformat`의 0-값 처리 전반을 검증하며, 패치로 두 단언이 추가된다: `floatformat("0.00", 0) == "0"`, `floatformat(Decimal("0.00"), 0) == "0"`.
- **픽스 증명:** 패치 전에는 두 호출이 `ValueError`로 크래시 → 테스트 RED. 패치 후 `p <= 0` 가드가 정수 경로로 보내 `"0"`을 반환 → GREEN. 문자열 입력과 Decimal 입력을 둘 다 단언해 입력 타입(str 파싱 경로 vs 네이티브 Decimal 경로) 무관하게 동작함을 보장한다.
- **overfit 관점:** FAIL_TO_PASS가 단일 테스트(2 단언)로 다소 얇아 표면적으론 `overfit-risk` 후보이나, 추가 단언이 str·Decimal 두 입력 경로를 동시에 커버하고 골드 픽스가 special-case가 아닌 가드 경계 일반화라 실질 overfit 위험은 낮다(그래서 `overfit-risk` 플래그는 달지 않음). `try/except`로 ValueError를 삼키는 plausible 패치는 `"0"` 대신 다른 값을 내거나 다른 prec 케이스를 망쳐 이 테스트 또는 P2P에서 걸린다.
- **regression 관점(regression-trap):** PASS_TO_PASS 9개에 `test_negative_zero_values`, `test_floatformat01/02`, `test_inputs`, `test_force_grouping`, `test_infinity` 등 인접 포맷팅 동작이 광범위하게 들어 있다. 가드를 `not m` 없이 넓히거나 `p == 0`을 무조건 단축하면 음수 0·일반 반올림·grouping이 깨져 P2P가 RED가 된다. 골드의 `not m && p <= 0` 이중 게이트가 이 trap을 피하는 정확한 경계다.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈가 `floatformat`을 직접 명시 + 스택의 `ValueError: valid range for prec is [1, MAX_PREC]`는 Python decimal `Context(prec=...)` 시그니처 → `django/template/defaultfilters.py`의 `floatformat(text, arg=-1)` 단일 함수로 즉시 수렴. hints의 회귀 커밋 `08c5a78`을 `git show`하면 0-값 단축 가드 `if not m and p < 0:`가 그 커밋에서 들어온 것이 드러나 변경 지점이 못박힌다.
2. **픽스(왜 올바른 일반화인가):** 가드 조건을 `p < 0` → `p <= 0`으로 넓혀 값이 0(`not m`)이고 정밀도가 0 이하인 경우를 정수 포맷 경로로 보낸다. 이게 special-case 회피(예: `try/except`로 prec=0만 땜질)가 아닌 이유: `p == 0`은 "0을 0자리로 포맷 = 정수 `0`"이라는 기존 정수 경로의 의미와 정확히 일치한다. 즉 `< 0`이 처음부터 `<= 0`이어야 했던 경계의 자연스러운 확장이며, prec 하한(≥1) 불변식을 만족시키는 가장 좁은 정당한 수정이다.
3. **regression 안전:** 가드가 `not m`(값이 정확히 0)으로 게이트되므로 0이 아닌 값의 `p=0` 반올림은 건드리지 않는다. PASS_TO_PASS의 `test_negative_zero_values`(음수 0), `test_floatformat01/02`·`test_inputs`(일반 포맷), `test_force_grouping`(자릿수 그룹화), `test_infinity`가 모두 보존됨을 확인해야 한다. `not m` 게이트를 빼거나 `p == 0` 전체를 단축하면 이들이 깨진다.
4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (a) ValueError를 `try/except`로 삼키는 방어적 패치: 출력이 `"0"`이 아니거나 다른 prec 케이스를 가려 잘못된 동작을 낳음. (b) `m`/`p` 의미 오독: `p`를 "값"으로 착각해 0이 아닌 입력의 `p=0`까지 단축시켜 회귀 유발. (c) 가드를 함수 위쪽 다른 분기에 추가해 중복/모순 처리. 회피법: 골드처럼 *기존 단축 가드의 경계만* `<=`로 넓히고, `not m` 값=0 게이트가 유지되는지 확인하는 최소 수정에 집중한다.
