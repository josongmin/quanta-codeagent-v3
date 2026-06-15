---
instance_id: django__django-11163
repo: django/django
base_commit: e6588aa4e793b7f56f4cadbfa155b581e0efc59a
version: "3.0"
difficulty: <15 min fix
created_at: 2019-04-02T21:46:42Z
fail_to_pass: 1
pass_to_pass: 141
gold_files: [django/forms/models.py]
---

# django__django-11163

## 문제 요약
`model_to_dict(instance, fields=[])` 처럼 빈 필드 리스트를 넘기면, "요청한 필드가 없음"이므로 빈 dict `{}`를 반환해야 한다. 그런데 실제로는 모든 필드를 반환한다. 사용자는 빈 리스트를 "아무 필드도 선택하지 않음"으로 기대했지만, 함수는 이를 "필터 없음(전체)"으로 잘못 해석한다.

## 유형 분류
- 버그 카테고리: edge-case (빈 컬렉션의 falsy 처리) / API-contract
- 서브시스템: django forms / model_to_dict 유틸 (`django/forms/models.py`)
- 증상 타입: silent-wrong (예외 없이 잘못된 출력 — 전체 필드 반환)
- 로컬라이제이션 신호: problem_statement가 버그 지점(`if fields and f.name not in fields:`)과 수정안(`if fields is not None and ...`), 그리고 PR 링크까지 그대로 명시해줌. 사실상 정확한 위치가 주어진 케이스.

## 골드패치 분석
- 건드린 파일/함수: `django/forms/models.py:model_to_dict`
- 근본 원인: 필드 필터 분기에서 `if fields and f.name not in fields:` 를 쓰는데, `fields=[]`(빈 리스트)는 Python에서 falsy라 `fields and ...` 전체가 즉시 False가 되어 필터링 자체가 스킵된다. 결과적으로 "빈 선택"과 "필터 미지정(None)"이 구분되지 않고 둘 다 전체 필드를 통과시킨다.
- 수정 요지: 조건을 `if fields is not None and f.name not in fields:` 로 바꿔, falsy 여부가 아니라 명시적 `None` 여부로 분기한다. 이제 `fields=[]`는 not-None이므로 모든 필드가 `f.name not in fields`에 걸려 제외되어 `{}`가 반환되고, `fields=None`(기본값)일 때만 필터를 건너뛴다. 정확히 한 줄 변경.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_modelform_subclassed_model (model_forms.tests.ModelOneToOneFieldTests)`
- 테스트가 어떻게 픽스를 증명하는지: `BetterWriter` 인스턴스에 대해 네 가지 단언을 추가한다.
  - `model_to_dict(bw, fields=[])` → `[]` (빈 선택 = 빈 dict, 이게 핵심 회귀 단언)
  - `model_to_dict(bw, fields=['id', 'name'])` → `['id', 'name']` (정상 부분 선택 유지)
  - `model_to_dict(bw, exclude=[])` → 전체 필드 (빈 exclude는 아무것도 제외 안 함)
  - `model_to_dict(bw, exclude=['id', 'name'])` → `['score', 'writer_ptr']` (정상 제외 유지)
  - 버그가 있으면 첫 단언이 전체 필드를 반환해 `[]`와 불일치하며 실패한다. exclude 쪽은 골드에서 건드리지 않았지만 회귀 방지로 함께 고정.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement에 파일 함수 라인과 수정 문자열이 거의 다 적혀 있다. `model_to_dict` 한 군데만 보면 됨. grep 한 번으로 끝나는 수준.
- 함정/난이도 메모: `exclude`에도 동일한 falsy 패턴(`if exclude and f.name in exclude:`)이 바로 아래 줄에 있어 "여기도 고쳐야 하나?" 헷갈릴 수 있다. 하지만 exclude는 빈 리스트 의미가 "제외 없음 = 전체"로 falsy 동작과 일치하므로 건드리면 안 됨 (테스트가 exclude=[] → 전체를 단언해 이를 보호). fields만 의미가 뒤집힌다는 비대칭을 이해해야 과교정을 피한다.
- 우리 에이전트 관점: 난이도 자체는 최저(<15분, 1줄). 막힐 만한 유일한 지점은 exclude까지 같이 `is not None`으로 바꾸는 과교정인데, test_patch의 `exclude=[]` → 전체 단언이 즉시 잡아낸다. 즉 테스트만 돌리면 자가 교정 가능. 빈 컬렉션의 falsy 함정을 인지하는지가 전부.
