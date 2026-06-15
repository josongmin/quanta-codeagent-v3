---
instance_id: django__django-12406
repo: django/django
base_commit: 335c9c94acf263901fb023404408880245b0c4b4
version: 3.1
difficulty: 15 min - 1 hour
created_at: 2020-02-02T16:34:05Z
fail_to_pass: 3
pass_to_pass: 165
gold_files: [django/db/models/fields/related.py, django/forms/models.py]
---

# django__django-12406

## 문제 요약
ForeignKey 모델 필드를 `RadioSelect` 위젯으로 ModelForm에 렌더링하면, 모델에서 `blank=False`인데도 빈 옵션(`---------`)이 라디오 선택지로 같이 나오고 심지어 checked 상태로 표시된다. select 위젯에서는 빈 옵션이 관용적이지만, 라디오는 "미선택" 상태가 본래 존재하므로 `---------`가 유효한 선택지처럼 보인다. 사용자는 `blank=False`이면 라디오에 빈 옵션이 없어야 한다고 기대한다.

## 유형 분류
- 버그 카테고리: API-contract / 누락처리 (위젯 종류에 따른 empty_label 분기 누락)
- 서브시스템: django forms (ModelChoiceField) + ORM ForeignKey.formfield
- 증상 타입: 잘못된 출력 (불필요한/오해 소지 있는 빈 선택지 렌더링)
- 로컬라이제이션 신호: problem_statement가 "RadioSelect"와 "blank=False"를 명시 → 빈 옵션을 결정하는 `empty_label` 로직(ModelChoiceField)과, 모델 필드의 blank를 폼 필드로 전달하는 ForeignKey.formfield가 핵심 지점.

## 골드패치 분석
- 건드린 파일/함수:
  - `django/forms/models.py:ModelChoiceField.__init__`
  - `django/db/models/fields/related.py:ForeignKey.formfield`
- 근본 원인: `ModelChoiceField`는 `empty_label`을 `required and initial is not None`일 때만 None으로 만들고, 그 외에는 항상 `---------`를 노출했다. 위젯이 RadioSelect인지, 모델 필드가 blank을 허용하는지는 전혀 고려하지 않았다. 또한 폼 필드가 모델의 `blank` 정보를 받을 통로 자체가 없었다.
- 수정 요지:
  - `ModelChoiceField.__init__`에 `blank=False` 키워드 인자를 추가. empty_label 결정 로직을 `Field.__init__` 이후로 옮겨 `self.widget`을 확정한 뒤, `(required and initial is not None) or (isinstance(self.widget, RadioSelect) and not blank)`이면 `empty_label = None`으로 설정.
  - `RadioSelect`를 forms/models.py import에 추가.
  - `ForeignKey.formfield`에서 formfield 생성 kwargs에 `'blank': self.blank`를 끼워넣어 모델의 blank 값을 ModelChoiceField로 전달.

## 검증 (test_patch)
- FAIL_TO_PASS:
  - `test_choices_radio_blank`: ModelChoiceField를 RadioSelect 위젯 + `blank=True/False` 조합으로 생성하고, blank=True면 `[('', '---------')] + choices`, blank=False면 빈 옵션 없는 `choices`가 나오는지 검증.
  - `test_non_blank_foreign_key_with_radio`: `Award.character`(blank=False FK)를 RadioSelect로 렌더한 ModelForm의 choices에 빈 옵션이 없어야 함.
  - `test_clean_model_instance`: empty_label 분기 이동에 따른 회귀 보호.
- 증명 방식: blank=False + RadioSelect → 빈 옵션 제거(기대), blank=True → 빈 옵션 유지(기존 동작 보존). `PASS_TO_PASS`의 `test_blank_foreign_key_with_radio`(blank=True FK)가 select식 빈 옵션 유지를 함께 보장하여 양방향 회귀를 막는다. Character 모델에 `__str__`을 추가해 'user' 라벨이 안정적으로 나오게 함.

## 공략 포인트 (뭘 조져야)
- localization 전략: `empty_label`을 None으로 만드는 단일 조건문(forms/models.py ModelChoiceField.__init__)이 출발점. 거기서 위젯/ blank을 못 보는 게 핵심. 그 다음 "모델 blank이 폼 필드로 어떻게 전달되나"를 역추적하면 ForeignKey.formfield의 kwargs 조립부에 도달.
- 함정/난이도 메모:
  - 멀티파일(forms + ORM related)이라 한쪽만 고치면 실패. `blank` 인자만 추가하고 formfield에서 안 넘기면 항상 False로 동작.
  - empty_label 분기를 `Field.__init__` 앞에 두면 `self.widget`이 아직 위젯 인스턴스로 확정되지 않아 isinstance 체크가 깨진다 → 골드는 의도적으로 분기를 init 뒤로 이동.
  - 위젯이 클래스(`RadioSelect`)로 올 수도, 인스턴스(`RadioSelect()`)로 올 수도 있는데 `self.widget`은 Field가 인스턴스화하므로 isinstance가 둘 다 커버. 테스트도 두 형태를 모두 돈다.
- 우리 에이전트 관점: forms 한 파일만 고치고 끝내기 쉬운 함정. blank 전달 경로(related.py)까지 따라가야 FK 시나리오 테스트가 통과한다. 또 빈 옵션 제거 조건을 widget 무관하게 넓히면 select의 빈 옵션까지 없애 PASS_TO_PASS를 깨므로, RadioSelect로 한정해야 한다.
