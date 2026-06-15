---
instance_id: django__django-14608
repo: django/django
base_commit: 7f33c1e22dbc34a7afae7967783725b10f1f13b1
version: 4.0
difficulty: <15 min fix
created_at: 2021-07-07T19:51:30Z
fail_to_pass: 4
pass_to_pass: 394
gold_files: [django/forms/formsets.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S5)
knowledge: K-Domain
flags: [regression-trap]
---

# django__django-14608

## 문제 요약
Django의 Form은 non-field 에러를 렌더링할 때 `ErrorList`에 `nonfield` CSS 클래스를 붙여준다(문서화된 "rendering form error messages" 절). 그런데 FormSet의 non-form 에러(예: `clean()` 교차검증 실패, `validate_max`/`validate_min` 초과)에는 대응되는 CSS 클래스가 없어, 커스텀 `ErrorList`가 "필드 에러 / non-field 에러(forms) / non-form 에러(FormSets)"를 렌더링 시 구분할 수 없었다. 이슈는 Form의 `nonfield` 관례와 대칭으로 FormSet의 non-form 에러에 `nonform` CSS 클래스를 추가하고 문서화해 달라고 요청한다(`#11776`와 유사).

## 유형 (정형화)

- **L0 (Pinpointed)** — 이슈가 "non form errors in FormSets" + "nonfield CSS class for non field errors" 문구로 심볼을 직접 지목한다. `non_form_errors`/`_non_form_errors` grep → `forms/formsets.py`의 `BaseFormSet.full_clean` 하나로 수렴. 약간의 탐색조차 거의 불필요한 grep 한 방.
- **S1 (Direct-Map) +S5(보조)** — 픽스는 기계적이다: 이미 존재하는 `ErrorList(error_class=...)` 생성자 시그니처에 `error_class='nonform'` 키워드 인자를 추가하는 것. Form 쪽 `nonfield` 처리가 그대로 템플릿이 되어 결함클래스가 "관례 미러링/누락 인자 추가"로 정형 매칭된다. 다만 *어떤 클래스 이름(`nonform`)인지*, *어느 출력 경로에 붙어야 하는지*는 코드만으론 안 나오고 이슈 본문/Form 대칭 관례에서 스펙을 재구성해야 하므로 S5가 보조로 붙는다(그러나 dominant는 명백히 S1 — 일단 의도를 알면 픽스 자체는 자명).
- **K-Domain** — django forms/formsets 내부 구조(`error_class` 콜러블, `ErrorList` 생성자의 `error_class` kwarg가 CSS 클래스 접미사가 된다는 것, non-form 에러가 `full_clean`에서 어떻게 채워지는지) 지식이 필요. 순수 일반 파이썬 추론으로는 `error_class='nonform'`이 `<ul class="errorlist nonform">`을 만든다는 것을 모른다.
- **primary type = T-DirectMap** — 위치가 L0로 명확하고 픽스가 S1 기계적(생성자 인자 추가)이라 "위치 명확 + 기계적 픽스" 정의에 정확히 부합. T-LocTrivial은 K-Gen을 전제하나 여기는 K-Domain이라 한 칸 위, T-SpecInference로 보기엔 의도 재구성이 본질이 아니라(이슈가 클래스 이름까지 사실상 명시) 부적합.

## 난이도 티어

**T2 (쉬움).** 공식 라벨도 `<15 min fix`로 일치한다.

이 티어로 미는 구조적 피처:
- **단일 파일·소규모**: `django/forms/formsets.py` 1파일, gold patch 2헌크/실질 2줄 변경. ICLR 컷의 "1파일·<5줄 ≈ 48% solve" 구간.
- **L0 직접 localize**: 이슈 문구가 심볼을 지목 → localize 비용 거의 0(T1~T2 신호).
- **S1 기계적 픽스**: 추론 합성 없이 알려진 생성자에 인자 추가.

T1로 안 내려가는 이유: (1) **K-Domain** — `error_class` 콜러블·`ErrorList` kwarg 의미를 알아야 하므로 순수 K-Gen이 아님. (2) **paired multi-site 내부 트랩** — `_non_form_errors`가 `full_clean` 안에서 두 군데(진입부 빈 초기화 + `ValidationError` 캐치 경로)에 대입되어, 한쪽만 고치면 FAIL_TO_PASS 일부가 안 풀린다. 단일 함수 내부지만 조율이 필요. (3) `has-repro` 부재 — 네이티브 스택트레이스 없는 기능 추가형 이슈라 T1의 "이슈가 픽스를 거의 적어줌 + repro"보다 살짝 위.

T3까지 올리지 않는 이유: 실질 constraint 추론이나 넓은 탐색이 없고, regression-trap(394 P2P)도 대부분 무관 admin_views 테스트라 픽스가 좁고 안전하다.

## 골드패치 분석

- **건드린 파일·함수**: `django/forms/formsets.py` → `BaseFormSet.full_clean`
- **근본 원인**: `full_clean()`이 `self._non_form_errors`를 생성할 때 `self.error_class()`(인자 없음)로 만들어, `ErrorList`가 기본 CSS 클래스(`errorlist`)만 갖고 non-form임을 표시하는 접미사 클래스가 없었다. Form은 non-field 에러에 `error_class='nonfield'`를 넘기는데 FormSet은 이 대칭을 빠뜨림(API-contract 비대칭).
- **수정 요지**: `_non_form_errors`가 채워지는 두 경로 모두에 `error_class='nonform'` 추가.
  1. 메서드 진입부 빈 초기화: `self._non_form_errors = self.error_class()` → `self.error_class(error_class='nonform')`
  2. `self.clean()`이 `ValidationError`를 던진 캐치 경로: `self.error_class(e.error_list)` → `self.error_class(e.error_list, error_class='nonform')`
  결과적으로 렌더링 시 `<ul class="errorlist nonform">…</ul>`가 출력된다.

## 검증 (test_patch)

FAIL_TO_PASS 4개:
- `test_formset_validate_max_flag` ("If validate_max is set and max_num is less than TOTAL_FORMS in the…")
- `test_formset_validate_min_flag` ("If validate_min is set and min_num is more than TOTAL_FORMS in the…")
- `test_non_form_errors (forms_tests.tests.test_formsets.FormsFormsetTestCase)`
- `test_non_form_errors_is_errorlist (admin_views.tests.AdminViewListEditable)`

**FAIL_TO_PASS 동작 / 픽스 증명**:
- 앞 3개는 검증 실패 formset에 대해 `str(formset.non_form_errors())`가 정확히 `'<ul class="errorlist nonform"><li>…</li></ul>'`인지 단언한다. 패치 전엔 클래스가 `errorlist`뿐이라 `nonform`이 빠져 문자열 불일치로 실패. `validate_max`/`validate_min` 경로는 진입부 초기화 헌크(1)를, 일반 `test_non_form_errors`(중복 drink 교차검증)는 `clean()`→`ValidationError` 캐치 헌크(2)를 각각 커버하므로 **두 헌크가 모두 필요**함을 테스트가 증명한다.
- admin `test_non_form_errors_is_errorlist`는 기대값을 `ErrorList(["Grace is not a Zombie"])` → `ErrorList([...], error_class='nonform')`로 바꿔, 패치 전이면 클래스 불일치로 실패하게 만든다(end-to-end 렌더링 경로 커버).

**overfit 관점**: FAIL_TO_PASS가 정확한 HTML 문자열을 단언하고, 진입부 경로와 `clean()` 캐치 경로 둘 다 독립 테스트로 잡혀 있어, "한쪽만 고치는" special-case 패치는 통과 못 한다. 따라서 overfit-risk는 낮음(`overfit-risk` 플래그 미부여).

**regression 관점(`regression-trap`)**: P2P 394개 중 다수가 admin_views 전반(URL/permission/changelist)으로 직접 무관하나, `forms_tests.tests.test_formsets`의 인접 동작(`non_form_errors() 미호출시 동작`, `test_formset_total_error_count_with_non_form_errors`, as_p/as_ul/as_table 렌더링 등)을 깨면 안 된다. `error_class` 추가는 기존 `errorlist` 클래스를 유지(접미사만 추가)하므로 순서·기존 클래스를 보존해 회귀 안전.

## 모범답안 (오라클 기반)

1. **localize 경로**: 이슈의 "nonform CSS class for non form errors in FormSets" + Form의 기존 "nonfield" 관례가 신호. `non_form_errors`/`_non_form_errors`를 grep → `django/forms/formsets.py`. 정의/대입 지점을 따라가면 `BaseFormSet.full_clean` 하나로 수렴. 동시에 `forms.py`에서 Form이 `error_class='nonfield'`를 어떻게 넘기는지를 레퍼런스로 확보(미러링 대상).

2. **픽스와 올바른 일반화**: `full_clean` 안에서 `_non_form_errors`가 채워지는 **모든** 경로에 `error_class='nonform'`을 추가 — 진입부 빈 초기화와 `clean()`의 `ValidationError` 캐치 둘 다. 이게 overfit이 아닌 올바른 일반화인 이유: non-form 에러는 "빈 상태로 초기화 후 검증 결과로 채워지는" 두 생성 지점을 가지며, 사용자에게 노출되는 출력은 양쪽 모두를 거친다. 한 곳만 고치면 클래스가 경로 의존적으로 달라지는 비일관 동작이 되므로, Form-FormSet 대칭(`nonfield`↔`nonform`)을 완성하려면 양쪽을 동일하게 미러링해야 한다.

3. **regression 안전**: `errorlist` 기본 클래스는 그대로 두고 `nonform` 접미사만 추가하므로 기존 렌더링(`as_table`/`as_ul`/`as_p`, `non_form_errors()` 미호출 동작, total-error-count)을 보존. `error_class`는 키워드 인자이므로 위치 인자(`e.error_list`)와 충돌 없음. P2P의 formset 렌더링/에러 카운트 테스트가 깨지지 않아야 함을 검증.

4. **함정 회피**: 오라클 없는 에이전트가 틀릴 지점 — (a) **두 번째 대입 지점 누락**: 진입부만 고치면 `clean()` 실패 경로(중복 drink 교차검증 `test_non_form_errors`)가 클래스 없이 남아 FAIL_TO_PASS 일부 실패. `_non_form_errors =` 대입을 함수 전체에서 grep해 paired로 적용. (b) **클래스 이름/순서 오타**: 테스트가 정확한 `<ul class="errorlist nonform">` 문자열을 비교하므로 이름은 정확히 `nonform`, 위치는 접미사여야 함(`error_class` kwarg가 `errorlist`에 공백으로 이어붙음). (c) **인자 형태 착오**: `error_class`는 키워드 인자 — 위치 인자로 넘기면 `e.error_list`와 충돌. (d) 문서화/릴리스 노트는 FAIL_TO_PASS에 안 걸리므로 코드 2줄만 정확히 잡으면 통과(문서 작업에 시간 낭비 금지).
