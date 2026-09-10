export const EVAL_HELP = `quanta eval — verification harness (Tier 0..5)

  audit                                      Tier 0 static coverage
  synthetic [--usecase ID]                   Tier 1 LLM-judged scenarios
  grounding run [--mode raw|engine|assisted] [--suite canary|nightly|--corpus CORPUS]
                                             Tier 2 structured context-grounding probe
  grounding preflight                        Tier 2 provider/route/parser health check
  grounding report --run-id ID               Tier 2 grounding metrics report
  grounding baseline --candidate ID          Tier 2 resolve latest comparable baseline
  grounding gate --run-id ID --profile canary
                                             Tier 2 grounding release gate
  grounding gate --route-matrix primary-openai --run-ids ID,ID --profile canary
                                             Tier 2 route-matrix release gate
  grounding compare --baseline ID --candidate ID
                                             Tier 2 run-to-run grounding delta
  grounding regress --baseline ID --candidate ID --profile strict
                                             Tier 2 fail-closed regression gate
  grounding scaffold-replay --source JSONL --out PATH
                                             Tier 2 replay draft scaffold (gold-blind)
  grounding promote-replay --draft PATH --gold-json PATH --corpus replay_critical|replay_nightly --out PATH
                                             Tier 2 replay draft promotion to runnable fixture
                                             add --store-dir DIR to isolate run storage
  generate --usecase ID [--count N]          Tier 1 auto-generate scenarios (LLM)
  public swebench-verified [--report PATH]   Tier 3 wraps bench-report.json
  trajectory classify --input DIR            Tier 4 label real sessions
  trajectory replay --fixture <jsonl>        Tier 4 re-execute a fixture + diff
  trajectory freeze --source <jsonl> --usecase ID [--prompt TEXT]
                                             Tier 4 promote a session to fixture
  trajectory redact --source <jsonl> --out <jsonl>
                                             owner-only redacted sharing export + provenance receipt
  compare --scenario ID --usecase ID [--agents quanta,claude-code,...]
                                             Tier 5 head-to-head + pairwise judge
  report                                     render aggregate matrix
  classify "<text>"                          ad-hoc taxonomy classifier
`
