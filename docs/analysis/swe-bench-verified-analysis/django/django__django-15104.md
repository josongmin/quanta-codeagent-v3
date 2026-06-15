---
instance_id: django__django-15104
repo: django/django
base_commit: a7e7043c8746933dafce652507d3b821801cdc7d
version: "4.1"
difficulty: <15 min fix
created_at: 2021-11-19T20:46:58Z
fail_to_pass: 1
pass_to_pass: 131
gold_files: [django/db/migrations/autodetector.py]
---

# django__django-15104

## 문제 요약
`to` 인자를 하드코딩하고 deconstruct 시 그 키를 제거하는 커스텀 ForeignKey 필드를 쓰면, 마이그레이션 autodetector가 `KeyError: 'to'`로 크래시한다. 증상은 `python manage.py test -v 2`처럼 syncdb가 도는 경로에서 변경 감지가 터지는 것. 사용자는 deconstruct된 kwargs에 `to`가 없어도 autodetector가 정상적으로 변경을 감지하길 기대했다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (deconstruction에 `to`가 항상 있다고 가정한 unsafe del)
- 서브시스템: django migrations autodetector
- 증상 타입: 예외 (KeyError → 명령 크래시)
- 로컬라이제이션 신호: problem_statement에 traceback이 통째로 들어있어 `autodetector.py:99`의 `del deconstruction[2]['to']`를 정확히 지목. 게다가 사용자가 픽스(`pop('to', None)`)까지 제안.

## 골드패치 분석
- 건드린 파일/함수: `django/db/migrations/autodetector.py` : `MigrationAutodetector.only_relation_agnostic_fields`
- 근본 원인: 이 메서드는 FK를 "관계 무관(relation-agnostic)"으로 비교하려고 deconstruct된 kwargs(`deconstruction[2]`)에서 `to`를 떼낸다. `field.remote_field.model`이 참이면 무조건 `del ...['to']`를 호출하는데, 커스텀 필드가 `deconstruct()`에서 `to`를 미리 제거하면 그 키가 없어 `del`이 KeyError를 던진다.
- 수정 요지: `del deconstruction[2]['to']`를 `deconstruction[2].pop('to', None)`로 교체. 키가 없을 때 조용히 넘어가도록 하여, `to`가 deconstruct 결과에 없는 경우에도 안전하게 동작한다. 동작 의도(있으면 제거)는 동일하게 유지된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_add_custom_fk_with_hardcoded_to` — `__init__`에서 `kwargs['to']='testapp.Author'`로 하드코딩하고 `deconstruct()`에서 `del kwargs['to']`하는 `HardcodedForeignKey`를 정의한 뒤, 이 FK를 가진 `Book` 모델을 추가하는 변경을 감지시킨다.
- 픽스 증명: 재현 입력은 빈 author 상태 → author + `Book(author=HardcodedForeignKey)` 추가. 패치 전엔 `only_relation_agnostic_fields`가 KeyError로 죽지만, 패치 후엔 testapp에 마이그레이션 1개, 단일 `CreateModel(name='Book')` 오퍼레이션이 생성됨을 `assertNumberMigrations`/`assertOperationTypes`/`assertOperationAttributes`로 확인한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: traceback의 마지막 프레임(`autodetector.py`, `only_relation_agnostic_fields`, `del deconstruction[2]['to']`)이 단일 지점을 직접 가리킴. grep `del deconstruction` 하나면 끝.
- 함정/난이도: 거의 없음. 단일 파일, 단일 라인. 함정은 "to를 안 지우면 되지 않나" 식으로 조건을 건드려 비교 의미를 바꾸는 과교정. 정답은 동작 보존형 `pop(..., None)`.
- 우리 에이전트 관점: 막힐 데가 거의 없는 트리비얼 픽스. 위험은 (1) 커스텀 FK 재현 테스트를 직접 짜려다 시간 낭비, (2) `del`을 `if 'to' in ...` 가드로 감싸는 더 장황한 대안 선택. 골드와 기능적으로 동치라 채점은 통과하지만, 최소 변경인 `pop` 한 줄을 못 떠올릴 이유는 없다.
