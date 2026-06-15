---
instance_id: django__django-13315
repo: django/django
base_commit: 36bc47069ce071e80c8129500de3b8664d2058a7
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-08-17T04:24:39Z
fail_to_pass: 1
pass_to_pass: 146
gold_files: [django/forms/models.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L0
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro, underspecified]
---

# django__django-13315

## 문제 요약
ForeignKey(또는 ManyToManyField)의 `limit_choices_to`에 조인을 수반하는 `Q` 객체(또는 dict)를 넘기면, 폼 필드의 queryset에 같은 옵션이 중복으로 렌더링된다. 역참조(reverse) 1:N/M2M 조인이 매칭되는 자식 행 수만큼 부모 행을 복제(fan-out)하기 때문이다. 사용자는 각 선택지가 정확히 한 번씩만 나타나길 기대하며, 심한 경우 중복 선택지에 `.get()`을 호출하면 `MultipleObjectsReturned`로 폭발한다. 이 티켓(#11707)은 과거 `.distinct()` 기반 수정이 일부 백엔드/커스텀 모델 필드(Postgres point 타입 등)에서 비교 불가로 깨져 revert된 긴 히스토리를 가지므로, 중복 제거를 `distinct()` 없이 해결해야 한다는 암묵적 제약이 핵심이다.

## 유형 (정형화)

3축 점수:

- **L = L0 (Pinpointed).** 이슈 본문이 "limit_choices_to on a ForeignKey ... formfield"라고 결함 표면을 그대로 지목하고, `limit_choices_to`를 폼 queryset에 적용하는 지점은 `django/forms/models.py:apply_limit_choices_to_to_formfield` 하나뿐이다. `complex_filter` 또는 `limit_choices_to` grep 한 방으로 도달. 수정도 단일 함수에 갇힘.
- **S = S2 Constraint-Reasoning (+S5 Spec-Inference).** 고칠 위치는 자명하지만, **distinct를 안 쓰고 중복을 제거하는 올바른 ORM 식**을 추론으로 합성해야 한다. fan-out을 없애려면 조인을 메인 쿼리에서 빼서 상관 서브쿼리(`Exists(... filter(pk=OuterRef('pk')))`)로 옮겨야 한다는 불변식 추론이 필요하다 — 후보를 막 던지는 G&V가 아니라 "조인이 행을 복제한다 → EXISTS로 멤버십만 판정하면 복제가 사라진다"는 의미론적 추론(SemFix/Angelix 계열). S5가 보조로 붙는 이유: "distinct를 쓰지 마라"는 진짜 스펙이 코드에 없고 **이슈 코멘트 히스토리(revert 기록)에서 재구성**해야 한다. 단순히 테스트만 보면 `.distinct()`로도 통과하므로, 올바른 의도는 본문/티켓 관례에서 inference된다.
- **K = K-Domain.** `Exists`/`OuterRef`/`_base_manager`/`complex_filter`/`Q` 정규화 — 전부 django ORM·forms 내부 계약 지식이다. 일반 파이썬 추론으로는 상관 서브쿼리 관용구가 나오지 않는다.

**Primary type = T-DomainBound.** 위치는 L0로 자명하고 패치도 단일 헌크지만, 병목이 "django ORM에서 distinct 없이 fan-out을 제거하는 관용구를 아는가"에 있다. K-Domain이 dominant. T-ConstraintReason도 후보였으나, 올바른 식의 형태(Exists 상관 서브쿼리)가 일반 추론이 아니라 프레임워크 관용구 지식에서 나오므로 도메인 의존이 진짜 게이트다.

왜 이 repair strategy인가(APR 관점): 결함 위치가 단일 줄(`complex_filter(limit_choices_to)`)로 핀포인트되므로 localize-search(S3/S4) 부담이 없다. 대신 "왜 중복이 생기나"의 인과(조인 fan-out)를 모델링하고, 그것을 깨는 동치 변환(EXISTS subquery + pk 상관)을 **연역**해야 한다 — 이것이 S2 semantic synthesis의 정의다. distinct라는 더 쉬운 plausible 패치가 존재하지만 correctness가 떨어진다는 점에서 S5(스펙 재구성)이 보조로 필수.

## 난이도 티어
**Tier = T4 (약간 어려움).** 공식 라벨 "15 min - 1 hour"(T3 prior에 해당)보다 한 단계 높게 잡는다.

이 티어로 미는 구조적 피처:
- **K-Domain 게이트:** Exists/OuterRef 상관 서브쿼리는 django ORM 고유 관용구. 이게 T4의 핵심 축(루브릭 T4 = "constraint추론·소규모 refactor·도메인지식 중 하나").
- **overfit 함정이 큼(S5 필요):** 제공된 FAIL_TO_PASS 한 개는 `.distinct()` 또는 파이썬 측 dedup로도 통과한다. 즉 테스트가 올바른 일반화를 과소명세하며, 정답으로 가려면 티켓 히스토리에서 "distinct는 금지"라는 스펙을 inference해야 한다. 이 underspecification이 T3 → T4로 끌어올림.
- **넓은 P2P trap:** PASS_TO_PASS 146개가 model_forms 전체 동작(unique/m2m/onetoone/limit_choices_to 콜러블 경로 등)을 덮는다. `apply_limit_choices_to_to_formfield`는 모든 FK/M2M 폼 필드가 지나는 핫패스라, 빈 dict/Q·None·콜러블 경로를 안 깨야 하는 regression 부담이 실재한다.

T5까지 가지 않는 이유: 단일 파일·단일 함수·~10줄 헌크로 localize는 L0이며 multi-site 조율(L3)이 없다. patch scope가 작아 ICLR 2024 구조 컷 기준 "쉬운" 쪽 분포다. 난점이 scope가 아니라 도메인지식+overfit이라 T4가 적정.

## 골드패치 분석
- **건드린 파일/함수:** `django/forms/models.py` → `apply_limit_choices_to_to_formfield(formfield)` (단일 헌크).
- **근본 원인:** 기존 코드 `formfield.queryset = formfield.queryset.complex_filter(limit_choices_to)`는 `limit_choices_to`의 조인 조건을 **메인 queryset에 직접 INNER JOIN으로 합성**한다. 역참조 관계(`jokes__funny`, `jokes_today__funny`)는 1:N/M2M이므로 한 부모(Character)가 매칭되는 자식 행 수만큼 결과에 복제되어 중복 선택지가 발생한다. distinct로 누르는 과거 해법은 일부 백엔드/커스텀 필드에서 비교 불가로 revert된 바 있다.
- **수정 요지:**
  1. 함수 내부에서 `from django.db.models import Exists, OuterRef, Q` import.
  2. 빈 값 가드를 `if limit_choices_to is not None:` → `if limit_choices_to:` (truthy)로 변경 — 빈 dict/Q를 스킵해 불필요한 EXISTS 래핑 회피.
  3. `complex_filter`를 정규화: dict면 `Q(**limit_choices_to)`로 변환(`isinstance(complex_filter, Q)` 체크), 이미 Q면 그대로.
  4. `complex_filter &= Q(pk=OuterRef('pk'))`로 **바깥 행의 pk에 상관**시킴.
  5. 메인 queryset을 `formfield.queryset.filter(Exists(formfield.queryset.model._base_manager.filter(complex_filter)))`로 감쌈 — 조인을 **상관 서브쿼리로 이전**해 메인 쿼리에 fan-out을 만들지 않고 "조건을 만족하는 행이 존재하는가"만 판정. 결과적으로 distinct 없이 중복 제거. `_base_manager` 사용으로 커스텀 매니저의 추가 필터링을 우회.

## 검증 (test_patch)
- **FAIL_TO_PASS (1):** `test_limit_choices_to_no_duplicates (model_forms.tests.LimitChoicesToTests)`.
- **동작:** `tests/model_forms/models.py`에서 `StumpJoke`에 `funny = BooleanField` 추가, 역참조 관계명을 `jokes`/`jokes_today`로 부여(기존 `related_name="+"`는 역참조 불가였음 — 테스트 가능하게 변경). 테스트는 `@isolate_apps('model_forms')`로 `jokes__funny=True, jokes_today__funny=True` 조인 조건을 가진 `CharacterDetails`를 정의하되 **세 형태**로: `character1`(FK, Q), `character2`(FK, dict), `character3`(M2M, Q).
- **픽스 증명:** 한 Character(`marley`, `threepwood`)가 여러 funny joke와 연결되도록 데이터를 세팅 → 조인이 다수 매칭되어 픽스 전이면 queryset에 중복 발생. 세 필드 모두 `assertCountEqual(queryset, [self.marley, self.threepwood])`로 **정확히 한 번씩만** 나타남을 단언. dict 경로(`character2`)가 `Q(**...)` 정규화를, Q 경로가 직접 처리를, M2M 경로가 다대다 fan-out 제거를 각각 커버.
- **overfit 관점:** 이 테스트는 dict/Q/M2M 3경로를 다 검증하지만, **distinct 기반 오답도 통과시킨다** — 즉 "distinct 금지" 스펙은 테스트가 강제하지 못한다(S5/overfit-risk의 근거). 그러나 dict와 Q를 동시에 요구하므로 "Q만 처리" 같은 얕은 special-case는 잡힌다.
- **regression 관점:** PASS_TO_PASS 146개가 핫패스 `apply_limit_choices_to_to_formfield`를 지나는 모든 폼 필드 생성을 덮는다. 특히 `test_callable_called_each_time_form_is_instantiated`, `test_custom_field_with_queryset_but_no_limit_choices_to`(limit_choices_to 없음 → 가드 통과해야), `test_limit_choices_to_callable_for_fk_rel`/`_m2m_rel`(콜러블 경로)가 truthy 가드 변경과 EXISTS 래핑이 비조인/콜러블/없음 케이스를 안 깨는지 검증.

## 모범답안 (오라클 기반)

1. **Localize 경로.** 이슈의 "limit_choices_to ... formfield ... duplicate options" 문구 → `django/forms/models.py`에서 `limit_choices_to` / `complex_filter` grep → 유일 적용 지점 `apply_limit_choices_to_to_formfield`. L0이라 탐색 사실상 0. "See regressiontest in patch"라는 본문 신호로 재현 동작도 명확(has-repro).

2. **픽스와 왜 올바른 일반화인가.** 인과는 "조인 조건을 메인 queryset에 INNER JOIN으로 합성 → 1:N/M2M fan-out → 중복"이다. 올바른 일반화는 **조인을 메인 쿼리에서 분리해 상관 서브쿼리로 멤버십만 판정**하는 것: `filter(Exists(model._base_manager.filter(complex_filter & Q(pk=OuterRef('pk')))))`. 이는 어떤 limit_choices_to(dict/Q, FK/M2M, 단일/다중 조인)에도 fan-out을 만들지 않으므로 입력공간 전체에 robust하다. dict는 `Q(**...)`로 정규화해 Q/dict 양 경로를 동일 코드로 처리 — special-case가 아닌 통합. 빈 dict/Q는 truthy 가드로 스킵해 무의미한 EXISTS를 피한다.

3. **Regression 안전.** 안 깨야 할 P2P: (a) limit_choices_to가 없는 필드(`test_custom_field_with_queryset_but_no_limit_choices_to`) — `hasattr` + truthy 가드로 조기 반환되어 queryset 불변. (b) 콜러블 경로(`test_limit_choices_to_callable_for_fk_rel/_m2m_rel`, `test_callable_called_each_time...`) — `get_limit_choices_to()`가 콜러블을 풀어주므로 변경 무영향. (c) 빈 dict/Q — `is not None` → truthy 변경으로 이전엔 빈 complex_filter를 걸던 것을 스킵(동작 동등 또는 개선). 146개 핫패스 테스트가 이를 보증.

4. **함정 회피.** 오라클 없는 에이전트가 틀릴 지점:
   - **distinct 유혹:** `.complex_filter(...).distinct()`는 제공 테스트를 통과시키지만 이 티켓이 revert했던 바로 그 오답이다(Postgres 커스텀 필드 비교 불가). 회피법 = 이슈 코멘트 히스토리에서 "distinct가 깨져 revert됨 → EXISTS/annotate 대안" 맥락을 읽고 distinct를 배제(S5 스펙 재구성).
   - **dict/Q 비대칭:** Q만 처리하면 `character2`(dict) 케이스가 깨짐. `isinstance(complex_filter, Q)` 분기로 dict를 `Q(**...)` 정규화 필수.
   - **상관 누락:** `Exists` 서브쿼리에 `Q(pk=OuterRef('pk'))`를 AND하지 않으면 "조건 만족 행이 하나라도 있으면 전체 통과"가 되어 필터가 무력화된다. 바깥 행과의 pk 상관이 정확성의 핵심.
   - **빈 값 가드:** `is not None` 그대로 두면 빈 dict/Q에도 EXISTS를 걸어 불필요한 서브쿼리/잠재 버그. truthy 변경을 놓치기 쉬움.
   - **매니저 선택:** `_base_manager` 대신 기본 `objects`(`_default_manager`)를 쓰면 커스텀 매니저 필터가 limit_choices_to 판정에 끼어들 수 있음.
