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
---

# django__django-13315

## 문제 요약
ForeignKey(또는 ManyToManyField)의 `limit_choices_to`에 조인을 수반하는 `Q` 객체(또는 dict)를 넘기면, 폼 필드의 queryset에 같은 옵션이 중복으로 렌더링된다. 조인된 역참조(reverse) 관계가 1:N으로 여러 행을 만들어내기 때문이다. 사용자는 각 선택지가 한 번씩만 나타나길 기대한다. 과거 `.distinct()` 기반 수정이 일부 백엔드/커스텀 필드에서 깨져 revert된 오래된 티켓(#11707)이라, 중복 제거를 distinct 없이 해결해야 한다.

## 유형 분류
- 버그 카테고리: logic / edge-case (조인 fan-out으로 인한 중복)
- 서브시스템: django forms (model form 필드 생성) + ORM query 구성
- 증상 타입: 잘못된 출력 (폼 선택지에 중복 표시; 심하면 `.get()` 시 MultipleObjectsReturned)
- 로컬라이제이션 신호: "limit_choices_to ... formfield"라는 문구가 `django/forms/models.py`의 `apply_limit_choices_to_to_formfield`를 직접 지목한다. limit_choices_to를 queryset에 적용하는 유일한 지점.

## 골드패치 분석
- 건드린 파일/함수: `django/forms/models.py:apply_limit_choices_to_to_formfield`
- 근본 원인: 기존 코드는 `formfield.queryset.complex_filter(limit_choices_to)`로 조건을 직접 JOIN 필터로 걸었다. 역참조 다대다/일대다 조인은 매칭되는 자식 행 수만큼 부모 행을 복제하므로 동일 선택지가 중복된다.
- 수정 요지:
  - `Exists`, `OuterRef`, `Q`를 import.
  - 빈 값 가드를 `is not None`에서 truthy 검사 `if limit_choices_to:`로 변경(빈 dict/Q는 스킵).
  - dict면 `Q(**limit_choices_to)`로 변환한 뒤, `complex_filter &= Q(pk=OuterRef('pk'))`로 바깥 행 pk에 상관(correlate)시킴.
  - 메인 queryset을 `filter(Exists(model._base_manager.filter(complex_filter)))`로 감싸, 조인을 서브쿼리로 옮겨 fan-out 없이 "조건을 만족하는 행이 존재하는지"만 판정 → 중복 제거(distinct 불필요).

## 검증 (test_patch)
- FAIL_TO_PASS: `test_limit_choices_to_no_duplicates (model_forms.tests.LimitChoicesToTests)`
- 테스트 모델(`tests/model_forms/models.py`)에서 `StumpJoke`에 `funny` 필드 추가하고 역참조 관계명을 `jokes`/`jokes_today`로 부여. 테스트는 `@isolate_apps`로 `jokes__funny=True, jokes_today__funny=True` 조인 조건을 가진 `CharacterDetails`(FK Q / FK dict / M2M Q 세 형태) 모델을 정의.
- 재현: 한 Character가 여러 funny joke와 연결되도록 데이터를 세팅 → 조인 조건이 다수 매칭. 픽스 전이면 `character1/2/3`의 queryset에 `marley`, `threepwood`가 중복으로 나옴.
- 기대: 세 필드 모두 `assertCountEqual(queryset, [self.marley, self.threepwood])` — 정확히 한 번씩만. Exists 서브쿼리화로 중복이 사라짐을 증명. dict/Q/M2M 세 경로 모두 커버.

## 공략 포인트 (뭘 조져야)
- localization: `limit_choices_to`를 queryset에 적용하는 곳은 `apply_limit_choices_to_to_formfield` 하나. `complex_filter` grep으로 즉시 도달.
- 함정/난이도:
  - 순진하게 `.distinct()`를 붙이면 통과는 하나, 이 티켓의 핵심 히스토리(distinct가 Postgres 커스텀 필드에서 깨져 revert됨)를 재현한다. 골드는 의도적으로 distinct를 피하고 Exists 상관 서브쿼리를 택함.
  - dict와 Q를 모두 받아야 함 → dict는 `Q(**...)`로 정규화 후 `&= Q(pk=OuterRef('pk'))` 상관 필수.
  - 가드를 `is not None` → truthy로 바꾸는 미묘한 변경(빈 dict/Q 처리)을 놓치기 쉬움.
  - `_base_manager` 사용(기본 매니저 우회)도 커스텀 매니저 필터링 회피를 위한 포인트.
- 우리 에이전트 관점: 단일 파일·짧은 수정이라 표면 난이도는 낮지만, "distinct로 빠르게 통과" 유혹에 빠지면 골드와 다른 비robust 해법으로 갈 수 있다. Exists/OuterRef 상관 서브쿼리 패턴을 떠올리는 게 관건이고, dict/Q 양쪽 입력과 빈 값 엣지케이스를 다 처리하는지가 점수 분기.
