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
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1
knowledge: K-API
flags: [has-repro, regression-trap]
---

# django__django-15315

## 문제 요약
`Field.__hash__()`가 필드를 모델 클래스에 할당하면 값이 바뀐다. 필드를 dict 키로 먼저 넣은 뒤 모델에 `title = f`로 바인딩하면 해시가 달라져 `f in d`가 깨지고 `AssertionError`가 난다. problem_statement에 최소 재현 코드가 그대로 들어있다:
```python
f = models.CharField(max_length=200)
d = {f: 1}
class Book(models.Model):
    title = f
assert f in d   # AssertionError
```
사용자 기대는 단순하다 — 객체의 해시는 불변(immutable)이어야 하며, 한번 dict에 들어간 키는 계속 조회 가능해야 한다. 버그는 #31750에서 도입됐고, 이슈 본문이 "revert하면 된다"고 픽스 방향까지 적어준다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** problem_statement가 정확히 `Field.__hash__`를 지목하고, 도입 티켓(#31750)·revert 방향까지 명시한다. `__hash__` 정의로 grep 한 방이면 끝. 탐색 비용 사실상 0.
- **S (Repair Strategy) = S1 (Direct-Map).** 이슈가 픽스를 사실상 명세("revert the `__hash__` change"). 결함 클래스는 "mutable 상태를 해시에 섞음 → 해시 불변성 위반"으로 정형화되며, 픽스는 가변항(`self.model._meta.*`) 제거라는 기계적 패턴(상태 의존 제거)이다. 후보를 여러 개 만들어 테스트로 고르는 G&V(S3)나, 올바른 식을 추론 합성하는 S2가 아니다 — 정답 식이 이슈에 적혀있다.
- **K (Knowledge) = K-API (API-contract).** 일반 파이썬 추론만으로도 "해시는 불변이어야 한다"는 핵심은 닿지만, 이 문제의 본질은 `__hash__`/`__eq__` 계약(hashable object invariant: equal → 같은 해시, 그리고 **생애 동안 해시 불변**)을 정확히 지키는 것이다. 또한 #31750이 강화한 의도(`__eq__`의 abstract/inherit 필드 구분)와의 하위호환을 깨지 않아야 하므로 K-Gen보다 API 계약 쪽에 무게가 있다. django ORM 내부 깊은 도메인지식(K-Domain)까지는 불필요 — `self.model`이 contribute_to_class 시점에 늦게 세팅된다는 사실 하나면 충분하다.
- **primary type = T-DirectMap.** 위치가 명확(L0)하고 픽스가 기계적 S1(가변 상태 제거)이다. 이슈가 픽스를 거의 적어주지만 그래도 "왜 revert가 안전한가(해시 충돌은 `__eq__`가 흡수)"를 한 번 확인해야 하므로 완전 자명한 T-LocTrivial보다는 T-DirectMap이 방어 가능하다.

## 난이도 티어
**T2 (쉬움).** 이 티어로 미는 구조적 피처:
- **파일/줄수:** 1파일·1메서드, 7줄 → 1줄(`return hash(self.creation_counter)`). ICLR 2024의 "1파일·<5줄 ≈ 48% solve" 컷에 정확히 든다.
- **localize 직접성:** L0. 이슈가 심볼·도입티켓·revert방향을 다 준다.
- **has-repro:** 네이티브 재현 스니펫(AssertionError)이 본문에 있음 — 가장 강한 easiness 신호(해결률 ~87%).
- **약한 추론 1스텝:** 완전 무뇌 revert가 아니라 "해시 충돌이 무해함을 `__eq__`가 보장"을 1초 확인해야 하므로 T1(존나쉬움, 이슈가 거의 적어줌)보다 반 칸 위.
- **P2P trap:** PASS_TO_PASS 33개로 인접 동작(field equality/ordering/pickle/choices)을 안 깨야 함 → `regression-trap` 플래그. 다만 `__hash__`만 건드리고 `__eq__`/`__lt__`는 그대로 두면 안전하므로 trap이 강하지 않다.

공식 라벨(`<15 min fix`)과 **일치**한다. 공식은 개발자 구현시간 기준인데, 여기선 localize도 공짜·픽스도 1줄이라 에이전트 난이도도 동일하게 낮다. 굳이 차이를 두지 않는다.

## 골드패치 분석
- **건드린 파일·함수:** `django/db/models/fields/__init__.py` → `Field.__hash__`.
- **근본 원인:** #31750에서 `__hash__`가 `creation_counter` 외에 `self.model._meta.app_label`과 `self.model._meta.model_name`까지 (`hasattr(self, 'model')` 가드와 함께) 해시에 섞도록 바뀌었다. 그런데 `self.model`은 필드가 모델 클래스에 contribute될 때(=할당 시점)에야 세팅되므로, 할당 전엔 `hasattr(self,'model')==False`(model 항이 `None`), 할당 후엔 `True`(실제 app_label/model_name)로 바뀐다 → **같은 객체의 해시가 생애 중에 변한다 = hashable 불변성 위반.**
- **수정 요지:** 7줄 튜플 해시를 `return hash(self.creation_counter)` 한 줄로 되돌린다. `creation_counter`는 필드 인스턴스 생성 시 한 번 정해지고 이후 절대 변하지 않으므로 해시가 영구 불변이다. #31750이 강화하려던 동등성 구분은 `__eq__`/`__lt__`가 그대로 담당하며, 서로 다른 필드가 같은 해시를 가져도(해시 충돌) dict는 `__eq__`로 동등성을 재검사하므로 정확성에 무해하다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개):** `test_hash_immutability (model_fields.tests.BasicFieldTests)`.
  - 동작: `field = models.IntegerField()` 직후 `field_hash = hash(field)`를 캡처 → `class MyModel(models.Model): rank = field`로 바인딩(여기서 `field.model`이 세팅됨) → `assertEqual(field_hash, hash(field))`. 할당 후에도 해시가 같으면 통과.
  - 픽스 증명: 골드 이전엔 바인딩으로 model 기반 항이 추가돼 두 해시가 달라져 **실패(red)**. 골드 후엔 `creation_counter`만 쓰므로 바인딩 무관하게 동일 → **통과(green)**. 즉 테스트가 정확히 "할당 전후 해시 불변"이라는 픽스의 일반 속성을 관찰한다.
  - 부수: test_patch가 기존 `test_field_ordering` 내의 "서로 다른 모델 필드는 해시가 서로 다르다"는 assertion 3줄(`assertNotEqual(hash(...), hash(...))`)을 제거했다 — 그 불변식 자체가 버그(해시에 model을 섞어 만든 인공 구분)였기 때문. 이 assertion이 제거됐기에 PASS_TO_PASS의 ordering 테스트가 안 깨진다.
- **overfit 관점:** 테스트가 special-case가 아니라 "바인딩 전후 동일"이라는 일반 불변식을 직접 관찰하므로 `overfit-risk` 없음. `hash(self.creation_counter)`라는 정답이 이 입력공간을 균일하게 만족 → CEGIS(S4) 류 일반화 압력 없음.
- **regression 관점:** PASS_TO_PASS 33개가 field equality(`Field instances from abstract models are not equal.`), ordering(`Fields are ordered based on their creation.`), pickle(`Field instances can be pickled.`), choices/display 다수를 커버. 골드가 `__eq__`/`__lt__`/`creation_counter` 의미를 건드리지 않으므로 전부 유지된다 → `regression-trap` 플래그는 "인접 동작 폭은 넓으나 정답 픽스가 좁아 실제 위험 낮음"으로 해석.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈 본문이 `Field.__hash__`를 직접 지목하고 "#31750에서 도입, revert 가능"이라고 명시. `django/db/models/fields/__init__.py`의 `class Field`에서 `def __hash__`로 직행(L0, grep 한 방). 재현 스니펫의 `AssertionError`로 "dict in 검사 = 해시 기반"이라는 신호도 같은 곳을 가리킨다.
2. **픽스와 올바른 일반화인 이유:** `__hash__`를 `return hash(self.creation_counter)`로 되돌린다. `creation_counter`는 인스턴스 생성 시 고정·불변이므로 해시가 생애 동안 절대 안 변한다 = Python hashable 계약 충족. 이게 overfit이 아닌 이유: "특정 테스트만 통과"가 아니라 "해시 불변성"이라는 보편 속성을 회복하는 것이며, 모든 필드·모든 바인딩 시점에 균일하게 성립한다.
3. **regression 안전:** `__eq__`/`__lt__`는 절대 건드리지 않는다 — abstract/inherit 필드 구분은 동등성/순서가 담당하고 해시는 버킷팅만 한다. 해시 충돌(다른 필드가 같은 해시)은 dict가 `__eq__`로 재검사하므로 무해. 그래서 equality/ordering/pickle/choices 등 33개 P2P가 그대로 통과한다.
4. **함정 회피:** 오라클 없는 에이전트가 빠질 곳 두 가지. (a) #31750이 model을 해시에 넣은 "의도"를 보고 "되돌리면 회귀"라 오해해, model 항을 유지하되 fallback만 손보는 과한 수정 → 불변성을 여전히 못 지킴(틀림). 핵심은 **해시는 충돌해도 되지만 변하면 안 된다**는 점. (b) 구현만 고치고 test_patch가 제거한 기존 `assertNotEqual(hash...)` assertion을 남겨두면 P2P가 깨질 수 있다 — 그 assertion이 곧 버그 불변식이었음을 인지해야 한다(SWE-bench에선 테스트는 골드가 제공하니 구현만 최소 revert로 맞추면 됨). 정답은 가변 상태를 해시에서 빼는 최소 revert, 그 이상도 이하도 아니다.
