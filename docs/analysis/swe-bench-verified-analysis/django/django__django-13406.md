---
instance_id: django__django-13406
repo: django/django
base_commit: 84609b3205905097d7d3038d32e6101f012c0619
version: 3.2
difficulty: <15 min fix
created_at: 2020-09-10T12:38:11Z
fail_to_pass: 3
pass_to_pass: 32
gold_files: [django/db/models/query.py]
primary_type: T-DomainBound
tier: T4
loc_axis: L1
repair_strategy: S2 (+S1)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-13406

## 문제 요약
`values()`/`values_list()` + `annotate()`(GROUP BY)로 만든 쿼리셋의 `queryset.query`를 pickle했다가, 새로 만든 `Model.objects.all()`에 `.query`로 다시 할당하면 결과가 깨진다. 정상이라면 dict 리스트를 돌려줘야 하는데 모델 인스턴스를 반환하고, 그 인스턴스는 내부 상태가 망가져 `.pk` 접근 시 `AttributeError: 'NoneType' object has no attribute 'attname'`로 크래시한다. 사용자는 문서화된 query pickling 패턴(`#pickling-querysets`)을 그대로 따랐는데 결과 타입이 dict가 아니라 모델로 나오는 게 문제였다. 이슈에는 완전한 재현 코드와 네이티브 스택트레이스가 포함되어 있고, hints에서 메인테이너(Mariusz)가 정확한 골드패치 diff까지 제시했다.

## 유형 (정형화)

**L (Localization) = L1 (Traceable).** 직접 심볼 지목은 아니다. 스택트레이스의 마지막 프레임은 `base.py::_get_pk_val` → `query_utils.py::_check_parent_chain`/`attname`으로, 표면적으로는 모델 메타 쪽을 가리켜 오도(misdirection)한다. 진짜 진입점인 `QuerySet.query` setter는 트레이스에 안 나온다. 다만 hints가 `_iterable_class`가 pickle되지 않는다는 근본원인과 `query` setter라는 단일 진입점을 명시하므로 좁은 단일파일(`query.py`)로 수렴 가능 — grep 한 방(L0)은 아니고 약간의 탐색(증상 재정의)이 필요해 L1.

**S (Repair Strategy) = S2 Constraint-Reasoning (+S1).** 고칠 위치(`query` setter)는 hints로 거의 주어졌지만, 올바른 픽스는 "복원된 `query`의 모양(values 계열인지)을 보고 그에 맞는 이터러블 클래스를 합성"하는 의미적 추론이다. `value.values_select`가 비어있지 않다는 불변식으로 values 쿼리를 식별하고, `values_list`의 세 전용 이터러블은 query만으로 구분 불가하므로 `ValuesIterable`로 환원하는 "의도된 손실"을 받아들여야 한다 — 어떤 조건/타입이 올바른지를 따져야 하므로 S2가 dominant. 일단 위치를 알면 두 줄 가드 추가라는 기계적 형태(S1)도 보조로 깔린다.

**K (Knowledge) = K-Domain.** django ORM 내부 지식이 병목이다. `_iterable_class`가 `QuerySet`의 속성이지 `Query`의 속성이 아니라는 점, `ValuesIterable`/`ModelIterable`/`ValuesListIterable`/`FlatValuesListIterable`/`NamedValuesListIterable`의 역할 분담, `query.values_select`가 values 쿼리를 가리키는 신호라는 것 — 전부 ORM iteration 파이프라인 도메인지식이다. 일반 파이썬 추론만으론 "왜 dict 대신 모델이 나오는지"를 못 짚는다.

**Primary type = T-DomainBound.** L1이라 localize가 진짜 어려움(T-DiffuseLoc)은 아니고, hints가 픽스를 거의 적어줘 순수 S2 추론합성(T-ConstraintReason)이 핵심도 아니다. 병목은 "ORM의 iterable-class와 query의 직렬화 경계를 이해해야 증상을 올바르게 재정의할 수 있다"는 프레임워크 내부지식 — K-Domain이 dominant하므로 T-DomainBound.

## 난이도 티어
**Tier = T4 (약간 어려움).** 공식 라벨은 `<15 min fix`(개발자 시간 기준 최저)이고 패치는 단 2줄/1파일이라 scope만 보면 T1~T2다. 그러나 공식 라벨은 "픽스를 이미 이해한 개발자의 구현시간"이라 에이전트 난이도의 두 축 — localize 오도와 도메인지식 — 을 못 잡는다. T4로 미는 구조적 피처:
- **오도하는 트레이스(L1):** 스택트레이스가 `base.py`/`query_utils.py`의 `attname`을 가리켜, hints를 안 읽은 에이전트는 모델 메타·필드 쪽을 고치려 헤매기 쉽다. 진짜 chokepoint(`query` setter)는 트레이스에 없다.
- **K-Domain 병목:** 증상("데이터는 맞는데 dict 대신 모델로 빚어짐")을 "`_iterable_class` 불일치"로 재정의하려면 ORM iteration 내부를 알아야 한다.
- **regression-trap(P2P=32):** 같은 `queryset_pickle` 스위트의 32개 인접 동작(일반 모델 pickle, prefetch, deferred, related-field 등)을 안 깨야 한다. setter는 모든 `.query` 재할당의 공통 경로라 무분별한 변경이 광범위 회귀를 부른다.
- **has-repro는 easiness 신호**(완전 재현+스택트레이스+hints diff)라 T5까지는 안 올라가지만, 위 세 피처가 T2를 넘어선다. 따라서 공식 `<15 min`보다 한 단계 위인 T4가 방어 가능.

## 골드패치 분석
- **건드린 파일/함수:** `django/db/models/query.py` — `QuerySet.query` setter (`@query.setter def query(self, value)`).
- **근본 원인:** `_iterable_class`는 `QuerySet` 인스턴스의 속성이지 `Query`의 속성이 아니다. `values()` 호출 시 `_iterable_class`가 `ValuesIterable`로 바뀌지만, pickle 대상은 `queryset.query`뿐이라 이 정보가 직렬화되지 않는다. 새 `objects.all()`은 기본값 `ModelIterable`을 유지한 채 pickle된 `query`만 받으므로, DB에서 가져온 데이터는 values(dict) 형태인데 이터러블이 모델 인스턴스로 빚어내려다 내부 상태가 깨지고 `.pk` 접근에서 `AttributeError`가 난다.
- **수정 요지:** setter에서 `if value.values_select:`(= 복원된 query가 values 계열이면) `self._iterable_class = ValuesIterable`을 설정한 뒤 `self._query = value`를 저장. 복원된 query의 모양에 맞춰 이터러블 클래스를 동기화하는 두 줄 가드.

```python
@query.setter
def query(self, value):
    if value.values_select:
        self._iterable_class = ValuesIterable
    self._query = value
```

## 검증 (test_patch)
- **FAIL_TO_PASS (3):** 공식 목록은 `test_annotation_values`, `test_annotation_values_list`, `test_annotation_with_callable_default` 셋이지만, **실제로 골드패치가 상태를 뒤집는 건 앞의 둘뿐**이다. `test_annotation_with_callable_default`는 base 커밋에서 **골드패치 없이도 이미 PASS**하고 패치 적용 후에도 PASS다 — test_patch에서 `@@ ... def test_annotation_with_callable_default`가 추가(`+`)가 아니라 변경되지 않은 컨텍스트 라인으로 나오는 기존 테스트이고, 순수 `annotate()` 쿼리(`.values()` 없음)라 `query.values_select`가 비어 패치의 `if value.values_select:` 가드가 발동하지 않는다. 이 테스트가 공식 FAIL_TO_PASS에 들어간 건 SWE-bench 하네스/로그파싱 아티팩트이지 패치가 만든 행위적 통과가 아니다. (실측: base+test_patch에서 PickleabilityTestCase 33개 중 실패는 정확히 4개 — `test_annotation_values`(1) + `test_annotation_values_list`(subTest 3) — 이고 `test_annotation_with_callable_default`는 `ok`; 골드 적용 시 `Ran 33 tests ... OK`.)
- `test_annotation_values`: `Happening.objects.values('name').annotate(latest_time=Max('when'))`의 query를 pickle→unpickle해 새 `objects.all()`에 `.query`로 할당하고, `reloaded.get()`이 모델이 아니라 `{'name': 'test', 'latest_time': self.happening.when}` dict를 돌려주는지 단언. 픽스 없으면 `ModelIterable`이 (dict 대신) 모델 인스턴스를 빚어내므로 `reloaded.get()`이 잘못된 타입의 단일 `Happening` 객체를 돌려주고, 이 테스트는 **`assertEqual`에서 평범한 `AssertionError`로 FAIL**한다(실측: `AssertionError: <queryset_pickle.models.Happening object ...> != {'name': 'test', 'latest_time': datetime...}` @ tests.py:231). 단일 행을 `get()`으로 꺼내는 경로라 problem statement에 나오는 `__repr__`/`_get_pk_val`의 `'NoneType' ... 'attname'` 크래시(다중 행 queryset `__repr__`가 있어야 발동)에는 도달하지 않는다 — 인과 핵심(`ModelIterable`이 dict 대신 모델 인스턴스를 만든다)은 맞지만 이 특정 테스트는 "크래시"가 아니라 타입 불일치 단언 실패다.
- `test_annotation_values_list`: `values_list`의 세 변종(기본/`flat=True`/`named=True`)을 `subTest`로 돌려, query 복원 후 결과가 모두 `{'name': 'test'}`로 나오는지 확인. 테스트 주석("values_list() is reloaded to values() when using a pickled query")이 골드패치의 의도된 손실을 명시한다 — 세 전용 ListIterable 정보는 query에 안 실리므로 `ValuesIterable`로 통일된다.
- 테스트 인프라: `setUpTestData`에서 `Happening.objects.create()`를 `cls.happening = ...`로 바꿔 기대 비교값(`self.happening.when`)을 제공.
- **overfit 관점:** 픽스 조건 `value.values_select`는 특정 테스트 입력이 아니라 "values 쿼리 일반"을 식별하는 구조적 불변식이라 overfit-risk 없음(special-case 통과가 아님). `flat`/`named` 변종까지 묶어 검증해 입력공간을 충분히 덮음.
- **regression 관점:** `value.values_select`가 비어있는 일반 쿼리(P2P의 model pickle/prefetch/deferred/related 등)는 `if` 가드를 타지 않아 `_iterable_class`가 건드려지지 않으므로 32개 P2P가 byte-동치로 보존된다.

## 모범답안 (오라클 기반)

1. **localize 경로.** 스택트레이스 마지막 프레임(`_get_pk_val`/`attname`)에 끌려가지 말 것. 핵심 신호는 이슈 본문의 "데이터는 맞는데 dict 대신 모델 인스턴스가 반환된다"와 "결과 타입을 `_iterable_class`가 결정한다"는 사실. 증상을 "iterable class 불일치"로 재정의하면, `_iterable_class`가 `values()`에서 세팅되지만 pickle 대상은 `query`뿐 → `.query` 재할당 경로인 `QuerySet.query` setter가 유일한 chokepoint로 수렴한다. (hints가 이 경로를 직접 지목.)

2. **픽스와 올바른 일반화.** setter에서 복원된 `value.values_select`가 비어있지 않은지로 values 계열 쿼리를 식별하고 `self._iterable_class = ValuesIterable`로 동기화. 이것이 overfit이 아닌 이유: 테스트 리터럴이 아니라 "values_select가 채워진 query ⇒ values 결과여야 한다"는 ORM 불변식을 코드화한 것이기 때문. `values_list`의 세 전용 이터러블을 완벽 복원하려면 query에 추가 정보를 실어야 하는데, 그건 query만으로 구분 불가 — `ValuesIterable`로 환원하는 "의도된 손실"을 받아들이는 게 올바른 절충(테스트 주석이 이를 승인).

3. **regression 안전.** `if value.values_select:` 가드가 핵심 안전장치다. 일반 모델 쿼리는 `values_select`가 비어 가드를 안 타므로 `_iterable_class`(기본 `ModelIterable`)가 그대로 유지된다. 따라서 P2P 32개 — 일반 model pickle/dynamic/m2m, prefetch 계열, deferred, related-field, DoesNotExist 클래스 등 — 가 전부 안 깨진다. setter는 모든 `.query` 재할당의 공통 경로이므로, 조건 없이 무조건 `_iterable_class`를 바꾸면 광범위 회귀가 난다.

4. **함정 회피.** (a) **오도 트레이스:** `base.py`/`query_utils.py`의 `attname`을 고치려 들면 시간 낭비 — 거긴 증상이지 원인이 아니다. (b) **과설계:** "완벽한 복원"을 노려 `_iterable_class`/`values_list` 변종까지 query에 직렬화하려 들면 과설계이고 query 추상 경계를 깬다. hints가 명시한 `value.values_select` 체크 + `ValuesIterable` 환원이 정답 스코프. (c) **조건 누락:** 가드 없이 setter에서 항상 `_iterable_class`를 세팅하면 P2P 회귀 — `if value.values_select`가 regression 방어의 본질이므로 빼면 안 된다.
