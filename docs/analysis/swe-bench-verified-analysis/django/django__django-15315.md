---
instance_id: django__django-15315
repo: django/django
base_commit: 652c68ffeebd510a6f59e1b56b3e007d07683ad8
version: 4.1
difficulty: <15 min fix
created_at: 2022-01-13T18:51:58Z
fail_to_pass: 1
pass_to_pass: 33
gold_files: [django/db/models/fields/__init__.py]
---

# django__django-15315

## 문제 요약
`Field.__hash__()`가 필드를 모델 클래스에 할당하면 값이 바뀐다. 즉 필드를 dict 키로 먼저 넣은 뒤 모델에 `title = f`로 바인딩하면 해시가 달라져 `f in d`가 깨지고 `AssertionError`가 난다. 사용자는 객체의 해시가 불변(immutable)이길 기대한다 — 한번 dict에 들어간 키는 계속 조회 가능해야 한다. 이 버그는 #31750에서 도입됐다.

## 유형 분류
- 버그 카테고리: regression (API-contract 위반 — `__hash__` 불변성 계약 깨짐)
- 서브시스템: django ORM model fields (`django.db.models.fields.Field`)
- 증상 타입: 크래시 / silent-wrong (dict 조회 실패, AssertionError)
- 로컬라이제이션 신호: problem_statement가 정확히 `Field.__hash__`를 지목하고 "#31750에서 도입, revert하면 된다"고 명시 — 파일/함수 위치가 거의 직접 주어짐.

## 골드패치 분석
- 건드린 파일/함수: `django/db/models/fields/__init__.py` : `Field.__hash__`
- 근본 원인: #31750에서 `__hash__`가 `creation_counter`뿐 아니라 `self.model._meta.app_label` / `model_name`까지 해시에 섞도록 바뀌었다. 그런데 `self.model`은 필드가 모델 클래스에 contribute될 때(=할당 시점)에야 세팅되므로, 할당 전후로 `hasattr(self, 'model')` 결과가 바뀌어 해시 값이 변한다 → 불변성 위반.
- 수정 요지: `__hash__`를 `creation_counter`만으로 계산하도록 되돌린다. 모델 메타 정보(app_label/model_name) 의존을 제거. `creation_counter`는 필드 생성 시 한 번 정해지고 이후 변하지 않으므로 해시가 영구 불변이 된다. #31750이 우려한 동일 해시 충돌은 여전히 `__eq__`로 동등성 재검사하므로 안전.

## 검증 (test_patch)
- FAIL_TO_PASS: `test_hash_immutability` — 필드의 해시가 모델 할당 전후로 동일한지 검사.
- 증명 방식: `field = models.IntegerField()`로 만든 직후 `field_hash = hash(field)`를 캡처한다. 그 다음 `class MyModel(models.Model): rank = field`로 모델에 바인딩한다(여기서 `field.model`이 세팅됨). 마지막에 `assertEqual(field_hash, hash(field))` — 할당 후에도 해시가 그대로면 통과. 골드 이전엔 `model` 기반 항이 추가되며 해시가 달라져 실패. (기존 `test_field_ordering` 안에 있던 "서로 다른 모델 필드는 해시가 다르다"는 assertion 3줄은 제거됨 — 그 불변식 자체가 버그였으므로.)

## 공략 포인트 (뭘 조져야)
- 어디부터 봐야 하나: problem_statement가 `Field.__hash__`와 #31750을 명시하므로 `django/db/models/fields/__init__.py`의 `__hash__` 정의로 직행. localization은 사실상 공짜.
- 함정/난이도 메모: 단일 파일 단일 메서드 수정(7줄→1줄)로 난이도 매우 낮음. 다만 #31750이 `__hash__`를 강화한 의도(같은 creation_counter를 가진 abstract/inherit 필드 구분)를 보고 "그냥 되돌리면 회귀 아닌가?" 헷갈릴 수 있다 — 핵심은 동등성은 `__eq__`가, 해시는 단지 버킷팅만 담당하므로 해시 충돌은 무해하다는 점. `__eq__`/`__lt__`는 건드리면 안 됨.
- 우리 에이전트 관점: 막힐 위험은 거의 없음. 유일한 리스크는 "model 기반 항을 유지하되 fallback을 다르게" 같은 과한 수정으로 불변성을 못 보장하는 것. 골드처럼 `creation_counter`만 쓰는 최소 revert가 정답이며, test_patch가 제거한 기존 assertion까지 같이 손봐야 PASS_TO_PASS가 깨지지 않음(테스트는 골드가 제공하니 구현만 맞추면 됨).
