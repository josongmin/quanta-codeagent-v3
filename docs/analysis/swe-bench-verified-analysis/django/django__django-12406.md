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
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain
flags: [regression-trap, cross-file-dep, has-repro]
---

# django__django-12406

## 문제 요약
ForeignKey 모델 필드를 `RadioSelect` 위젯으로 ModelForm에 렌더링하면, 모델이 `blank=False`인데도 빈 옵션(`---------`)이 라디오 선택지로 같이 나오고 심지어 checked 상태로 표시된다. select 위젯에서는 빈 옵션(`---------`)이 required 필드에서도 관용적이지만, 라디오는 "아무것도 선택 안 함"이라는 본래적 미선택 상태가 있어서 `---------`가 마치 유효한 선택지처럼 보인다. 사용자가 기대하는 동작은: 모델이 `blank=False`(빈 값이 유효한 선택이 아님)이면 RadioSelect 렌더 시 빈 옵션이 아예 없어야 한다. problem_statement에 재현 모델/폼/렌더 HTML이 그대로 들어있다(has-repro).

## 유형 (정형화)

- **L (Localization) = L3 — Multi-site.** 픽스가 `django/forms/models.py`의 `ModelChoiceField.__init__`와 `django/db/models/fields/related.py`의 `ForeignKey.formfield` **두 파일·두 함수에 걸쳐 함께** 바뀌어야 성립한다. forms 쪽에 `blank` 파라미터를 받는 통로를 뚫어도, ORM 쪽 `formfield`가 `'blank': self.blank`를 안 넘기면 FK 시나리오는 항상 `blank=False`로 동작해 실패한다. 한쪽만 고치면 깨지는 전형적 조율 멀티사이트. (problem_statement가 심볼을 직접 지목하진 않아 진입은 L0~L1이지만, 픽스의 *완결*에는 cross-module 데이터플로우 배선이 필수 → L3.)
- **S (Repair Strategy) = S6 Design-Refactor (+S2 Constraint-Reasoning).** 한 줄 패치가 아니다. (1) `ModelChoiceField.__init__` 시그니처에 `blank=False` **파라미터를 도입**하고, (2) empty_label 결정 분기를 `Field.__init__` 호출 *뒤*로 **재배치**해야 `self.widget`이 위젯 인스턴스로 확정된 상태에서 `isinstance` 체크가 성립하며, (3) ORM `formfield` kwargs 조립부에 새 인자를 **배선**하는 소규모 구조 변경이다(=S6). 동시에 새 조건식 `(required and initial is not None) or (isinstance(self.widget, RadioSelect) and not blank)`를 **불변식 추론으로 합성**해야 하므로 S2가 보조로 붙는다. APR 관점: 후보를 마구 생성해 테스트로 거르는 G&V(S3)나 단일 가드 삽입 템플릿(S1)으로는 안 풀린다 — "lifecycle 재배치(분기 이동) + 파라미터 도입 + cross-file 배선"이라는 조율된 변경이 본질이라 S6가 dominant.
- **K (Knowledge) = K-Domain.** django forms 내부 지식 의존이 병목이다: `ModelChoiceField`가 `ChoiceField.__init__`을 우회하고 `Field.__init__`을 직접 호출하는 관례, `empty_label`의 의미, `ForeignKey.formfield`가 폼 필드 kwargs를 조립해 모델 메타데이터(`self.blank`)를 폼 계층으로 전달하는 경로, `RadioSelect`가 `Select` 계열과 갖는 의미 차이를 알아야 한다. 일반 파이썬 추론(K-Gen)만으로는 "왜 위젯이 확정된 뒤에 분기해야 하는지"를 도출할 수 없다.

**primary type = T-DesignRefactor.** 진입 localize 자체는 그리 어렵지 않고(RadioSelect/blank/empty_label 키워드로 수렴), 진짜 작업은 파라미터 도입 + 분기 lifecycle 재배치 + cross-file 배선이라는 **조율된 소규모 구조 변경**이다. T-DiffuseLoc(찾기가 난점)이 아니라 S6 design이 dominant라 T-DesignRefactor로 라벨링한다.

## 난이도 티어
**T4 — 약간 어려움.** 공식 difficulty 라벨은 "15 min - 1 hour"(T2~T3 prior).

이 티어로 미는 구조적 피처:
- **L3 멀티파일 조율(cross-file-dep)**: 2파일·2함수가 함께 바뀌어야 하고, ORM→forms 데이터플로우 배선이 누락되면 조용히 실패. 단일파일 픽스가 아니라는 점이 T2/T3 위로 민다.
- **S6 구조 변경 + S2 추론**: 단순 가드 삽입이 아니라 파라미터 도입·분기 재배치가 필요. 특히 분기를 `Field.__init__` 뒤로 옮겨야 `self.widget`이 확정되는 순서 의존성은 비자명한 함정.
- **K-Domain**: django forms/ORM 내부 관례 의존.
- **regression-trap(P2P=165)**: 인접 동작이 매우 넓다. 빈 옵션 제거 조건을 위젯 무관하게 넓히면 select의 빈 옵션까지 없애 `test_choices`, `test_choices_bool`, `test_choices_bool_empty_label` 등 다수 P2P가 깨진다. RadioSelect로 한정해야만 안전.

**공식 라벨(<1h)보다 높게(T4) 잡는 이유**: 공식 difficulty는 *PR을 가진 인간 개발자의 구현 시간*이라 cross-file 배선과 분기 순서 의존성이 "알면 빠른" 작업으로 보인다. 그러나 오라클 없는 에이전트 관점에선 (a) forms 한 파일만 고치고 끝내는 함정, (b) RadioSelect 한정 없이 조건을 넓혀 광범위 P2P를 깨는 overfit-역방향 함정이 실재한다. localize 직접성은 좋지만 픽스 완결의 멀티사이트성·도메인성·P2P trap이 T4로 민다. (단, F2P가 동작을 양방향(blank True/False)으로 핀하고 has-repro라 T5까지는 안 간다.)

## 골드패치 분석
- **건드린 파일·함수**
  - `django/forms/models.py` — `ModelChoiceField.__init__` (+ import에 `RadioSelect` 추가)
  - `django/db/models/fields/related.py` — `ForeignKey.formfield`
- **근본 원인**: `ModelChoiceField`는 `empty_label`을 `required and (initial is not None)`일 때만 `None`으로 만들고, 그 외에는 무조건 `---------`를 노출했다. 위젯이 `RadioSelect`인지, 모델 필드가 빈 값을 허용(`blank`)하는지를 전혀 고려하지 않았다. 게다가 폼 필드가 모델의 `blank` 정보를 받을 통로 자체가 없어서(ORM `formfield`가 `blank`을 안 넘김), forms 계층은 모델의 blank 여부를 알 수가 없었다.
- **수정 요지**
  - `ModelChoiceField.__init__` 시그니처에 `blank=False` 키워드 인자 추가.
  - empty_label 결정 분기를 `Field.__init__(...)` 호출 *뒤*로 이동 — 그래야 `self.widget`이 위젯 인스턴스로 확정되어 `isinstance(self.widget, RadioSelect)`가 유효. 새 조건: `(required and initial is not None) or (isinstance(self.widget, RadioSelect) and not blank)`이면 `self.empty_label = None`, 아니면 `self.empty_label = empty_label`.
  - `from django.forms.widgets import (..., RadioSelect, ...)` import 추가.
  - `ForeignKey.formfield`의 formfield 생성 kwargs 딕셔너리에 `'blank': self.blank`를 추가해 모델의 blank 값을 `ModelChoiceField`로 흘려보냄.

## 검증 (test_patch)
- **FAIL_TO_PASS (3)**
  - `test_choices_radio_blank` (test_modelchoicefield): `ModelChoiceField`를 위젯=`RadioSelect`/`RadioSelect()` × `blank=True/False` 4조합으로 생성하고, `blank=True`면 `[('', '---------')] + choices`, `blank=False`면 빈 옵션 없는 `choices`가 나오는지 검증. 위젯이 **클래스/인스턴스** 둘 다로 올 수 있음을 핀.
  - `test_non_blank_foreign_key_with_radio` (tests): `Award.character`(blank=False FK)를 `RadioSelect`로 렌더한 ModelForm의 `choices`에 빈 옵션이 없고 `(character.pk, 'user')`만 나오는지 검증. **주의 — 이 테스트는 ORM→forms `blank` 배선 자체를 검증하지 않는다.** `Award.character`는 `blank=False`이고 `ModelChoiceField`의 `blank` 기본값도 `False`라, ORM `formfield`가 `'blank'`을 안 넘겨도 기본값 `False`로 폴백 → 조건 `isinstance(widget, RadioSelect) and not blank`이 `True`가 되어 empty_label이 제거되고 기대 결과 `[(character.pk,'user')]`가 그대로 나온다(배선 유무와 무관하게 통과). 배선을 실제로 검증하는 건 `blank=True` FK인 `test_blank_foreign_key_with_radio`(PASS_TO_PASS)다 — 배선이 없으면 `blank`이 `False`로 잘못 폴백해 empty 옵션이 부당하게 제거되어 깨진다.
  - `test_clean_model_instance` (test_modelchoicefield): **분기 이동의 영향을 받지 않는다(behavior-preserving).** `ModelChoiceField(Category.objects.all())`는 required=True/initial=None/기본 Select 위젯이라, 분기 이동 전후 모두 `(required and initial is not None)=False`, `isinstance(Select, RadioSelect)=False`이므로 empty_label=`'---------'`로 동일하게 계산된다. base에서 FAIL로 잡히는 진짜 이유는 행위 변화가 아니라, 같은 모듈에 추가된 `test_choices_radio_blank`가 base에서 `ModelChoiceField(..., blank=...)` 호출 시 TypeError를 내는(base `Field.__init__`이 `blank`·`**kwargs` 미수용) 콜렉션/결과파싱 아티팩트다. 골드패치는 이 테스트를 수정하지 않으며(real commit `da79ee472d`도 미수정), 실제 behavioral 픽스가 아니다.
- **픽스 증명**: `blank=False` + RadioSelect → 빈 옵션 제거(신규 기대), `blank=True` → 빈 옵션 유지(기존 동작 보존). 테스트가 양방향(True/False)을 모두 핀하므로 "그냥 항상 제거"하는 special-case로는 통과 못 함. 테스트 모델 `Character`에 `__str__`(`return self.username`)을 추가해 'user' 라벨이 안정적으로 나오게 함.
- **overfit 관점**: F2P가 blank True/False 양방향 + 위젯 클래스/인스턴스 양형태를 핀해서 얇은 special-case 통과를 차단(overfit-risk 낮음, 그래서 플래그 미부여). 다만 RadioSelect 한정을 안 지키고 조건을 넓히면 통과는커녕 P2P가 깨지는 방향이라 자연스러운 가드가 걸린다.
- **regression 관점**: P2P=165로 광범위. 특히 `test_blank_foreign_key_with_radio`(blank=True FK는 빈 옵션 유지), `test_choices`/`test_choices_bool`/`test_choices_bool_empty_label`(select 계열 빈 옵션 동작)이 select·blank=True 경로의 빈 옵션 유지를 함께 보장 → 양방향 회귀 차단.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement의 두 신호 `RadioSelect`와 `blank=False`에서 출발. `---------`/`empty_label` 키워드로 `django/forms/models.py`의 `ModelChoiceField.__init__`에 있는 empty_label 결정 분기를 찾는다(빈 옵션을 만드는 단일 지점). 이게 위젯·blank을 못 본다는 게 핵심. 이어서 "모델의 blank이 폼 필드로 어떻게 전달되나"를 역추적 → `django/db/models/fields/related.py`의 `ForeignKey.formfield` kwargs 조립부에 도달(여기엔 blank이 안 실려 있음 = 배선 누락 지점).
2. **픽스와 올바른 일반화 이유**: `ModelChoiceField.__init__`에 `blank=False`를 받고, 분기를 `Field.__init__` 뒤로 옮긴 뒤 `(required and initial is not None) or (isinstance(self.widget, RadioSelect) and not blank)`로 empty_label을 None 처리. `ForeignKey.formfield`에서 `'blank': self.blank`로 모델 메타를 전달. 이게 overfit이 아니라 올바른 일반화인 이유: 빈 옵션 억제를 **RadioSelect & not blank로만** 한정했기 때문에 select 위젯/blank=True 경로의 기존 의미(빈 옵션 관용)는 정확히 보존되고, FK가 아닌 직접 생성 `ModelChoiceField`도 새 파라미터로 동일하게 제어된다. 분기를 init 뒤로 옮긴 것도 "위젯 인스턴스 확정 후 isinstance"라는 정확한 불변식을 지키는 일반화다.
3. **regression 안전**: select 계열 빈 옵션 동작(`test_choices*`, `test_choices_bool*`)과 blank=True FK의 빈 옵션 유지(`test_blank_foreign_key_with_radio`)를 깨면 안 된다. 조건을 `isinstance(self.widget, RadioSelect)`로 묶어 다른 위젯 경로는 한 글자도 안 건드리는 게 165개 P2P를 지키는 핵심. `Field.__init__` 우회 호출 관례(ChoiceField를 안 거침)도 유지해야 함.
4. **함정 회피(오라클 없는 에이전트가 틀릴 지점)**:
   - **단일파일 함정**: `django/forms/models.py`만 고치고 끝내기 쉽다. forms-only 픽스 시 FK는 `blank` 정보를 못 받아 `blank=False`로 폴백한다. 이는 non-blank FK에 대해선 *정답*이라 `test_non_blank_foreign_key_with_radio`는 오히려 통과한다. 배선 누락으로 깨지는 건 `blank=True` FK 케이스(`test_blank_foreign_key_with_radio`, PASS_TO_PASS)다 — `blank`이 `False`로 잘못 폴백해 empty 옵션이 부당하게 제거되기 때문. 즉 단일파일 함정을 잡아내는 테스트는 `non_blank`가 아니라 `blank=True` FK 쪽이다. ORM `formfield`까지 배선해야 완결.
   - **분기 순서 함정**: empty_label 분기를 `Field.__init__` *앞*에 두면 `self.widget`이 아직 위젯 인스턴스로 확정 안 돼 `isinstance` 체크가 항상 거짓이 되거나 깨진다. 골드처럼 init *뒤*로 옮겨야 함.
   - **과잉 일반화 함정(역방향 overfit)**: "빈 옵션이 거슬리니 그냥 없애자"고 위젯 무관하게 조건을 넓히면 select의 빈 옵션까지 사라져 광범위 P2P가 무너진다. 반드시 `RadioSelect and not blank`로 한정.
   - **위젯 형태 함정**: 위젯이 클래스(`RadioSelect`)로도 인스턴스(`RadioSelect()`)로도 들어온다. `self.widget`은 `Field`가 인스턴스화하므로 `isinstance(self.widget, ...)`가 둘 다 커버 — 클래스 자체에 isinstance를 거는 실수를 피해야 한다(테스트가 두 형태를 모두 돈다).
