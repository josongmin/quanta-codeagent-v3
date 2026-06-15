---
instance_id: django__django-13343
repo: django/django
base_commit: ece18207cbb64dd89014e279ac636a6c9829828e
version: 3.2
difficulty: 15 min - 1 hour
created_at: 2020-08-24T19:29:12Z
fail_to_pass: 1
pass_to_pass: 130
gold_files: [django/db/models/fields/files.py]
---

# django__django-13343

## 문제 요약
`FileField`에 `storage` 인자로 callable을 넘기면, 필드가 deconstruct될 때(즉 `makemigrations` 시) callable이 호출되어 "평가된 Storage 인스턴스"가 마이그레이션에 인라인된다. 이는 런타임마다 storage가 달라질 수 있다는 callable storage의 의도를 깨뜨린다. 사용자가 기대한 올바른 동작은 deconstruction 시 평가값이 아니라 원래 callable에 대한 참조를 반환하는 것이며, 이는 callable `upload_to`가 이미 그렇게 동작하는 것과 일관된다.

## 유형 분류
- 버그 카테고리: API-contract (deconstruct 계약 위반) / 누락처리
- 서브시스템: django ORM model fields / migrations(deconstruct)
- 증상 타입: silent-wrong (마이그레이션에 잘못된 값이 기록됨)
- 로컬라이제이션 신호: "FileField", "callable storage", "deconstruct", "makemigrations", 그리고 PR #8477 / ticket 28184 언급이 곧장 `FileField.__init__`의 callable storage 처리 코드와 `deconstruct()`로 연결된다.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/fields/files.py` — `FileField.__init__`, `FileField.deconstruct`
- 근본 원인: `__init__`에서 `if callable(self.storage): self.storage = self.storage()`로 callable을 즉시 평가하면서 원본 callable에 대한 참조를 어디에도 보관하지 않았다. 그래서 `deconstruct()`가 `kwargs['storage'] = self.storage`를 할 때 이미 평가된 Storage 인스턴스만 남아 있어 그것이 마이그레이션에 기록됐다.
- 수정 요지:
  - `__init__`에서 callable을 평가하기 직전에 `self._storage_callable = self.storage`로 원본 callable 참조를 따로 보관한다.
  - `deconstruct()`에서 `kwargs['storage'] = self.storage` 대신 `getattr(self, '_storage_callable', self.storage)`를 사용해, callable로 초기화된 경우엔 원본 callable을, 아니면 기존 storage 인스턴스를 반환한다.
  - `getattr` 기본값 덕분에 callable이 아닌 일반 storage 케이스는 기존 동작과 동일하게 유지된다.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_deconstruction (file_storage.tests.FieldCallableFileStorageTests)` — callable storage로 정의된 필드를 deconstruct하면 평가값이 아닌 원본 callable이 나와야 한다.
- 테스트는 모델의 `storage_callable` 필드를 `_meta.get_field(...).deconstruct()`로 분해해 `kwargs['storage']`를 꺼내고, `assertIs(storage, callable_storage)`로 그 값이 평가된 인스턴스가 아니라 `models.py`에 정의된 원본 `callable_storage` 함수 객체 그 자체임을 동일성(`is`)으로 확인한다. 즉 재현 입력은 "callable storage를 가진 FileField", 기대 출력은 "deconstruct 결과의 storage == 원본 callable".

## 공략 포인트 (뭘 조져야)
- localization 전략: `git grep -n "callable(self.storage)"` 또는 `FileField` 클래스의 `__init__`/`deconstruct` 두 메서드만 보면 된다. 단일 파일·단일 클래스로 범위가 매우 좁다.
- 함정/난이도 메모:
  - 평가는 `__init__`에서 한 번만 일어나므로, 원본 callable을 "평가 직전"에 저장해야 한다. 평가 후엔 callable이 사라진다.
  - `deconstruct()`에서 무조건 `_storage_callable`을 쓰면 callable이 아닌 일반 storage 케이스에서 AttributeError가 난다 — `getattr(..., self.storage)` 기본값 패턴이 핵심이며 이걸 놓치기 쉽다.
  - 이미 동일하게 동작하는 callable `upload_to` 처리를 참고 모델로 삼으면 일관된 해법을 빠르게 유도할 수 있다.
- 우리 에이전트 관점: 막힐 지점은 "왜 deconstruct가 평가값을 보냐"의 인과를 `__init__`까지 거슬러 추적하는 부분. deconstruct만 보고 임시변통(예: 재호출/역추적)으로 고치려 하면 원본 callable을 복원할 수 없어 막힌다. 상태를 `__init__`에서 보존해야 한다는 점을 잡아야 깔끔하게 통과한다.
