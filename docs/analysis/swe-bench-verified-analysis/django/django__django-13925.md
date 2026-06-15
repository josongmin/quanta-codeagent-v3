---
instance_id: django__django-13925
repo: django/django
base_commit: 0c42cdf0d2422f4c080e93594d5d15381d6e955e
version: 4.0
difficulty: 15 min - 1 hour
created_at: 2021-01-21T08:08:55Z
fail_to_pass: 2
pass_to_pass: 24
gold_files: [django/db/models/base.py]
---

# django__django-13925

## 문제 요약
Django 3.2 alpha부터 다른 모델을 상속받는 모델에서 `models.W042`(auto-created primary key 경고)가 잘못 발생한다. 사용자는 조상 모델(예: `Entity`)에서 이미 PK를 명시적으로 정의했고 자식(`User`)이 이를 상속받기를 기대했는데, 자식 모델마다 W042 경고가 뜬다. 3.1에서는 정상이었던 것이 3.2 alpha 회귀(regression)다.

## 유형 분류
- 버그 카테고리: regression / edge-case (상속 PK 미처리)
- 서브시스템: django ORM 모델 시스템 / system check framework (`_check_default_pk`)
- 증상 타입: 잘못된 출력 (false-positive 경고 W042)
- 로컬라이제이션 신호: 경고 ID `models.W042`와 메시지 "Auto-created primary key used when not defining a primary key type"가 직접 단서. 이 문자열을 grep하면 `django/db/models/base.py`의 `_check_default_pk`로 바로 연결된다. "inherited"/"parent_link"라는 상속 맥락이 핵심.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/base.py` : `Model._check_default_pk` (classmethod)
- 근본 원인: 다중 테이블 상속(MTI)에서 자식 모델의 PK는 부모를 가리키는 `OneToOneField`(parent_link=True)로 자동 생성된다. 이 PK는 `auto_created=True`이므로 기존 조건 `cls._meta.pk.auto_created`가 참이 되어, 부모가 명시적 PK를 정의했더라도 자식에서 W042가 발생했다. 즉 "auto_created PK"를 곧 "사용자가 PK 타입 미지정"으로 잘못 등치한 것이 회귀의 핵심.
- 수정 요지: `_check_default_pk`의 경고 발생 조건에 예외 절을 추가한다. PK가 `OneToOneField`이면서 `remote_field.parent_link`가 True인 경우(= 상속으로 생성된 parent link PK)는 경고 대상에서 제외한다. 주석으로 "Inherited PKs are checked in parents models"라 명시 — 상속 PK는 부모 모델에서 이미 검사되므로 자식에서 중복/오탐 경고를 내지 않는다.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_explicit_inherited_pk`: `Parent`가 `id = AutoField(primary_key=True)`로 명시 PK를 가지고 `Child(Parent): pass`. 기대 결과는 경고 0개(`[]`). 픽스 전엔 Child의 parent_link PK에 대해 W042가 떴다.
  - `test_auto_created_inherited_pk`: `Parent`/`Child` 둘 다 PK 미지정. 부모 PK는 진짜 auto_created이므로 `Parent`에 대해서만 W042 1개가 떠야 함(자식 parent_link PK는 제외).
- 증명 방식: 명시 상속 PK는 경고가 사라지고(false-positive 제거), 진짜 auto-created 부모는 여전히 경고가 부모 객체(`obj=Parent`)로 정확히 1개만 발생함을 동시에 확인 — 과잉 억제가 아님을 보장. `test_auto_created_inherited_parent_link`/`test_explicit_inherited_parent_link`(PASS_TO_PASS)는 명시적 parent_ptr 정의 케이스에서도 동일하게 자식이 경고에서 빠짐을 고정한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: W042 경고 문자열 또는 ID로 grep → `_check_default_pk` 단일 메서드로 즉시 수렴. 단일 파일/단일 함수 픽스라 위치 찾기는 쉬운 편.
- 함정/난이도 메모: 진짜 어려움은 "왜 자식 PK가 auto_created인가"를 이해하는 것. MTI에서 parent_link OneToOneField가 PK가 되는 메커니즘을 모르면, 단순히 "auto_created면 스킵"으로 과잉 수정해 진짜 auto-created 부모 경고까지 죽일 위험(test_auto_created_inherited_pk가 이를 잡는 트랩). 정확한 조건은 `OneToOneField AND remote_field.parent_link`.
- 우리 에이전트 관점: 코드 위치는 쉽게 찾지만, 부모는 경고 유지 / 자식만 제외라는 비대칭 조건을 정밀하게 표현하지 못하면 한 테스트는 통과시키고 다른 테스트는 깰 수 있다. `OneToOneField`가 base.py 상단에 import되어 있는지(이름 해석 가능성)도 확인 필요. 회귀 원인 커밋(b5e12d4) 맥락 없이도 조건 자체는 골드처럼 정확히 도출 가능.
