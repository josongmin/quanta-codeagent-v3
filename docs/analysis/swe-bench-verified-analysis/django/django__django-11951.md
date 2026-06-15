---
instance_id: django__django-11951
repo: django/django
base_commit: 312049091288dbba2299de8d07ea3e3311ed7238
version: 3.1
difficulty: <15 min fix
created_at: 2019-10-21T09:35:46Z
fail_to_pass: 1
pass_to_pass: 21
gold_files: [django/db/models/query.py]
---

# django__django-11951

## 문제 요약
`bulk_create(objs, batch_size=...)`에서 사용자가 명시한 `batch_size`가 DB 백엔드가 허용하는 최대 배치 크기(`bulk_batch_size`) 계산을 그냥 덮어쓴다. 사용자가 백엔드 한도보다 큰 `batch_size`를 주면, 한 INSERT에 너무 많은 파라미터/행이 들어가 백엔드 제한(예: SQLite 변수 한도)을 위반할 수 있다. 기대 동작은 `bulk_update`처럼 사용자 값과 백엔드 최대값 중 **작은 쪽**을 쓰는 것이다.

## 유형 분류
- 버그 카테고리: logic (잘못된 우선순위 선택) / edge-case (user batch_size > backend max)
- 서브시스템: django ORM query (`QuerySet._batched_insert`)
- 증상 타입: silent-wrong (한도 초과 시 백엔드 예외로 이어질 수 있는 잘못된 배치 분할)
- 로컬라이제이션 신호: problem_statement가 파일·라인(`django/db/models/query.py` L1197)과 비교 대상(`bulk_update` L504의 `min(...)` 패턴)을 직접 지목. "batch_size param overrides compatible batch size calculation"이 정확히 결함 라인을 가리킨다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/query.py` : `QuerySet._batched_insert`
- 근본 원인: 기존 코드 `batch_size = (batch_size or max(ops.bulk_batch_size(fields, objs), 1))`는 `batch_size`가 truthy면 백엔드 최대값(`max_batch_size`)을 아예 무시하고 사용자 값을 그대로 사용. 즉 사용자 값 > 백엔드 한도여도 캡(clamp)이 없음.
- 수정 요지: 백엔드 최대값을 `max_batch_size`로 먼저 계산한 뒤, 사용자 값이 있으면 `min(batch_size, max_batch_size)`, 없으면 `max_batch_size`를 사용하도록 변경. `bulk_update`와 동일한 패턴으로 통일:
  ```python
  max_batch_size = max(ops.bulk_batch_size(fields, objs), 1)
  batch_size = min(batch_size, max_batch_size) if batch_size else max_batch_size
  ```

## 검증 (test_patch)
- FAIL_TO_PASS: `test_explicit_batch_size_respects_max_batch_size` — 사용자가 `max_batch_size + 1`을 넘겨도 실제 분할은 `max_batch_size` 기준으로 일어나는지 확인.
- 증명 방식: `Country` 1000개를 만들고 `max_batch_size = max(connection.ops.bulk_batch_size(fields, objs), 1)`를 구한 뒤 `bulk_create(objs, batch_size=max_batch_size + 1)` 호출. `assertNumQueries(ceil(1000 / max_batch_size))`로 쿼리 수를 단언 — 캡이 적용되면 쿼리 수가 백엔드 최대값 기준으로 나오고, 버그(캡 없음)면 더 적은(혹은 단일) 쿼리가 나와 단언이 깨진다. `@skipUnlessDBFeature('has_bulk_insert')`로 게이팅.

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement가 파일/라인/참조 패턴까지 명시했으므로 `_batched_insert` 한 함수만 보면 됨. `bulk_batch_size`와 `batch_size`가 함께 쓰이는 라인이 핵심.
- 함정/난이도 메모: `batch_size or ...`의 truthy 단락을 `min(...) if batch_size else ...`로 바꾸되 **`batch_size=0`/`None` 의미(미지정=백엔드 자동)를 깨지 않아야** 함 — `if batch_size` 분기로 0/None 모두 max_batch_size 폴백 유지. 단일 파일·단일 라인 수정이라 멀티파일 아님. `bulk_update`(L504)는 이미 올바른 패턴이므로 건드릴 필요 없음(참조용).
- 우리 에이전트 관점: 난이도 낮음. 리스크는 (1) `min`/`max` 자리 헷갈려 의미 반전, (2) `batch_size or max(...)` 한 줄을 그대로 두고 엉뚱한 곳 수정, (3) 테스트의 `assertNumQueries` 의미(캡 적용 시 쿼리 수 증가)를 오해해 over-fix. problem_statement에 정답 스니펫이 그대로 제시되어 있어 사실상 그대로 적용하면 통과.
