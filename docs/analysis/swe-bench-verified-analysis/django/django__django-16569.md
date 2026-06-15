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
primary_type: T-DirectMap
tier: T1
loc_axis: L0
repair_strategy: S1
knowledge: K-Gen
flags: [has-repro, regression-trap]
---

# django__django-16569

## 문제 요약
FormSet이 `can_delete=True`이고 `can_delete_extra=False`일 때, `add_fields()`에 `index=None`이 넘어오면 `TypeError: '<' not supported between instances of 'NoneType' and 'int'`가 발생한다. 이 조합은 대표적으로 `formset.empty_form`(빈 추가 폼) 렌더링 시 발생한다 — `empty_form`은 `add_fields(form, None)`을 호출하기 때문이다. 사용자가 기대하는 동작은 empty_form이 예외 없이 정상 렌더링되고, 거기엔 DELETE 필드가 붙지 않는 것이다. problem_statement에는 파일·라인·근본원인·수정안(`index is not None and ...`)·self-contained 재현코드까지 모두 적혀 있다.

## 유형 (정형화)
- **L (Localization) = L0 (Pinpointed).** problem_statement가 `django/forms/formsets.py` 493행과 정확한 비교식 `index < initial_form_count`를 직접 지목하고, 심지어 고칠 함수(`add_fields`)와 조건(`self.can_delete and (self.can_delete_extra or index < initial_form_count)`)을 그대로 인용한다. grep 한 방, 탐색 거의 0.
- **S (Repair Strategy) = S1 (Direct-Map / template).** 결함 클래스가 정형 None-가드 누락(None-guard before comparison)이며, 이슈가 사실상 픽스를 명세한다. 수정은 비교 우항 앞에 `index is not None` 가드를 추가하는 기계적 패턴 매칭 — PAR/TBar류 None-check insertion 템플릿에 그대로 들어맞는다. 추론으로 식을 합성(S2)할 필요도, 후보 다수에서 테스트로 선택(S3)할 필요도 없다.
- **K (Knowledge) = K-Gen (General).** 일반 파이썬 추론으로 충분하다. "None과 int 비교는 TypeError"라는 순수 파이썬 의미만 알면 되고, formset 내부 도메인 지식이 본질적 병목이 아니다. (empty_form이 index=None으로 호출한다는 호출경로는 이슈가 이미 설명해줬고, 조건만 고치면 추적 불요.)
- **primary type = T-DirectMap.** 위치가 명확(L0)하고 픽스가 기계적 None-가드(S1)이다. T-LocTrivial과의 경계가 가깝지만, 픽스가 "찾으면 자명한 상수/한 토큰"이 아니라 단락 평가 순서를 의식한 가드 삽입(우항 앞 배치)이라는 미세한 정형 패턴이 있으므로 T-DirectMap이 정확하다.

## 난이도 티어
**Tier = T1 (존나쉬움).** 공식 라벨 `<15 min fix`와 일치한다.
이 티어로 미는 구조적 피처:
- **파일/줄수:** 1파일·1함수·1조건문, 실효 변경 1줄(가드 절 추가). 1파일·<5줄 구간(≈48% solve 컷)의 가장 쉬운 쪽.
- **localize 직접성 (L0):** 이슈가 파일·라인·식·수정안까지 박아줌 — localization 실패(전체 실패의 ~51%) 위험이 거의 0.
- **has-repro:** self-contained 재현 스크립트 + 네이티브 스택 신호(TypeError 메시지)까지 제공 — 가장 강한 easiness 신호(해결률 ~87%).
- **K-Gen:** 도메인 지식 병목 없음.
유일하게 난이도를 살짝 올리는 요소는 `regression-trap`(PASS_TO_PASS 111개)지만, 픽스가 None일 때만 분기를 닫는 보수적 변경이라 인접 동작(index가 int인 정상 경로)을 건드리지 않으므로 T1을 T2로 올릴 만큼은 아니다. 공식 라벨과 본 티어가 일치하므로 별도 재조정 불요.

## 골드패치 분석
- **건드린 파일·함수:** `django/forms/formsets.py` → `BaseFormSet.add_fields(self, form, index)`.
- **근본 원인:** deletion 필드 추가 여부를 정하는 조건
  `if self.can_delete and (self.can_delete_extra or index < initial_form_count):`
  가 `index`가 None일 수 있음을 고려하지 않았다. `can_delete=True, can_delete_extra=False`이면 단락 평가(short-circuit)가 우항 `index < initial_form_count`까지 진행되는데, `empty_form` 경로는 `add_fields(form, None)`을 전달하므로 `None < int`에서 TypeError가 난다.
- **수정 요지:** 조건을
  `if self.can_delete and (self.can_delete_extra or (index is not None and index < initial_form_count)):`
  로 변경. `index is not None` 가드를 비교 **우항 앞**에 두어, index가 None이면 비교 자체를 건너뛰고 그 절이 False로 평가된다. 결과적으로 empty_form에는 DELETE 필드가 붙지 않고(원래 의도대로 extra/empty 폼에는 삭제 금지) 예외도 사라진다. index가 int인 기존 경로(initial 폼, extra 폼)는 평가 결과가 동일하게 유지된다.

## 검증 (test_patch)
- **FAIL_TO_PASS (2개):** `test_disable_delete_extra_formset_forms` — DjangoTemplates(`FormsFormsetTestCase`)와 Jinja2(`Jinja2FormsFormsetTestCase`) 두 변형.
- **픽스 증명:** 기존 테스트는 `can_delete=True, can_delete_extra=False` formset에서 initial 폼(`forms[0]`)에는 DELETE가 있고 extra 폼(`forms[1]`, `forms[2]`)에는 없음을 확인했다. test_patch는 여기에 한 줄
  `self.assertNotIn("DELETE", formset.empty_form.fields)`
  를 추가한다. `empty_form` 접근이 곧 `add_fields(..., index=None)` 호출이므로, 패치 전에는 이 줄이 TypeError로 죽어 테스트가 실패하고(에러 ⊂ fail), 패치 후에는 예외 없이 empty_form에 DELETE 필드가 없음을 검증해 픽스를 증명한다.
- **overfit 관점:** 추가된 단언은 "예외 없음 + DELETE 부재" 두 동작을 함께 본다. special-case로 통과시키는 우회(예: empty_form만 try/except로 가리기)는 "DELETE 부재"라는 의미적 기대를 자연스럽게 못 맞추므로 overfit 유인이 낮다. FAIL_TO_PASS가 얇긴 하나(2 변형 동일 시나리오) 픽스가 원인 자체(None 비교)를 제거하는 일반적 형태라 overfit-risk 플래그를 달지 않았다.
- **regression 관점:** PASS_TO_PASS 111개가 같은 `test_formsets.py` 영역(can_delete/can_order/max_num/empty_form/management form 등)을 광범위하게 덮는다(regression-trap). 픽스는 None일 때만 분기를 닫으므로 index가 int인 모든 기존 경로의 진리값이 보존되어 인접 동작을 깨지 않는다.

## 모범답안 (오라클 기반)
1. **localize 경로:** 이슈의 신호가 거의 좌표다 — 스택 메시지 `'<' not supported between 'NoneType' and 'int'` + 명시된 파일 `django/forms/formsets.py` + 라인의 비교식 `index < initial_form_count`. `add_fields`를 열어 `can_delete` 조건문의 우항 비교 하나만 보면 된다. 굳이 empty_form → add_fields(index=None) 호출경로를 따라가지 않아도 됨(이슈가 이미 설명).
2. **픽스 & 올바른 일반화:** 우항을 `(index is not None and index < initial_form_count)`로 감싼다. 이는 empty_form 한 경우만 막는 special-case가 아니라 "index가 None이면 'extra 폼이므로 삭제 불가'로 취급"이라는 의도된 시맨틱을 정확히 인코딩한다 — `can_delete_extra=False`의 정의(추가 폼엔 DELETE 금지)와 합치하므로 올바른 일반화다. None은 곧 "위치 없는 추가 폼"이고 그건 extra 취급이 맞다.
3. **regression 안전:** index가 정수인 모든 경로(initial 폼 `index < initial_form_count` → True, extra 폼 → False)는 가드가 통과해 기존 진리값 그대로다. 따라서 can_delete 일반 동작, can_order, max_num, management form 등 111개 P2P를 건드리지 않는다. 특히 `test_can_delete_extra_formset_forms`(initial엔 DELETE, extra엔 없음)가 그대로 유지되어야 함을 확인.
4. **함정 회피:** (a) **단락 순서** — 가드를 비교 **앞**에 둬야 한다. `(index < initial_form_count) and index is not None`처럼 순서를 뒤집으면 None 비교가 먼저 실행돼 여전히 터진다. (b) **과수정** — 같은 `add_fields`에 `can_order`(ORDERING_FIELD_NAME) 블록도 있지만 그쪽은 index를 `< initial_form_count`로 비교하지 않으므로 손대면 안 된다(불필요 변경 = 회귀/노이즈 위험). (c) **회피적 우회 금지** — empty_form 호출부를 try/except로 가리거나 index에 0 같은 임의값을 주입하면 DELETE 부재 단언을 깨거나 의미를 왜곡한다. 근본원인(None 비교)을 조건에서 제거하는 것이 정답.
