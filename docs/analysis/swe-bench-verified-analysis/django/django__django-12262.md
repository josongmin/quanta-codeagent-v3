---
instance_id: django__django-12262
repo: django/django
base_commit: 69331bb851c34f05bc77e9fc24020fe6908b9cd5
version: 3.1
difficulty: 15 min - 1 hour
created_at: 2019-12-30T13:13:59Z
fail_to_pass: 4
pass_to_pass: 18
gold_files: [django/template/library.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-12262

## 문제 요약
`@register.simple_tag` / `@register.inclusion_tag`로 만든 커스텀 템플릿 태그가 keyword-only 인자(`def hello(*, greeting='hello')`)를 받을 때, 템플릿에서 그 키워드를 실제로 넘기면(`{% hello greeting='hi' %}`) `'hello' received unexpected keyword argument 'greeting'`라는 TemplateSyntaxError가 부당하게 발생한다. 사용자는 keyword-only 인자가 정상 전달되기를 기대했다. 또한 같은 키워드를 두 번 넘기면(`greeting='hi' greeting='hello'`) "multiple values for keyword argument" 대신 위의 "unexpected keyword argument" 메시지가 잘못 나온다. 이슈 본문에 최소 재현 코드와 정확한 오류 문구가 둘 다 들어 있고, 보고자가 "offending line은 2.0부터"라고 라인까지 지목했다.

## 유형 (정형화)

- **L0 (Pinpointed)** — problem_statement에 에러 문구 `received unexpected keyword argument`가 verbatim으로 있고 "offending line is from 2.0"이라고까지 명시. 이 문구를 grep하면 `django/template/library.py`의 `parse_bits` 단일 함수, 단일 라인(L264 부근)으로 즉시 수렴. 후보 탐색이 사실상 없음.
- **S2 (Constraint-Reasoning)** — 고칠 위치는 자명하나, 픽스는 "어느 집합을 기준으로 unexpected를 판정해야 하는가"라는 **불변식 추론**을 요구한다. 기존 조건 `param not in unhandled_kwargs`는 루프가 돌며 소비된 항목이 제거되는 가변 집합이라 keyword-only 인자(특히 default가 있어 `params`에 안 들어간 경우)를 표현하지 못한다. 올바른 기준은 정적 `kwonly`(getfullargspec의 kwonlyargs) 집합이라는 점을 **생각으로** 도출해야 한다. 후보를 마구 시도해 테스트로 거르는 G&V가 아니라, 두 집합의 의미 차이를 따져 한 식을 합성하는 SemFix/Angelix류라 S2.
- **K-Domain** — django template tag 인자 파싱 내부 구조(`params`/`kwonly`/`kwonly_defaults`/`unhandled_kwargs`가 함수 상단 getfullargspec에서 어떻게 파생되는지, default 유무에 따라 keyword-only 인자가 `params`에 포함되는지 여부가 갈리는 규약)를 알아야 정확한 한 줄을 고를 수 있다. 일반 파이썬 추론만으로는 두 후보 집합 중 무엇이 맞는지 확정하기 어렵다.
- **primary = T-ConstraintReason** — 위치가 명확(L0)하므로 T-DiffuseLoc 아님. 픽스가 가드/기본값/상수 교체 같은 기계적 S1 템플릿이 아니라, "unexpected 판정의 올바른 불변식"을 추론해 식을 교체하는 S2가 dominant. 그래서 T-DirectMap이 아니라 T-ConstraintReason.

## 난이도 티어
**T3 (중간).** 구조적 피처: 1파일·1함수·실질 1라인 변경(`unhandled_kwargs`→`kwonly`)이라 scope는 T1~T2급이고, `has-repro`(이슈에 재현 코드+정확한 에러 문구+라인 힌트)는 강한 easiness 신호다. 그럼에도 T2로 내리지 않는 이유는 픽스가 S1 기계적 가드가 아니라 S2 추론을 요구하기 때문이다: 정상-전달 케이스와 중복-전달 케이스라는 **두 증상이 같은 조건 분기에서 어떻게 갈리는지**, 왜 `unhandled_kwargs`(가변·소비됨)가 아니라 `kwonly`(정적)가 옳은지를 이해하지 못하면 별도 if 추가 같은 과잉 리팩터로 빠진다. 또 K-Domain(인자 파싱 내부 규약) 의존이 있다. 공식 라벨 "15 min - 1 hour"와 정합적이며, 시간라벨이 못 잡는 추론 함정(헷갈리는 인접 변수명·두 증상 동시 해소 필요)이 T2가 아닌 T3로 미는 요인이다. regression-trap은 약하지만 존재(P2P 18개가 simple/inclusion 태그의 인접 인자-검증 동작 전반).

## 골드패치 분석
- **건드린 파일·함수:** `django/template/library.py` 의 `parse_bits(parser, bits, params, varargs, varkw, defaults, kwonly, kwonly_defaults, takes_context, name)`
- **근본 원인:** kwarg를 추출한 뒤 "예상치 못한 키워드인지"를 판정하는 조건이
  `if param not in params and param not in unhandled_kwargs and varkw is None:`
  였다. `unhandled_kwargs`는 루프가 진행되며 이미 소비된 항목이 `.remove()`로 빠지는 **가변 집합**이라 "아직 안 들어온 keyword-only 인자"를 안정적으로 표현하지 못한다. 특히 default가 있는 keyword-only 인자는 `params`에도 없어, 이 조건이 참이 되어 유효한 인자를 "unexpected"로 오판한다. 같은 키워드가 두 번 들어오면 두 번째도 이 분기로 빠져, 정작 나와야 할 "multiple values" 처리에 도달하지 못하고 잘못된 메시지를 낸다.
- **수정 요지:** 두 번째 피연산자를 정적 keyword-only 집합으로 교체 —
  `if param not in params and param not in kwonly and varkw is None:`.
  `kwonly`(getfullargspec.kwonlyargs)는 default 유무와 무관하게 모든 keyword-only 인자를 담으므로, 유효한 keyword-only 인자는 더는 "unexpected"로 분류되지 않는다. 그 결과 정상 전달은 통과하고, 중복 전달 케이스는 이 분기를 빠져나가 아래쪽의 "received multiple values for keyword argument" 처리로 흘러가 올바른 메시지를 낸다. 두 증상이 한 글자 교체로 동시에 해소된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (4):** `SimpleTagTests.test_simple_tags`, `SimpleTagTests.test_simple_tag_errors`, `InclusionTagTests.test_inclusion_tags`, `InclusionTagTests.test_inclusion_tag_errors`.
- **픽스 증명:**
  - 정상 경로: `{% simple_keyword_only_default kwarg=37 %}` → `Expected result: 37` (이전엔 unexpected 예외). inclusion 쪽은 신규 태그 `inclusion_keyword_only_default(*, kwarg=42)`를 등록해 `{% ... kwarg=37 %}` → `Expected result: 37` 렌더 확인.
  - 에러 경로: `kwarg=42 kwarg=37` 동일 키워드 중복 전달 시 `received multiple values for keyword argument 'kwarg'` 메시지를, default 있는(`simple/inclusion_keyword_only_default`)·없는(`simple_keyword_only_param`) 케이스 모두에 대해 검증.
- **overfit 관점:** 테스트가 정상-전달과 중복-전달, default 유무, simple/inclusion 네 조합을 교차로 덮는다(얇지 않음). special-case 통과로는 빠져나갈 수 없어 overfit 위험 낮음 → `overfit-risk` 미표기.
- **regression 관점:** P2P 18개가 기존 인자-검증(unexpected-arg, missing-arg, positional-after-keyword, multiple-values 등)을 폭넓게 커버. `kwonly`로 바꾸되 첫 피연산자 `param not in params`를 유지해야 일반 positional/keyword 인자의 unexpected 판정이 그대로 보존된다 → `regression-trap` 표기.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈의 에러 문구 `received unexpected keyword argument`를 전역 grep → `django/template/library.py:parse_bits` 단일 분기로 직행. "offending line is from 2.0" 힌트가 keyword-only(파이썬 3 문법) 처리 누락임을 시사. 한 줄짜리 조건임을 즉시 확인(L0).
2. **픽스와 일반화 근거:** 두 번째 피연산자를 `unhandled_kwargs`(루프 중 소비되는 가변 집합)에서 `kwonly`(정적 kwonlyargs)로 교체. 이게 올바른 일반화인 이유 — keyword-only 인자는 default 유무와 무관하게 항상 `kwonly`에 있으므로 "유효한 인자인가"의 ground truth 집합이 `kwonly`다. default가 있을 때만 `params`에 빠지는 비대칭을 `kwonly` 단일 기준이 흡수한다. 특정 테스트만 통과시키는 게 아니라 keyword-only 인자 클래스 전체를 올바르게 처리.
3. **regression 안전:** 첫 조건 `param not in params`는 그대로 둬야 일반 positional/keyword 인자가 unexpected로 정상 분류된다(P2P의 `test_simple_tag_errors`/`test_inclusion_tag_errors` 기존 케이스). `varkw is None` 가드도 유지 → `**kwargs` 받는 태그는 영향 없음. 즉 교체 대상은 정확히 가운데 피연산자 하나뿐.
4. **함정 회피:** (a) `unhandled_kwargs`와 `kwonly`는 함수 상단에서 비슷하게 만들어져 변수명 혼동이 쉽다 — 가변(소비됨) vs 정적 차이를 의식해야 함. (b) 정상-전달 증상만 보고 "keyword-only면 무조건 통과시키자"고 별도 if-분기를 추가하면 중복-전달의 "multiple values" 메시지가 깨진다. 골드는 같은 분기를 빠져나가도록 두어 한 글자로 두 증상을 동시에 해결하는 **최소 변경**임을 인지해야 과잉 리팩터를 피한다. (c) `kwonly_defaults`를 끌어와 default 있는 것만 따로 처리하려는 충동도 불필요 — `kwonly` 단일 집합이 default 유무를 모두 포괄한다.
