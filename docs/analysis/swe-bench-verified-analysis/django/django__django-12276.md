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
---

# django__django-12276

## 문제 요약
`FileInput` 위젯이 이미 초기 데이터(initial)가 있는 경우에도 HTML `<input type="file">`에 `required` 속성을 출력한다. 모델 인스턴스를 편집할 때처럼 파일이 이미 저장돼 있으면, 사용자가 입력을 비워둬도 기존 값을 유지하면 되므로 `required`가 붙으면 안 된다. 같은 로직이 이미 `ClearableFileInput`에는 구현돼 있으니 이를 부모 클래스인 `FileInput`으로 끌어올려 양쪽 위젯에서 일관되게 동작하길 기대한다.

## 유형 분류
- 버그 카테고리: API-contract / 누락처리 (메서드가 잘못된 클래스 계층 위치에 정의됨)
- 서브시스템: django forms / widgets (FileInput / ClearableFileInput)
- 증상 타입: 잘못된 출력 (HTML 렌더링에 불필요한 `required` 속성)
- 로컬라이제이션 신호: problem_statement이 `django/forms/widgets.py`의 `ClearableFileInput.use_required_attribute()` 정확한 라인(L454)을 직접 가리키고, "moved to FileInput.use_required_attribute()"라고 수정 위치까지 명시. hints_text에도 재현 테스트 코드가 포함됨.

## 골드패치 분석
- 건드린 파일/함수: `django/forms/widgets.py` — `FileInput.use_required_attribute()` (신규 추가), `ClearableFileInput.use_required_attribute()` (제거)
- 근본 원인: `use_required_attribute(self, initial)` 오버라이드(initial이 있으면 `required`를 끔)가 `ClearableFileInput`에만 정의돼 있었다. 그래서 `widget=FileInput`을 직접 쓰는 FileField는 부모 `Widget.use_required_attribute()`의 기본 동작만 받아 initial 유무와 무관하게 `required`가 출력됐다.
- 수정 요지: 동일한 메서드 `return super().use_required_attribute(initial) and not initial`을 `FileInput`에 추가하고, 중복이 된 `ClearableFileInput`의 정의를 삭제했다. `ClearableFileInput`은 `FileInput`을 상속하므로 동작은 그대로 보존되며, 로직이 양쪽에서 공유된다. 순수 하향 이동(move-up) 리팩터로, 로직 자체는 변하지 않는다.

## 검증 (test_patch)
- FAIL_TO_PASS가 체크하는 동작:
  - `test_use_required_attribute` (widget_tests/test_fileinput.py): `widget.use_required_attribute(None) is True`, `widget.use_required_attribute('resume.txt') is False` — FileInput 위젯 단위 동작.
  - `test_filefield_with_fileinput_required` (tests/test_forms.py): `FileField(widget=FileInput)` 폼을 렌더해서 initial 없으면 `<input type="file" ... required>`, initial이 있으면 `required` 없는 출력을 `assertHTMLEqual`로 검증.
- 테스트가 어떻게 픽스를 증명하는지: initial이 `None`/없을 때는 `required`가 유지(super 동작), initial 값이 있으면 `and not initial`로 `required`가 꺼짐. 픽스 전에는 FileInput에 오버라이드가 없어 initial 있어도 `required`가 붙어 두 테스트 모두 실패. 픽스 후 위젯 단위·폼 렌더 양쪽이 통과.

## 공략 포인트 (뭘 조져야)
- localization 전략: problem_statement에 파일·메서드·라인이 못박혀 있으므로 `django/forms/widgets.py`에서 `class FileInput`과 `class ClearableFileInput`, `use_required_attribute` 정의 위치만 확인하면 즉시 끝난다.
- 함정/난이도 메모: 핵심은 클래스 상속 관계 파악(`ClearableFileInput(FileInput)`). 단순히 FileInput에 추가만 하고 ClearableFileInput의 중복 정의를 안 지워도 동작은 동일하지만, 골드는 중복 제거까지 한다(DRY). 멀티파일 아님 — 단일 파일, 3줄 추가/3줄 삭제.
- 우리 에이전트 관점: 막힐 지점은 거의 없는 <15분급 문제. 유일한 리스크는 (1) ClearableFileInput에서 메서드를 안 지워 골드와 diff가 어긋나는 것(테스트는 통과하나 패치 정확도 감점), (2) `and not initial` 대신 `if initial: return False` 식으로 재작성해 의미는 같지만 super 단락 동작을 놓치는 경우. super 호출을 보존하는 게 안전하다.
