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
---

# django__django-13406

## 문제 요약
`values()`/`values_list()` + `annotate()`(GROUP BY)로 만든 쿼리셋의 `queryset.query`를 pickle했다가, 새로 만든 `Model.objects.all()`에 `.query`로 다시 할당하면 결과가 깨진다. 정상이라면 dict 리스트를 돌려줘야 하는데 모델 인스턴스를 반환하고, 그 인스턴스는 내부 상태가 망가져 `.pk` 접근 시 `AttributeError: 'NoneType' object has no attribute 'attname'`로 크래시한다. 사용자는 문서화된 query pickling 패턴을 그대로 따랐는데 결과 타입이 dict가 아니라 모델로 나오는 게 문제였다.

## 유형 분류
- 버그 카테고리: 누락처리 (상태 복원 시 파생 속성 재설정 누락)
- 서브시스템: django ORM QuerySet pickling / iteration
- 증상 타입: 잘못된 출력(dict 대신 모델 반환) → 후속 크래시(AttributeError)
- 로컬라이제이션 신호: traceback이 `query.py` `__repr__` → `base.py` `_get_pk_val`로 이어지고, hints에서 사용자가 직접 `_iterable_class`가 pickle/unpickle되지 않는 게 원인이라고 지목. `query` setter가 유일한 진입점.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/query.py` : `QuerySet.query` setter (`@query.setter`)
- 근본 원인: `_iterable_class`는 `QuerySet`의 속성이지 `Query`의 속성이 아니다. `values()`를 호출하면 `_iterable_class`가 `ValuesIterable`로 바뀌지만, pickle 대상은 `query`뿐이라 이 정보가 직렬화되지 않는다. 새 `objects.all()`은 기본값인 `ModelIterable`을 유지한 채 pickle된 `query`만 받으므로, 데이터는 values 형태인데 모델 인스턴스로 빚어내려다 깨진다.
- 수정 요지: `query` setter에서 들어온 `value.values_select`가 비어있지 않으면(=values 계열 쿼리면) `self._iterable_class`를 `ValuesIterable`로 강제 설정한 뒤 `self._query = value`를 저장. 두 줄짜리 가드로 복원된 query의 모양에 맞춰 이터러블 클래스를 동기화한다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_annotation_values`, `test_annotation_values_list`, `test_annotation_with_callable_default`
- `test_annotation_values`: `Happening.objects.values('name').annotate(latest_time=Max('when'))`의 query를 pickle→unpickle해서 새 `objects.all()`에 `.query`로 할당하고, `reloaded.get()`이 모델이 아니라 `{'name': 'test', 'latest_time': ...}` dict를 돌려주는지 단언. 픽스 없으면 모델 인스턴스가 나와 크래시.
- `test_annotation_values_list`: `values_list`의 세 변종(기본/`flat=True`/`named=True`)을 subTest로 돌려, query 복원 후 결과가 모두 `{'name': 'test'}`로 나오는지 확인. 주석대로 values_list는 복원 시 values()로 환원된다(서로 다른 ListIterable 정보는 query에 안 실리므로 ValuesIterable로 통일). setUpTestData에서 `cls.happening`을 보관하도록 바꿔 기대 비교값을 제공.

## 공략 포인트 (뭘 조져야)
- localization: traceback 마지막이 `_get_pk_val`/`attname`이라 모델 메타 쪽으로 새기 쉽지만, 진짜 진입점은 "데이터는 맞는데 dict 대신 모델로 빚는다"는 사실. `_iterable_class`가 결과 형태를 결정하므로 이 속성이 어디서 세팅되는지, query 재할당 경로(`query` setter)가 그것을 건드리는지를 봐야 한다. 단일 파일·단일 메서드 수정.
- 함정/난이도: `values_list`의 세 가지 전용 이터러블(`ValuesListIterable`/`FlatValuesListIterable`/`NamedValuesListIterable`)은 query만으로는 구분 불가라 모두 `ValuesIterable`로 환원되는 "의도된 손실"이 있다. 완벽 복원을 노려 query를 더 직렬화하려 들면 과설계. hints가 명시한 `value.values_select` 비어있음 체크가 정답 조건.
- 우리 에이전트 관점: AttributeError traceback을 따라 `base.py`/`query_utils.py`를 고치려 헤매면 시간을 낭비한다. 증상을 "iterable class 불일치"로 재정의하고 `query` setter라는 좁은 chokepoint로 수렴하는 것이 핵심. 수정 자체는 2줄로 매우 작아, localization이 난이도의 전부.
