---
instance_id: sphinx-doc__sphinx-11510
repo: sphinx-doc/sphinx
base_commit: 6cb783c0024a873722952a67ebb9f41771c8eb6d
version: "7.2"
difficulty: 1-4 hours
created_at: 2023-07-24T22:46:12Z
fail_to_pass: 2
pass_to_pass: 7
gold_files: [sphinx/directives/other.py]
primary_type: T-DomainBound
tier: T5
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

## 문제 요약

`source-read` 이벤트가 `.. include::` 디렉티브로 포함된 RST 파일에 대해서는 발생하지 않아, 커스텀 확장(예: Yocto의 검색/치환 확장)이 included 파일 본문을 변형하지 못한다. 원인은 included 파일이 "소스 파일로 한 번"은 source-read를 받지만, 디렉티브 실행 시점에 docutils가 파일을 다시 읽어 host 문서로 삽입할 때는 Sphinx의 이벤트 경로를 전혀 거치지 않기 때문이다. 이슈 본문에 명확한 재현코드가 있고, 메인테이너 토론에서 monkey-patch 형태의 해법까지 도출되어 있다.

## 유형 (정형화)

- **L = L2 (Diffuse).** 이슈는 "source-read가 include에 안 먹힌다"고만 말할 뿐, 어느 함수를 고칠지 직접 지목하지 않는다. 픽스 지점을 찾으려면 Sphinx `Include` 디렉티브 → docutils `BaseInclude` → 최종적으로 `StateMachine.insert_input`이 included RST 텍스트를 주입하는 유일한 chokepoint라는 데이터플로우를 역추적해야 한다(cross-module).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 `Include.run()` 안에 인스턴스 메서드 `state_machine.insert_input`을 nested closure(`_insert_input`)로 교체하는 **구조적 개입**이 필요하다(S6). 또한 "source-read의 의도된 계약 = 파서에 들어가는 모든 RST 텍스트는 이벤트를 한 번 받아야 한다"는 스펙을 docs/이슈 토론에서 재구성해야 올바른 docname·marker 처리를 짤 수 있다(S5).
- **K = K-Domain.** docutils statemachine의 `insert_input` 시그니처, docutils 0.18+의 끝 2줄 marker 규약, Sphinx `env.path2doc`/`os_path`/`events.emit` 내부 계약을 알아야 한다. 순수 파이썬 추론만으로는 불가.
- **primary = T-DomainBound.** 진짜 병목은 "어디·어떻게"보다 Sphinx↔docutils 경계의 내부 동작 지식이다. localize도 diffuse하지만 도메인지식이 dominant.

## 난이도 티어

**T5 (어려움).** 구조적 피처: 단일 파일·단일 함수(`Include.run`) 수정이라 scope는 좁지만(약 +34줄, 1헌크), (1) localize가 L2 diffuse — `insert_input`이 정답 chokepoint임을 알아내는 게 핵심 난점, (2) marker 2줄(`[:-2]` / `+ include_lines[-2:]`) 보존이라는 도메인 함정, (3) listener 존재 시에만 패치하는 조건(`listeners.get('source-read')`)으로 무관 동작 회귀를 막아야 하는 regression-trap, (4) "snake가 제 꼬리를 안 먹는다"는 재귀 회피(인스턴스 메서드 패치 후 클래스 메서드 호출)까지 동시에 맞춰야 함. has-repro라 재현은 쉽지만, 픽스 합성과 회귀 안전이 까다로워 공식 라벨 "1-4 hours"와 정합. T4가 아닌 이유는 marker/재귀/이벤트-계약을 한꺼번에 틀리지 않게 짜야 하는 도메인 정밀도가 높기 때문.

## 골드패치 분석

- **파일·함수:** `sphinx/directives/other.py`의 `class Include(BaseInclude, SphinxDirective).run()`. 추가 import 2개: `from docutils.statemachine import StateMachine`, `from sphinx.util.osutil import os_path`.
- **근본원인:** Sphinx `Include`는 docutils `BaseInclude`의 얇은 래퍼라, included 파일 텍스트는 `BaseInclude.run()` 내부에서 `self.state_machine.insert_input(include_lines, path)`로 파서에 주입된다. 이 경로는 Sphinx의 `source-read` 이벤트를 전혀 거치지 않으므로 확장이 included 본문을 변형할 후크가 없다.
- **수정요지:** `run()` 진입부에서 nested closure `_insert_input(include_lines, path)`를 정의해 `self.state_machine.insert_input`(인스턴스 메서드)에 바인딩한다. closure는 (1) `"\n".join(include_lines[:-2])`로 끝 2줄 marker를 제외하고 텍스트 복원, (2) `docname = self.env.path2doc(os_path(path))`, (3) `self.env.app.events.emit("source-read", docname, arg)`로 이벤트 발생, (4) `arg[0]`(변형된 텍스트)을 `splitlines()` 후 marker 2줄 재부착, (5) `StateMachine.insert_input(self.state_machine, ...)` **클래스 메서드**를 직접 호출해 무한재귀를 피한다. 그리고 `if self.env.app.events.listeners.get('source-read'):`일 때만 패치를 설치한다.

## 검증 (test_patch)

FAIL_TO_PASS 2개:
- `test_include_source_read_event` — 핸들러가 source[0]를 기록만 함. include된 `baz/baz.rst`가 `baz/baz` docname으로 source-read를 받는지(`sources_reported["baz/baz"] == "\nBaz was here."`, `:start-line: 4` 반영), `:literal:`로 포함된 `text.txt`는 RST 파싱이 없어 이벤트가 **안** 오는지를 함께 단언 → docname 정확성과 marker 슬라이싱을 동시에 검증.
- `test_include_source_read_event_nested_includes` — `baz/baz.rst`가 다시 `foo.rst`를 include하는 중첩 케이스에서 핸들러가 `#magical`→`amazing` 치환을 하고, 최종 doctree의 `paragraph.rawsource == "The amazing foo."`인지 확인 → 변형이 실제 파싱 결과까지 전파되고 중첩 include에도 작동함을 증명.
- **overfit/regression:** FAIL_TO_PASS가 얇긴 하나 "literal은 제외 / 중첩은 전파 / docname·marker 정확"까지 묶어 special-case 통과를 어렵게 만든다. PASS_TO_PASS 7개는 전부 toctree 동작(`test_toctree*`, `test_relative_toctree`, `test_reversed_toctree`) — listener 없으면 패치를 아예 안 거는 가드(`listeners.get`) 덕에 기존 toctree/일반 include 경로가 byte-identical로 유지됨이 regression 안전의 핵심.

## 모범답안 (오라클 기반)

1. **localize:** "source-read가 안 불린다" + hints의 "Include는 docutils 래퍼"라는 신호에서 출발 → `sphinx/directives/other.py`의 `Include`로 진입 → docutils `BaseInclude.run`을 읽어 included 텍스트가 오직 `StateMachine.insert_input`을 거친다는 유일 chokepoint를 확인. (이슈 토론의 monkey-patch가 정답 지점을 사실상 알려줌.)
2. **픽스/일반화 근거:** 전역 클래스 monkey-patch(토론의 워크어라운드) 대신 **인스턴스 메서드만** 패치하고 호출은 클래스 메서드로 위임 → 전역 오염·재귀 없이 이 디렉티브 실행에만 국한. `path2doc(os_path(path))`로 OS 경로를 정규 docname으로 변환해 핸들러가 받는 docname 계약을 일반 source-read와 일치시킴 → 특정 테스트가 아니라 "모든 included RST가 동일 이벤트 계약을 받는다"는 올바른 일반화.
3. **regression 안전:** `listeners.get('source-read')`가 비면 패치 설치를 건너뛰어 source-read 미사용 빌드(대다수)·toctree·literal include 경로는 기존과 동일. 끝 2줄 marker를 이벤트에서 빼고 다시 붙여 docutils 0.18+ statemachine 내부 규약을 깨지 않음 → PASS_TO_PASS toctree 7개 보존.
4. **함정 회피:** 오라클 없는 에이전트가 틀릴 지점 — (a) `include_lines` 전체를 join해서 marker 2줄까지 이벤트에 노출/유실(`[:-2]` 누락 시 파싱 깨짐), (b) 인스턴스가 아닌 클래스 메서드를 패치해 `insert_input` 무한재귀, (c) `path`를 그대로 docname으로 써 핸들러가 받는 식별자가 틀림, (d) listener 가드 없이 항상 패치해 무관 빌드 회귀. 정답은 인스턴스-바인딩 + 클래스 위임 + marker 보존 + docname 변환 + listener 게이트를 모두 만족시키는 것.
