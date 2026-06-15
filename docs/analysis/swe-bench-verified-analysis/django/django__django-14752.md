---
instance_id: django__django-14752
repo: django/django
base_commit: b64db05b9cedd96905d637a2d824cbbf428e40e7
version: 4.0
difficulty: <15 min fix
created_at: 2021-08-07T16:34:32Z
fail_to_pass: 1
pass_to_pass: 15
gold_files: [django/contrib/admin/views/autocomplete.py]
primary_type: T-DesignRefactor
tier: T2
loc_axis: L0
repair_strategy: S6 (+S1)
knowledge: K-API
flags: [regression-trap]
---

# django__django-14752

## 문제 요약
admin의 autocomplete foreign key 필드 결과(JSON)에 커스텀 필드를 추가하려면 현재는 `AutocompleteJsonView.get()` 메서드 전체를 오버라이드해야 한다. 결과 dict를 만드는 코드(`{'id': str(getattr(obj, to_field_name)), 'text': str(obj)}`)가 `get()` 안 list comprehension에 인라인으로 박혀 있어, 한 필드만 추가하려 해도 `get()` 전체를 복붙해야 하고 `get()`이 계속 진화하면 유지보수 부담이 커진다. 이슈는 "결과 직렬화 로직만 `serialize_result()` 메서드로 떼어내 확장 지점(extension point)을 만들자"고 제안하며, 메서드 시그니처·본문·호출부 교체까지 사실상 패치를 제시한다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** problem_statement가 파일·클래스·메서드를 직접 지목(`contrib.admin.views.autocomplete.AutocompleteJsonView.get()`)하고, 추출할 코드 라인과 신규 `serialize_result()` 시그니처/본문까지 명시한다. grep 한 방, 후보 탐색 자체가 불필요.
- **S (Repair Strategy) = S6 Design-Refactor (+S1).** 한 줄 가드/상수 변경이 아니라 **인라인 표현식 → 메서드 추출(extract-method)** 이라는 작은 구조 변경이 본질이다: 호출부를 `self.serialize_result(obj, to_field_name)`로 바꾸고 동일 로직을 담은 새 메서드를 클래스에 추가해 오버라이드 가능한 seam을 만든다. 추출되는 변환 자체는 기계적(S1)이라 보조로 표기.
- **K (Knowledge) = K-API.** 일반 파이썬 리팩터링 능력으로 추출은 가능하나, 이건 django **public extension point**를 신설하는 일이라 시그니처(`(self, obj, to_field_name)`)·리턴 dict 키(`id`/`text`)·기본 동작이 기존 출력과 정확히 호환되어야 한다(서브클래스의 `super().serialize_result(...)` 계약). 도메인 내부지식(ORM/쿼리컴파일러)은 불필요하므로 K-Domain은 아니다.
- **primary type = T-DesignRefactor.** dominant 신호가 "조율된 구조 변경(extract-method로 확장 seam 도입)"이라 S6 = T-DesignRefactor. 위치는 자명(L0)하고 버그 증상도 없어 T-DirectMap/T-ConstraintReason은 부적합 — 핵심 난점이 "올바른 식 추론"이 아니라 "동작 보존 리팩터링"에 있다.
- **왜 이 strategy인가 (APR 관점):** 실패테스트(`test_serialize_result`)가 요구하는 건 새 값의 계산이 아니라 *오버라이드 가능한 메서드의 존재*다. 즉 픽스는 패치 후보를 generate-&-validate로 수렴시키는 문제(S3/S4)가 아니라, 코드 구조를 재배치해 hook point를 만드는 정형 리팩터링(S6)이다. overfit 위험이 낮은 이유도 여기서 나온다 — 메서드 추출은 동작을 정의상 보존하므로 special-case 통과가 성립할 수 없다.

## 난이도 티어
**Tier = T2 (쉬움).** 공식 라벨 `<15 min fix`(=T1급 prior)와 거의 일치하나 한 칸 올린다. 구조적 피처:
- **1파일·소규모(+8줄)**: `autocomplete.py` 단일 파일, 신규 메서드 5줄 + 호출부 1줄 교체 + docstring. 파일수/줄수 컷(≥3파일·>100줄 → <10% solve)에서 한참 안쪽이라 난이도 하방.
- **L0 + 청사진 제시**: localize가 자명하고 이슈가 패치를 거의 적어줘서 T1 후보. 그러나 S1 "픽스 자명"이 아니라 S6 "동작 보존 리팩터링"이라는 점, 그리고 **regression-trap(P2P 15개)** 이 존재한다는 점이 순수 T1에서 T2로 민다.
- **버그 증상 부재**: 재현 스택트레이스가 없는 리팩터링 요청이라 has-repro 신호(해결률 ~87%)는 없다. 에이전트는 "고칠 버그가 없는데 무엇을 바꿀까"를 이슈 본문에서 재구성해야 하므로 순수 T1보다 미세하게 어렵다. 다만 본문이 명세 수준으로 상세해 underspecified는 아니다.
- **공식 difficulty와의 차이**: 공식은 "개발자 구현시간 <15분"으로 T1을 시사하나, 루브릭은 시간라벨에 안 잡히는 regression-trap(인접 동작 15개 보존)을 반영해 T2로 둔다. 에이전트 난이도 차이는 미미.

## 골드패치 분석
- **건드린 파일/함수**: `django/contrib/admin/views/autocomplete.py` — `AutocompleteJsonView.get()` 수정 + 신규 메서드 `AutocompleteJsonView.serialize_result(self, obj, to_field_name)`.
- **근본 원인**: 결과 객체→dict 변환 표현식 `{'id': str(getattr(obj, to_field_name)), 'text': str(obj)}`이 `get()` 내부 list comprehension에 인라인으로 하드코딩되어 있어, 출력 형태를 바꾸려면 `get()` 전체를 오버라이드하는 수밖에 없었다 — 확장 seam 부재.
- **수정 요지**: (1) `get()`의 인라인 dict 표현식을 `self.serialize_result(obj, to_field_name)` 호출로 교체. (2) 동일 변환 로직을 담은 새 메서드 `serialize_result(self, obj, to_field_name)` 추가(기본 리턴은 기존과 byte-identical). (3) `get()` docstring을 "Return a JsonResponse ... as defined in serialize_result(), by default:"로 갱신해 확장 지점을 문서화. 기본 동작은 완전 동일하고, 서브클래스가 `serialize_result()`만 오버라이드(예: `super().serialize_result(...)`에 키 추가)하면 필드를 확장할 수 있다.

## 검증 (test_patch)
- **FAIL_TO_PASS (1개)**: `test_serialize_result (admin_views.test_autocomplete_view.AutocompleteJsonViewTests)`. `AutocompleteJsonView`를 상속한 `AutocompleteJsonSerializeResultView`가 `serialize_result()`에서 `{**super().serialize_result(obj, to_field_name), 'posted': str(obj.posted)}`로 `'posted'` 키를 추가하도록 정의하고, 응답 JSON이 `{'id', 'text', 'posted'}` 3키 결과(`-posted` 정렬, Question 2건)와 일치하는지 `assertEqual`.
- **픽스 증명**: 테스트가 `super().serialize_result(...)`를 호출하므로 부모 클래스에 해당 메서드가 **존재해야만** 통과한다. 추출이 안 되어 있으면 `AttributeError`로 즉시 실패 → 메서드 seam 도입을 직접 강제한다. 또한 결과가 `{'id', 'text'}` 기본 키를 유지한 채 `'posted'`가 더해지는지 검사하므로 기본 직렬화 호환성도 동시에 증명.
- **overfit 관점**: extract-method는 동작 보존 변환이라 special-case로 우회 통과가 불가능 — overfit-risk 플래그 없음. 테스트가 얇긴(F2P=1) 하나, "오버라이드 가능한 메서드 존재 + 기본 출력 보존"이라는 검사 자체가 구조를 못박아 CEGIS류 일반화 갭이 생기지 않는다.
- **regression 관점**: PASS_TO_PASS 15개(`test_success`, `test_custom_to_field`, `test_custom_to_field_custom_pk`, 페이지네이션·권한·to_field 해석 등)가 **기본 출력 형태·정렬·페이지네이션이 깨지지 않음**을 보장한다. 추출 시 `to_field_name` 전달 누락이나 키 변경이 있으면 이들이 즉시 RED → regression-trap이 실재.

## 모범답안 (오라클 기반)
1. **localize 경로**: 이슈가 `contrib.admin.views.autocomplete.AutocompleteJsonView.get()`을 명시 → `django/contrib/admin/views/autocomplete.py`를 열어 `get()` 내부 `JsonResponse({'results': [...]})`의 list comprehension에서 인라인 dict 표현식을 식별. 탐색 노력 거의 0(L0).
2. **픽스와 일반화 정당성**: 인라인 `{'id': str(getattr(obj, to_field_name)), 'text': str(obj)}`를 새 메서드 `serialize_result(self, obj, to_field_name)`로 추출하고 comprehension은 `self.serialize_result(obj, to_field_name)`을 호출. 이게 올바른 일반화인 이유 — 추출된 기본 메서드의 출력은 기존과 동일(동작 보존)하면서, 인스턴스 메서드로 만들어 임의 서브클래스가 오버라이드할 수 있는 다형성 seam이 생긴다. 특정 필드(`posted`)에 하드코딩하지 않고 메서드 경계만 도입하므로 테스트가 요구한 임의 확장을 일반적으로 충족.
3. **regression 안전**: P2P 15개를 보존해야 한다 — 특히 `test_success`(기본 `{id,text}` 형태)·`test_custom_to_field`/`test_custom_to_field_custom_pk`(`to_field_name`이 pk 외 필드로 정확히 전달돼야 함)·페이지네이션/권한 테스트. 따라서 추출 시 `to_field_name`을 인자로 그대로 넘기고, 기본 리턴 dict의 키·`str(...)` 강제를 한 글자도 바꾸지 않는 것이 핵심.
4. **함정 회피**: (a) 이슈 예시 코드의 오타·관용을 그대로 베끼지 말 것 — 본문은 `super.serialize_result`(괄호 없는 속성 오타)와 `| {'notes': ...}`(3.9+ dict merge)를 쓰는데, 정석은 `super().serialize_result(...)`와 메서드 추출만. (b) "리팩터링 요청"이라 고칠 버그 증상이 없어 에이전트가 직렬화 외 다른 곳까지 손대는 과수정 위험 — 변경은 `get()` 한 곳 + 신규 메서드로 한정. (c) `to_field_name`을 메서드 인자에서 누락하거나 `self.to_field_name`으로 잘못 끌어오면 P2P의 custom-to_field 테스트가 깨진다. (d) docstring 갱신은 동작과 무관하나 오라클 패치에 포함 — 핵심은 아니므로 생략해도 테스트는 통과한다.
