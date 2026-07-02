# RFC 06 — Terminal-Bench 을 leaderboard 대시보드에 통합 (SSOT/IR-emit)

## 정정 (v2)
초안은 "suite 추상화"로 갔는데 **오버엔지니어링**. 실측 확인 결과 대시보드는 이미 **단일 report.json IR/SSOT** 위에서 live/pro/verified 를 돌린다:
- 프로듀서 `src/apps/bench/dataset-family.ts`: `DatasetFamily = "verified" | "live" | "pro"` — 한 파이프라인, family 로만 분기.
- 대시보드 `server.ts:224`: per-report `datasetFamily: **string**` (free string, closed union 아님) → `perInstance:[{passed, instanceId,...}]`, `resolved`, `termination`, `knobs.resolved` 로 집계.

즉 live/pro/verified 는 **같은 report IR** 이고 `datasetFamily` 값만 다르다. **TB 도 이 IR 을 emit 하면 대시보드는 무변경**으로 4번째 family 로 뜬다. 별도 suite/어댑터-렌더 불필요.

## 설계 — TB → 공통 report IR emit
harbor 출력을 SWE report.json 과 **동일 스키마**로 정규화해서 REPORT_ROOTS 에 떨군다.

```
harbor: <root>/<ts>/<task>__<hash>/verifier/reward.txt (0|1) + result.json (started/finished, trials)
   ↓ tb-report-emit
report.json (SSOT IR):
{
  datasetFamily: "terminal-bench",
  model, runId, knobs:{resolved:{...레버(env-owned/max-turns/verify-gate)}},
  resolved: <pass 수>,
  perInstance: [{ instanceId:<task>, passed:<reward===1>,
                  termination, durationMs:<finished-started>, patchBytes:n/a }],
}
```

## 구현 단위
### C1. `tb-report-emit` — harbor 트리 → SSOT report.json (핵심, 이거면 끝)
`tools/leaderboard-dashboard/tb-report-emit.ts` (또는 bench 하네스 리프). **순수 함수**: harbor 디렉토리 in → report IR out. `perInstance[].passed = reward===1`, `resolved = pass 수`, `datasetFamily="terminal-bench"`. 기존 대시보드 report-scan/캐시가 그대로 픽업.

### C2. `DatasetFamily` 유니온에 `"terminal-bench"` 추가 (SSOT 정합)
`dataset-family.ts` 타입 확장(one-line). 대시보드는 free string 이라 안 해도 뜨지만, **프로듀서 SSOT 정합**을 위해 추가(향후 TB 를 quanta bench 하네스로 직접 돌릴 때 대비). label 만 필요.

### C3. 결과 sync (P1) — 박스 → 로컬 REPORT_ROOTS
`sync-tb.sh`: rsync `ubuntu@box:~/tb-results/` → 로컬, 그 위에서 C1 emit. BENCH_SSH_SAFE_OPTS SSOT 재사용 [[jun-25-full-remote-readiness-swallow]]. `--watch` 폴링이면 라이브.

### C4. TB 경쟁사 매트릭스 (P1) — family-aware
현 매트릭스는 `scaffold-solving-summary.md`(SWE topScaffolds 파싱)로 SWE 전용. `terminal-bench-pertask.md`(이미 동형 표)를 `--matrix-tb` 로 붙이고, 매트릭스 로더를 **family 키로 분기**(SSOT: family→matrix). "우리 실패 ∩ 남들 성공" 승산-타겟 뷰는 family param 재사용.

## 우선순위 / ROI
- **P0 = C1 (+C2 one-line)**: harbor 결과를 SSOT IR 로 emit → 대시보드에 TB family **즉시 표출**, 코드변경 최소. 이번 failset-levers 런 결과가 바로 채워짐.
- **P1 = C3 sync + C4 family-aware matrix**: 라이브 + 경쟁사 대비.

## 검증
- C1: failset-levers 트리 fixture 로 `report.perInstance.filter(passed).length == grep -c '^1'` 파리티.
- 회귀: Verified/live/pro report 렌더 byte-parity(C2 유니온 확장이 기존 분기 안 깨뜨림 — resolveDatasetFamily 테스트 green 유지).
- 대시보드: emit 한 TB report.json 를 REPORT_ROOTS 에 두고 `/` 에서 terminal-bench family 그룹이 resolved/total 로 뜨는지.

## 관련
[[jul-01-terminal-bench-full89-landscape]] [[jul-03-bench-box-auth-codex-fallback]] · 레버 RFC 00~05 동일 디렉토리
