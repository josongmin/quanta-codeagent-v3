---
instance_id: django__django-12276
repo: django/django
base_commit: 53d8646f799de7f92ab9defe9dc56c6125448102
version: "3.1"
difficulty: <15 min fix
created_at: 2020-01-05T08:04:40Z
fail_to_pass: 2
pass_to_pass: 117
gold_files: [django/forms/widgets.py]
primary_type: T-DirectMap
tier: T2
loc_axis: L0
repair_strategy: S1 (+S6)
knowledge: K-Domain
flags: [has-repro, regression-trap]
---

# django__django-12276

## 문제 요약
`FileInput` 위젯이 초기 데이터(initial)가 있어도 HTML `<input type="file">`에 `required` 속성을 출력한다. 모델 인스턴스를 편집할 때처럼 파일이 이미 저장돼 있으면 사용자가 입력을 비워둬도 기존 값을 유지하면 되므로 `required`가 붙으면 안 된다. 동일한 로직이 이미 `ClearableFileInput.use_required_attribute()`에 구현돼 있으니, 이를 부모 클래스 `FileInput`으로 끌어올려 두 위젯에서 일관되게 동작하길 기대한다. problem_statement이 파일·메서드·라인(L454)과 "moved to FileInput"이라는 수정 방향까지 명시한다.

## 유형 (정형화)
- **L0 (Pinpointed)**: problem_statement이 `django/forms/widgets.py`의 `ClearableFileInput.use_required_attribute()`를 깃허브 퍼머링크(L454)로 직접 지목하고, 옮길 목적지(`FileInput.use_required_attribute()`)까지 못박았다. grep 한 방, 탐색 자체가 거의 없다.
- **S1 (Direct-Map) +S6 (Design-Refactor) 보조**: 이슈가 사실상 픽스를 명세한다("ClearableFileInput의 메서드를 FileInput으로 옮겨라"). 새 식을 추론할 필요 없이 기존 한 줄을 상속 계층 위로 끌어올리는 기계적 변경이라 dominant는 S1. 다만 그 변경의 본질이 *동작 추가*가 아니라 *메서드를 클래스 계층의 올바른 위치로 재배치(pull-up method)*하는 구조 변경(중복 정의 제거 포함)이라 S6를 보조로 단다. SemFix식 조건 합성(S2)이 아니라 위치 이동이 핵심이다.
- **K-Domain (Domain-bound)**: `Widget → FileInput → ClearableFileInput` 상속 체인, `use_required_attribute(initial)` 위젯 계약, `required` 속성이 폼 렌더링에서 켜지는 메커니즘 등 django.forms 위젯 내부 지식이 있어야 "ClearableFileInput에만 있다 = FileInput을 직접 쓰면 누락"이라는 진단이 선다. 순수 일반 파이썬 추론(K-Gen)으로는 왜 한쪽에만 있는지를 못 읽는다.
- **primary type = T-DirectMap**: L0 + S1 기계적 픽스. 위치가 못박혀 있고 변경이 자명하다. T-LocTrivial이 아닌 이유는 픽스가 "체크 한 줄 추가"의 완전 자명 케이스라기보다 상속 위치를 이해해야 하는 pull-up이라 K-Domain·S6 색채가 있기 때문. T-DesignRefactor로 올리지 않는 이유는 조율된 멀티사이트 구조변경이 아니라 단일파일 3줄 이동의 사소한 리팩터라서다.

## 난이도 티어
**T2 (쉬움)**. 구조적 피처: 단일 파일(`django/forms/widgets.py`), 골드 패치 순변경 3줄(추가 3 / 삭제 3, 실질 1메서드 이동), L0 직접 localize, has-repro(hints_text에 통과/실패하는 SimpleTestCase 재현 코드 동봉 — 가장 강한 easiness 신호). 가벼운 도메인 지식(위젯 상속) 외엔 추론 부담이 거의 없다.

공식 라벨(`<15 min fix`)과 일치하며 굳이 T1로 내리지 않는 이유는 두 가지다. (1) K-Gen이 아니라 K-Domain이다 — 상속 체인을 모르면 "왜 ClearableFileInput에만 있나"를 못 읽어 자명함이 깨진다. (2) regression-trap이 약하지만 존재한다 — P2P 117개 중 `test_use_required_attribute_true/false`, `test_empty_permitted_and_use_required_attribute`, `test_forms_with_file_fields` 등 `required`/파일필드 렌더 동작이 다수라, super 단락 동작을 잘못 재작성하면 인접 케이스를 깬다. T1의 "이슈가 픽스를 거의 적어줌 + K-Gen + 함정無" 프로파일에서 K-Domain과 얇은 트랩 때문에 한 칸 올라 T2.

## 골드패치 분석
- **건드린 파일·함수**: `django/forms/widgets.py`
  - `FileInput.use_required_attribute()` — 신규 추가
  - `ClearableFileInput.use_required_attribute()` — 기존 정의 삭제
- **근본 원인**: `use_required_attribute(self, initial)` 오버라이드(`return super().use_required_attribute(initial) and not initial`, 즉 initial이 있으면 `required`를 끔)가 `ClearableFileInput`에만 정의돼 있었다. `ClearableFileInput`이 `FileInput`을 상속하므로 ClearableFileInput으로 렌더할 땐 정상이지만, `forms.FileField(widget=FileInput)`처럼 부모 위젯을 직접 쓰면 기본 `Widget.use_required_attribute()`만 받아 initial 유무와 무관하게 `required`가 항상 출력됐다. 즉 동작이 잘못된 게 아니라 **올바른 동작이 계층 하위에만 있어 상위 위젯에서 누락**된 구조 결함.
- **수정 요지**: 동일한 메서드 본문을 `FileInput`에 올려 추가하고, 중복이 된 `ClearableFileInput`의 정의를 삭제. `ClearableFileInput`이 `FileInput`을 상속하므로 ClearableFileInput의 동작은 그대로 보존되고(이제 부모에서 상속), `FileInput` 직접 사용 시에도 같은 로직이 적용된다. 로직 자체는 변하지 않는 순수 pull-up 리팩터다.

## 검증 (test_patch)
- **FAIL_TO_PASS 동작** (2개):
  - `test_use_required_attribute` (forms_tests.widget_tests.test_fileinput.FileInputTest): 위젯 단위 — `widget.use_required_attribute(None) is True`, `widget.use_required_attribute('resume.txt') is False`.
  - `test_filefield_with_fileinput_required` (forms_tests.tests.test_forms.FormsTestCase): 폼 렌더 — `FileField(widget=FileInput)`을 `as_table()`로 렌더해 initial 없으면 `<input type="file" name="file1" required>`, `initial={'file1': 'resume.txt'}`이면 `required` 없는 출력을 `assertHTMLEqual`로 검증.
- **픽스 증명**: 픽스 전엔 `FileInput`에 오버라이드가 없어 initial이 있어도 `required`가 출력 → 두 테스트 모두 실패. 픽스 후엔 `and not initial`로 initial 있을 때 False, 없을 때는 `super()`의 True가 유지돼 위젯 단위·폼 렌더 양쪽이 통과.
- **overfit 관점**: FAIL_TO_PASS가 위젯 단위 + 폼 통합 2층으로 잡혀 special-case 통과가 어렵다. initial=None(required 유지)과 initial 존재(required 제거) 두 분기를 모두 검사하므로 "무조건 required 끄기" 같은 과적합 픽스는 `test_use_required_attribute`의 `None → True` 분기에서 잡힌다. overfit-risk 낮음.
- **regression 관점**: regression-trap을 단 이유 — P2P 117개에 `test_use_required_attribute_true`, `test_use_required_attribute_false`, `test_empty_permitted_and_use_required_attribute`, `test_forms_with_file_fields`, `test_multipart_encoded_form` 등 `required` 출력·파일필드 렌더 동작이 다수다. `super()`를 호출하지 않거나 `and not initial` 조건을 잘못 쓰면 ClearableFileInput·일반 required 동작을 깰 수 있다. 골드처럼 `super()` 결과를 보존(`super().use_required_attribute(initial) and not initial`)해야 이들이 안전.

## 모범답안 (오라클 기반)
1. **localize 경로**: problem_statement이 `django/forms/widgets.py`의 `ClearableFileInput.use_required_attribute()` 라인과 "moved to FileInput"을 직접 명시 → `django/forms/widgets.py`에서 `class FileInput`, `class ClearableFileInput`, `use_required_attribute` 정의 위치만 확인. 상속 관계(`class ClearableFileInput(FileInput)`)를 grep으로 못박는 게 유일한 추가 확인.
2. **픽스 (왜 올바른 일반화인가)**: `FileInput`에 `def use_required_attribute(self, initial): return super().use_required_attribute(initial) and not initial`를 추가하고 `ClearableFileInput`의 동일 정의를 제거. `if initial: return False` 식 재작성이 아니라 `super()`를 곱하는 형태를 유지하는 게 일반화의 핵심이다 — super가 결정하는 다른 비활성 조건(예: `is_hidden`, `empty_permitted` 경로)을 보존하면서 "initial이 있으면만 추가로 끈다"는 의미를 정확히 합성하기 때문. ClearableFileInput은 FileInput을 상속하므로 동작 보존 + 부모 위젯 커버라는 두 목표를 동시에 만족하는 최소 일반화다.
3. **regression 안전**: `super().use_required_attribute(...)`를 곱셈으로 보존했기에 `test_use_required_attribute_true/false`, `test_empty_permitted_and_use_required_attribute`, ClearableFileInput을 쓰는 `test_forms_with_file_fields` 등 P2P 117개가 안 깨진다. initial=None일 때 super의 True를 그대로 흘려보내 "initial 없으면 required 유지"라는 기존 계약을 깨지 않는 것이 안전의 핵심.
4. **함정 회피**: 오라클 없는 에이전트가 틀릴 두 지점 — (1) `FileInput`에 추가만 하고 `ClearableFileInput`의 중복 정의를 안 지우면 테스트는 통과하나 골드와 diff가 어긋나고 죽은 중복이 남는다(골드는 DRY로 제거). (2) `if initial: return False`처럼 의미는 같아 보이게 재작성해 `super()` 단락 동작을 버리면, initial이 없을 때 super가 False를 줄 다른 경로(hidden 등)를 무시해 인접 P2P를 깰 수 있다. 회피법: 이슈가 "move"라고 명시했으니 *기존 메서드 본문을 글자 그대로 부모로 옮기고 자식에서 삭제* — 새 로직을 발명하지 말 것.
