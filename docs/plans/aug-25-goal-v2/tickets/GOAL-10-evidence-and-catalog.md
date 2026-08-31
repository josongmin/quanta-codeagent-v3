# GOAL-10 — evidence + catalog: 실제 PTY/web E2E, fc 게이트, promotion 판정

> **ARCHIVED TICKET** — 당시 실행 입력이다. 현재 판정은 **PARTIAL**이며 최신 evidence gap은
> [`../NEXT-PLAN.md`](../NEXT-PLAN.md)의 R5/R6을 따른다.

> **구현 대조 (2026-08-30, 2026-08-31 정정)** — 카탈로그·승격·바이너리 parity는 구현됐다.
> - **텔레메트리 부분 구현**: turn-scoped settlement decision counter와 bounded `{kind,outcome}`
>   labels는 live다. wake/enqueue/completion/verifier lifecycle counters와 producer별 guard는 남는다.
> - **`tests/smoke/goal/` 없음**(`tests/smoke/`엔 swebench와 LSP 관측 스위트뿐).
> - 현재 PTY 파일은 11개 case다. 정확한 누락 public matrix는 `NEXT-PLAN.md` R6에서 관리한다.
> - receipt는 `receipts/GOAL-10.yaml`이 아니라 플랜 루트의 `GOAL-10-RECEIPT.md`다.

**Priority:** P1 · **Depends on:** GOAL-01~09 전부 · **크기:** ~30 tool-use, main-direct

## 목적
"Codex /goal 동급 + Quanta 안전 확장"을 **구현이 아니라 실행 증거**로 주장한다. 각 티켓 E2E를 하나의 배터리로 묶고, feature catalog가 실제 front-door 증거만큼만 말하게 한다.
최종 promotion 결정은 default ON이며 `QUANTA_GOAL=0`을 명시적 opt-out으로 유지한다. 사용자가 goal을 생성하기 전에는 autonomous turn이 없다.

## 작업명세
### E2E 배터리 (기존 파일 확장, 새 fake 하네스 금지)
**중복 방지**: 아래 목록은 GOAL-03/05/06/07/08/09가 각자 추가한 테스트의 **인덱스**다. 이 티켓은 (i) 누락된 항목만 추가, (ii) 각 항목의 mutant receipt, (iii) 배터리 1회 완주 receipt를 담당한다. 이미 있는 테스트를 다시 쓰지 않는다.
- `tests/e2e-pty/cli-goal-pursuit-e2e.test.ts` — 필수 시나리오, 각 핵심에 red-on-injection 페어(주석으로 mutant 지정):
  1. default ON: `QUANTA_GOAL` 미설정 → `/goal` 등록, goal 생성 전 wake 0. `QUANTA_GOAL=0` → `/goal` 미등록.
  2. set → `/goal` 렌더(validation contract missing 표시).
  3. `check add` → `verify` → `1/1 verified` → 파일 touch → stale.
  4. autonomous multi-turn: cassette 2 turn, verifier pass → completed, 이후 wake 0.
  5. `pause` → wake 0 → `resume` → wake 1.
  6. `edit` → objectiveId 변경, 이전 progress 0.
  7. `clear` → no goal, 재기동 후 no goal.
  8. budget `--max-turns=2` → 2회 후 budget_limited, wake 0.
  9. no-progress 3회 → 간격 증가(wake armed 로그 diff).
  10. 부분 draft / Ctrl+B bg turn / plan mode 라이브 중 wake 0(기존 + 추가); UI idle suppression 독립(기존).
  11. stale queue drop(기존).
  12. blocker 2회 active, 3회 blocked.
  13. zero-criteria 모델 completed 시도 → 거부.
  14. attach thread B → `/goal` B, A continuation 0.
  삭제/반전 시 반드시 RED여야 하는 코드: dequeue revision check · active-turn finally · authorizeMutation manual 분기 · settle-before-persist 순서 · progress attemptId dedup · blocker distinct-attempt · cooldown revision reset · fire-time quiescence 검사 · attach wake cancel 순서. 각 mutant를 `tools/dev/`의 기존 mutation 스크립트(있으면) 또는 수동 1회 적용→RED 확인→revert로 receipt 남김.
- `tests/integration/goal-web-submit-daemon-e2e.test.ts`, `goal-attach-daemon-e2e.test.ts`(GOAL-07/08) — 배터리에 포함.
- `tests/integration/objective-verifier-real-command-e2e.test.ts`(GOAL-03).
- 컴파일 바이너리 parity: `bun run build` 후 `QUANTA_E2E_CLI_BIN=$PWD/dist/agent`로 동일 PTY 배터리 재실행. 전역 CLI는 덮어쓰지 않는다.

### catalog
- `tools/feature-catalog/features/09-integration/objective-goal-continuation-live.yaml` — 실제 증거 기준으로 재작성: `Modes`는 PTY 통과 = `interactive`, web E2E 통과 = `+ide`(web-daemon), headless는 증거 없으면 제외.
  knob: `QUANTA_GOAL`(공개), 내부 6개는 advanced. "Codex parity" 항목과 "Quanta safety extension"(CAS/hysteresis/verifier receipt/budget/hard cap) 분리 표기.
  evidence.code/tests에 위 배터리 경로.
- 신규 yaml `objective-verifier-runtime.yaml`(GOAL-03) — checked criteria 실행 계약(argv/cwd/env/digest/stale).
- `bun fc validate && bun fc build && bun fc diff && bun fc check-evidence` GREEN, `docs/10.feature-catalog.md` 재생성 diff가 goal 행만.

### telemetry (bounded, 각 티켓에서 이미 추가된 decision-counter 확인)
- armed/canceled/skipped(reason) · enqueue admitted/rejected · stale dequeue · attempt started/settled(outcome) · cooldown/no-progress(n) · completion satisfied/rejected(reason) · verifier batch applied/stale-source.
- label에 goal text/thread id/attempt key **금지** — `tests/unit/observability`에 label allowlist 테스트.

### promotion 판정
- 기준 고정(품질 임계치는 baseline 없이 정하지 않음 — 별도): safety hard gate만: overlap 0 · duplicate 0 · stale execution 0 · verifier 없는 checked completion 0 · unavailable→completion leak 0 · fabricated evidence ref 0.
- live 측정은 `tests/smoke/goal/`(신규, `bun run smoke` 배터리 규약)로, AWS bench preflight에는 넣지 않음.

## RED
- 배터리 각 항목이 해당 티켓 이전 커밋에서 RED였다는 receipt(커밋 SHA + 실패 라인)를 이 티켓 PR 본문에 표로.
- catalog `Modes`/`Level`이 증거보다 높으면 `fc check-evidence` RED가 되도록 evidence 경로를 실제 테스트 파일로 고정.

## Proof rails (최종 rail — 순서대로, 동시 `bun test` 금지)
```sh
bun run typecheck && bun run typecheck:tests
bun run lint && bun run lint:debt
bun test tests/unit/god-code-ratchet.test.ts tests/unit/_arch
bun test tests/unit
bun test tests/integration
bun test tests/e2e-pty/cli-goal-pursuit-e2e.test.ts
bun fc validate && bun fc build && bun fc diff && bun fc check-evidence
git diff --cached --check
```
각 명령의 요약 줄 + 최종 `git rev-parse HEAD`를 receipt로 남긴다. 하나라도 미실행이면 "완료" 보고 금지.

## Exit
- 보고 문구: "CLI+web 행위 GREEN(배터리 N/N), default ON, 명시적 `QUANTA_GOAL=0` opt-out GREEN". 실제 자동 실행은 사용자가 `/goal`로 goal을 만든 뒤에만 가능하다.

## 실행 결과 (2026-08-26)
- 구현 및 검증 receipt: [`../GOAL-10-RECEIPT.md`](../GOAL-10-RECEIPT.md)
- 판정: 사용자의 명시적 promotion 결정에 따라 `QUANTA_GOAL` default ON. 내부 gate 명시값은 그대로 우선한다.
- 미완료 경계: production live 효용/비용 측정은 운영 관측 과제이며 안전 rail 완료와 분리한다.
