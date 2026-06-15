---
instance_id: django__django-16569
repo: django/django
base_commit: 278881e37619278789942513916acafaa88d26f3
version: 5.0
difficulty: <15 min fix
created_at: 2023-02-17T20:11:38Z
fail_to_pass: 2
pass_to_pass: 111
gold_files: [django/forms/formsets.py]
---

# django__django-16569

## 문제 요약
FormSet이 `can_delete=True`이고 `can_delete_extra=False`일 때, `add_fields()`에 `index=None`이 넘어오면 `TypeError: '<' not supported between instances of 'NoneType' and 'int'`가 발생한다. 이 조합은 대표적으로 `formset.empty_form`(빈 추가 폼) 렌더링 시 발생한다 (empty_form은 index를 None으로 add_fields를 호출). 사용자는 empty_form이 예외 없이 정상 렌더링되기를 기대한다.

## 유형 분류
- 버그 카테고리: edge-case / 누락처리 (None 미처리)
- 서브시스템: django forms / formsets (BaseFormSet.add_fields)
- 증상 타입: 예외 (TypeError crash)
- 로컬라이제이션 신호: problem_statement가 파일·라인·코드까지 직접 명시 — `django/forms/formsets.py` 493행 `index < initial_form_count` 비교, 그리고 수정안(`index is not None and ...`)까지 제시. 거의 좌표가 박혀 있는 케이스.

## 골드패치 분석
- 건드린 파일/함수: `django/forms/formsets.py:add_fields` (BaseFormSet)
- 근본 원인: `add_fields(self, form, index)`에서 deletion 필드 추가 여부를 판단하는 조건 `self.can_delete_extra or index < initial_form_count`가 `index`가 None일 수 있다는 사실을 고려하지 않았다. `can_delete_extra=False`이면 단락 평가가 우항 `index < initial_form_count`까지 진행되는데, empty_form 경로는 `index=None`을 전달하므로 None과 int 비교에서 터진다.
- 수정 요지: 조건을 `self.can_delete_extra or (index is not None and index < initial_form_count)`로 변경. None 가드를 우항 앞에 추가해, index가 None이면 비교 자체를 건너뛰고 False로 평가되게 한다. 결과적으로 empty_form에는 DELETE 필드를 붙이지 않고(원래 의도대로 extra 폼에는 삭제 금지) 예외도 사라진다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_disable_delete_extra_formset_forms` (DjangoTemplates + Jinja2 두 변형).
- 기존 테스트는 `can_delete=True, can_delete_extra=False`인 formset에서 initial 폼(forms[0])에는 DELETE가 있고 extra 폼(forms[1], forms[2])에는 없음을 확인했다. test_patch는 여기에 한 줄 `self.assertNotIn("DELETE", formset.empty_form.fields)`를 추가한다. empty_form 접근이 곧 `add_fields(..., index=None)` 호출이므로, 패치 전에는 이 줄이 TypeError로 죽고(따라서 테스트 fail), 패치 후에는 예외 없이 empty_form에 DELETE 필드가 없음을 검증해 픽스를 증명한다.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement에 파일/라인/원인/수정안이 다 적혀 있어 사실상 좌표가 주어진다. `add_fields` 내 `index < initial_form_count` 단일 비교만 보면 됨. 단일 파일·단일 함수·한 줄 수정.
- 함정/난이도 메모: `index is not None` 가드를 우항 앞에 두는 단락 순서가 중요 — `(index < initial_form_count) and index is not None`처럼 순서를 바꾸면 여전히 터진다. 또한 같은 함수에 can_order(ORDERING_FIELD_NAME) 블록도 있지만 그쪽은 index를 비교하지 않으므로 손대면 안 됨(과수정 위험).
- 우리 에이전트 관점: 난이도 자체는 낮음. 막힐 만한 지점은 (1) 가드를 우항 앞에 정확히 배치하는 단락 평가 이해, (2) empty_form이 index=None으로 add_fields를 호출한다는 호출 경로를 굳이 추적하지 않아도 조건만 고치면 된다는 점을 신뢰하는 것. test 추가 라인이 empty_form.fields를 보므로, 픽스가 empty_form에 DELETE를 붙이지 않는다는 부수효과(의도된 동작)도 함께 만족해야 한다.
