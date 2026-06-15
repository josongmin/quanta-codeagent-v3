---
instance_id: django__django-14559
repo: django/django
base_commit: d79be3ed39b76d3e34431873eec16f6dd354ab17
version: 4.0
difficulty: 15 min - 1 hour
created_at: 2021-06-26T05:38:46Z
fail_to_pass: 3
pass_to_pass: 23
gold_files: [django/db/models/query.py]
---

# django__django-14559

## 문제 요약
`QuerySet.bulk_update()`는 항상 `None`을 반환하지만, 일반 `update()`는 매칭된 행 수(int)를 반환한다. 사용자는 두 API의 일관성을 기대했고, `bulk_update()`가 내부적으로 `update()`를 반복 호출하므로 그 반환값들을 합산해 행 수를 돌려주기를 원했다. 즉 증상은 "반환값 누락(None)"이고, 기대는 "갱신된 행 수 반환".

## 유형 분류
- 버그 카테고리: 누락처리 / API-contract (반환값 계약 불일치)
- 서브시스템: django ORM (`db/models/query.py`의 QuerySet 메서드)
- 증상 타입: silent-wrong (예외 없이 `None`을 반환 — 호출자가 행 수를 못 얻음)
- 로컬라이제이션 신호: problem_statement가 파일·라인을 명시적으로 지목(`django/db/models/query.py` L568, `bulk_update()`가 `update()`를 반복 호출). 거의 핀포인트 수준의 단서.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/query.py` : `QuerySet.bulk_update()`
- 근본 원인: `bulk_update()`가 배치별로 `self.filter(pk__in=pks).update(**update_kwargs)`를 호출하면서 그 반환값(영향 행 수)을 버리고 명시적 `return`도 없어 항상 `None`이 반환됨. early-return(빈 objs) 경로도 `return`(=None).
- 수정 요지:
  - 빈 `objs` early-return을 `return 0`으로 변경(없는 갱신 = 0행).
  - 루프 진입 전 `rows_updated = 0` 누산기 도입.
  - `transaction.atomic` 내 루프에서 `rows_updated += self.filter(pk__in=pks).update(**update_kwargs)`로 각 배치의 갱신 행 수를 합산.
  - 메서드 끝에서 `return rows_updated`.
  - 의도적으로 중복(objs 내 동일 객체) 처리는 future-proofing하지 않음 — 같은 배치 내 중복은 1로, 다른 배치로 분리된 중복은 중복 계수됨(설계상 그대로 합산).

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_empty_objects`: 빈 리스트 `bulk_update([], ['note'])`가 쿼리 0개(`assertNumQueries(0)`)이면서 `0`을 반환하는지.
  - `test_large_batch`: 2000개 Note를 `bulk_update` 후 반환값 `== 2000`.
  - `test_updated_rows_when_passing_duplicates`: 동일 객체를 두 번 넘기면 단일 배치에서는 `1`(같은 pk 한 번 갱신), `batch_size=1`로 배치를 쪼개면 `2`(두 배치가 같은 행을 각각 갱신).
- 증명 방식: 재현 입력(빈/대량/중복 객체 리스트)을 넘기고 반환 int를 단언. 특히 duplicates 테스트가 "단순 합산" 동작을 명시적으로 고정 — 배치 분할에 따라 1 또는 2가 나오는 것이 버그가 아니라 합의된 계약임을 박아둔다.

## 공략 포인트 (뭘 조져야)
- 어디부터: problem_statement가 파일·함수·라인을 직접 지목하므로 `bulk_update` 정의로 바로 이동. 핵심은 `update()` 호출 반환값을 누산하고 `return`하는 것.
- 함정/난이도 메모:
  - early-return 경로(`if not objs:`)도 `None`이 아니라 `0`을 반환해야 함 — 놓치면 `test_empty_objects` 실패.
  - 중복 계수 동작을 "버그"로 오해해 dedup하려 들면 `test_updated_rows_when_passing_duplicates`의 `batch_size=1 → 2` 기대와 충돌. 골드는 의도적으로 단순 합산.
  - 누산은 반드시 `transaction.atomic` 루프 내부에서 `+=`로. 합산 위치/초기화 누락 시 0 또는 None 반환 가능.
  - 단일 파일·단일 함수 수정. 멀티파일 아님.
- 우리 에이전트 관점: 난이도 낮음(거의 핀포인트). 막힐 만한 유일 지점은 중복 엣지케이스 — hints에서 "duplicates split between batches will be counted twice"가 언급되므로, 에이전트가 과도하게 "정확한 distinct 행 수"를 구현하려 하면 테스트 계약과 어긋난다. 가장 단순한 합산이 정답.
