# v5-absorb 첫 측정 결과 (2026-06-25 02:42, fresh full-remote, n=1/instance)

run: `report-i-0aabbd70cc1ada963.json` (box i-0aabbd70cc1ada963, chatgpt.json, --allow-extra-boxes).
preset `agentless-v5-absorb` = proof-clean − proof-required + DYNAMIC_MESSAGE_MATCHER(spec-fidelity-invariant) + FORWARD_LOCALIZE (+CHA/F821 default-on).

## A/B vs baseline (2026-06-23 proof-clean = 0/3, 전부 empty_patch)

| instance | baseline(06-23) | v5-absorb(06-25) | Δ |
|---|---|---|---|
| django-14315 | empty / postgresql 1-site만 | **patchBytes=986, touched=base/client.py+postgresql/client.py(=gold 2파일)**, f2pFail=9, **regression=0** | **dual-site localization 닫힘**, edit 틀림 |
| django-11138 | **empty patch**(0B) | **patchBytes=7269, 5파일(base/mysql/oracle/sqlite3 ops)**, f2pFail=1, **p2pFail=6(multi_file_drift)** | **empty 제거**, edit 틀림+regression |
| astropy-13033 | empty(extension_helpers env) | patchBytes=0, verify-select 모든 후보 hard-reject (env ModuleNotFound 로그 **없음**=env 통과한 듯) | 여전히 empty, 원인 이동 |

resolved: **0/3 (변화 없음)**. 그러나 실패모드가 근본 이동.

## 결론 (정직)
- **흡수가 타겟(localization recall)에 작동했다 — touchedFiles로 증명.** 14315가 producer+consumer 둘 다(우리가 늘 놓치던 dual-site), 11138이 empty→5파일. forward-localize/owners/CHA가 실제 engage.
- **resolved=0인 이유 = localization은 necessary-not-sufficient.** 다음 병목이 노출됨: **맞는 파일, 틀린 edit**(synthesis-74% 클래스). 14315 9/9 f2p fail, 11138 1 f2p + 6 p2p regression.
- **tradeoff 발견**: proof-required 제거가 empty_patch는 고쳤지만 11138이 **regressing 패치(6 p2p break)를 제출**(multi_file_drift). mini-swe "submit anyway"의 대가.

## 다음 레버 (측정 기반, 우선순위)
1. **11138 regression 게이트**: proof-required 빼서 regressing 패치 ship됨 → submit-non-empty는 유지하되 verify-select-regression을 rank-only→soft-gate(6-p2p-break 후보가 cleaner 후보에 지게). empty↔regressing 사이 middle.
2. ~~13033 spec-fidelity veto 과민 가설~~ → **틀림(정정 2026-06-25)**. trajectory 까보니 진짜 원인 2개: **(a) python3 shim 누락** — 에이전트가 repro를 `python`/`python3` 번갈아 실행, `python`(shim)=IMPORT-OK 매번 / **`python3`(미shim)=ModuleNotFound 매번**(20회중 9회) → astropy import 못해 core.py 18편집 검증 불가 → 후보 non-submittable. **(b) 429 usage_limit_reached**(chatgpt.json pro plan 런중 quota소진, 13033이 굶음). **FIX LANDED**: `project-env-python-shim.ts` PYTHON_SHIM_NAMES=["python","python3"] 둘다 shim(teeth: project-env-python-shim.test.ts python3 케이스). selector-mode=clean은 declaredExpected hard-veto 안 함(selection-gates.ts:265 확인)이라 spec-fidelity는 무죄.
3. **edit 정확도(synthesis-74%) = 진짜 남은 병목**: localization 닫혔으니 이제 batch-2의 **cross-vendor diversity(c축)**가 경험적으로 motivated — 같은 gpt-5.4 N샘플은 같은 틀린 edit, 이종 vendor면 decorrelated. 단 현재 ABSENT(미구현). 이게 다음 진짜 absorption.

## 메타
- 알트 auth(acct-b, bench-rerun-jun24) refresh 토큰 401 사망 → chatgpt.json만 유효. 멀티풀 쓰려면 재로그인.
- single-box-guard가 dead-owner stale 락(66209) 잡고 있어 --allow-extra-boxes로 우회(경합 없음 확인 후).
- n=1이라 SWE 판정 노이즈 큼; resolved Δ는 다회 필요. 단 touchedFiles(localization)는 결정론적이라 n=1로도 신뢰.
