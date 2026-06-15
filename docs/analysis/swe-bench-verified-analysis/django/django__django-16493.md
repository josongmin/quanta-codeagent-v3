---
instance_id: django__django-16493
repo: django/django
base_commit: e3a4cee081cf60650b8824f0646383b79cb110e7
version: "5.0"
difficulty: 15 min - 1 hour
created_at: 2023-01-20T18:29:25Z
fail_to_pass: 1
pass_to_pass: 91
gold_files: [django/db/models/fields/files.py]
---

# django__django-16493

## 문제 요약
`FileField`의 `storage` 인자에 호출가능(callable)을 넘기고 그 callable이 `default_storage`를 반환하면, 필드를 deconstruct할 때 `storage` kwarg가 누락된다. 사용자는 makemigrations가 항상 `storage=myapp.models.get_storage`처럼 callable 참조를 포함하길 기대하지만, callable이 `default_storage`를 반환하는 순간(혹은 랜덤하게 반환할 때)에는 누락되어 마이그레이션이 비결정적으로 생성된다.

## 유형 분류
- 버그 카테고리: edge-case / logic (이전 수정 #31941의 불완전한 회귀)
- 서브시스템: django ORM / model fields (FileField deconstruct, migrations 직렬화)
- 증상 타입: silent-wrong (예외 없이 storage kwarg가 비결정적으로 사라짐 → 마이그레이션 흔들림)
- 로컬라이제이션 신호: problem_statement가 "deconstruct method tests if self.storage is not default_storage"와 "#31941 fix"를 직접 지목 → `files.py`의 `deconstruct`로 바로 연결됨

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/fields/files.py` : `FileField.deconstruct`
- 근본 원인: 비교 대상이 잘못됨. `if self.storage is not default_storage`에서 `self.storage`는 callable을 **평가한 결과**(evaluated storage)다. callable이 `default_storage`를 반환하면 이 비교가 False가 되어, 원래 callable 참조(`_storage_callable`)가 보존돼 있는데도 storage kwarg를 빼버린다.
- 수정 요지: 비교 대상을 평가된 storage가 아니라 **직렬화에 실제 쓸 값**으로 바꾼다. 먼저 `storage = getattr(self, "_storage_callable", self.storage)`로 (callable이면 callable 참조, 아니면 인스턴스) 값을 구하고, 그 `storage`가 `default_storage`가 아닐 때만 `kwargs["storage"] = storage`를 세팅한다. 즉 callable인 경우는 평가 결과와 무관하게 항상 callable 참조가 비교/저장 대상이 되어, default_storage를 반환하는 callable도 누락되지 않는다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_deconstruction_storage_callable_default` — "A callable that returns default_storage is not omitted when deconstructing."
- 증명 방식: `tests/file_storage/models.py`에 `callable_default_storage()`(= `default_storage` 반환)와 이를 쓰는 `storage_callable_default = models.FileField(storage=callable_default_storage, ...)` 필드를 추가. 테스트는 `Storage()._meta.get_field("storage_callable_default").deconstruct()`의 kwargs에서 `self.assertIs(kwargs["storage"], callable_default_storage)`를 단언한다. 픽스 전에는 `storage`가 default_storage로 평가돼 kwarg가 빠지므로 KeyError/누락으로 실패, 픽스 후에는 callable 참조가 보존되어 통과. 기존 `test_deconstruction`(non-default callable은 그대로 유지)은 PASS_TO_PASS로 회귀 방어.

## 공략 포인트 (뭘 조져야)
- 어디부터: `django/db/models/fields/files.py`의 `FileField.deconstruct` 단 한 메서드. problem_statement가 코드 라인까지 거의 짚어줌.
- 함정/난이도: 핵심은 `self.storage`(평가된 인스턴스) vs `_storage_callable`(원본 callable)의 구분. `_storage_callable`은 `storage` setter/__init__에서 callable일 때만 세팅된다는 점을 이해해야 함. 비교 순서를 그대로 두고 별도 분기를 추가하는 식의 어설픈 패치를 하면 callable 경로/비-callable 경로를 둘 다 깔끔히 못 다룬다 — 골드처럼 비교 대상 자체를 한 변수로 통일하는 게 정답.
- 우리 에이전트 관점: 2줄짜리 단순 픽스지만, "왜 self.storage가 이미 평가된 값인지"를 storage descriptor/`_storage_callable` 설정 경로까지 읽지 않으면 표면만 보고 `default_storage` 비교를 단순히 빼버리는 과교정(모든 storage를 항상 포함)으로 빠질 위험. PASS_TO_PASS의 "Deconstructing gives the original callable, not the evaluated value." 케이스가 이 과교정을 잡아낸다.
