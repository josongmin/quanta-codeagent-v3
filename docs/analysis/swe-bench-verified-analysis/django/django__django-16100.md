---
instance_id: django__django-16100
repo: django/django
base_commit: c6350d594c359151ee17b0c4f354bb44f28ff69e
version: 4.2
difficulty: <15 min fix
created_at: 2022-09-24T13:32:02Z
fail_to_pass: 1
pass_to_pass: 59
gold_files: [django/contrib/admin/options.py]
---

# django__django-16100

## 문제 요약
Django admin의 changelist 화면에서 `list_editable` 필드를 인라인 편집해 저장하면, 여러 행을 순차적으로 DB에 기록한다. 그런데 이 처리가 트랜잭션으로 감싸여 있지 않아, 중간에 에러가 나면 일부 행만 저장된 불완전(half-committed) 상태가 남는다. 사용자(리포터)는 데이터를 변경하는 뷰이므로 트랜잭션으로 묶어 에러 시 전체 롤백되기를 기대했다.

## 유형 분류
- 버그 카테고리: 누락처리 (missing transaction / atomicity 누락)
- 서브시스템: django.contrib.admin (ModelAdmin changelist 뷰, list_editable formset 저장)
- 증상 타입: silent-wrong (예외 발생 시 부분 커밋으로 DB 정합성 깨짐)
- 로컬라이제이션 신호: problem_statement가 "changelist_view ... missing a transaction"이라고 거의 직접 지목. `list_editable` 저장 루프 = `ModelAdmin.changelist_view` 내부 formset 처리 블록.

## 골드패치 분석
- 건드린 파일/함수: `django/contrib/admin/options.py` : `ModelAdmin.changelist_view`
- 근본 원인: `formset.is_valid()` 통과 후 `for form in formset.forms` 루프에서 행마다 `save_form` / `save_model` / `save_related` / `log_change`를 곧바로 커밋하는데, 루프 도중 예외가 나면 앞서 저장된 행들은 이미 DB에 반영되어 롤백되지 않았다.
- 수정 요지: 해당 루프 전체를 `with transaction.atomic(using=router.db_for_write(self.model)):` 블록으로 감쌌다. 이로써 루프 중 어떤 행에서든 예외가 발생하면 그 트랜잭션 안에서 수행된 모든 변경(이미 성공한 행 포함)이 함께 롤백된다. 멀티-DB를 고려해 `router.db_for_write(self.model)`로 쓰기 대상 DB를 선택한다. 로직 자체(저장 순서, changecount 집계)는 그대로 유지하고 원자성만 추가.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_list_editable_atomicity` — `Swallow` 두 개(a, b)를 만들고 changelist에 POST로 두 행을 동시에 편집 저장.
- 테스트가 어떻게 픽스를 증명하는지: `ModelAdmin.log_change`를 `mock.patch`로 가로채 (1) 항상 `DatabaseError`, (2) `[None, DatabaseError]`(둘째 행에서 실패)로 만든다. POST가 `DatabaseError`를 던지는지 확인한 뒤 `refresh_from_db()`로 a/b의 원래 값(load=4/speed=1, load=2/speed=2)이 보존됐는지 단언한다. 트랜잭션이 없으면 두 번째 케이스에서 첫 행 변경이 커밋되어 단언이 깨진다. `@skipUnlessDBFeature("supports_transactions")`로 트랜잭션 미지원 백엔드는 제외.

## 공략 포인트 (뭘 조져야)
- localization 전략: `django/contrib/admin/options.py`에서 `changelist_view` 안의 `formset.is_valid()` 직후 저장 루프를 찾는다. problem_statement가 함수명을 사실상 알려주므로 진입은 쉽다.
- 함정/난이도 메모: 단일 파일·단일 블록 수정이라 난이도 낮음(<15분). 단, `transaction.atomic()`만 쓰지 말고 멀티-DB 정확성을 위해 `using=router.db_for_write(self.model)`를 붙여야 골드와 일치(이미 `transaction`, `router`는 options.py에 import되어 있음). 인접한 add/change form 저장 경로와 혼동하지 말 것 — 여기 대상은 changelist 인라인 편집 루프만.
- 우리 에이전트 관점: 함수 위치 찾기는 쉬우나, `using` 인자 없이 단순 `transaction.atomic()`만 넣고 끝내기 쉽다. 테스트는 그래도 통과하므로 기능상 문제는 없지만 골드 동등성/멀티-DB 정합성 측면에서 router 사용이 정답. 또한 들여쓰기를 한 단계 더 넣어야 하는 순수 구조 변경이라 diff 노이즈가 커 보일 수 있음.
