 ───────────────────────────────────────────────────────────────────────────

 Factory Mission Analysis — AI Building Journal

 Mission Stats

 ┌──────────────────────────┬──────────────────────────────────────────────┐
 │ Metric                   │ Value                                        │
 ├──────────────────────────┼──────────────────────────────────────────────┤
 │ Worker spawns            │ 12 (for 8 features)                          │
 ├──────────────────────────┼──────────────────────────────────────────────┤
 │ First-try successes      │ 4/8 (50%)                                    │
 ├──────────────────────────┼──────────────────────────────────────────────┤
 │ Features needing retries │ 3 (server-setup, chat-backend ×3,            │
 │                          │ ai-chat-sidebar → split)                     │
 ├──────────────────────────┼──────────────────────────────────────────────┤
 │ Workspace finalization   │ 3/8 (38%)                                    │
 │ blocked                  │                                              │
 ├──────────────────────────┼──────────────────────────────────────────────┤
 │ Worker timeouts          │ 2 (ai-chat-sidebar, chat-backend)            │
 ├──────────────────────────┼──────────────────────────────────────────────┤
 │ Unparseable handoffs     │ 2 (model format failures)                    │
 ├──────────────────────────┼──────────────────────────────────────────────┤
 │ Total time wasted on     │ ~2 hours                                     │
 │ retries                  │                                              │
 └──────────────────────────┴──────────────────────────────────────────────┘

 ───────────────────────────────────────────────────────────────────────────

 CRITICAL — Bottlenecking the Factory

 ### 1. mark_feature_completed gate is missing

 The orchestrator prompt explicitly instructs: "Call
 mark_feature_completed(featureId) to request the completion transition."
 But this tool does not exist in the tool list. The write_mission_artifact
 gate then rejects direct status transitions: "Feature cannot transition
 from pending to completed through direct artifact write."

 Impact: Features can never be marked complete through the canonical path.
 The orchestrator is forced to bypass with raw node -e filesystem writes,
 breaking the integrity gate entirely. This is the single biggest
 architectural defect — the completion pipeline has no working entry point.

 Fix: Implement the mark_feature_completed tool or allow
 write_mission_artifact to accept status transitions for features.

 ───────────────────────────────────────────────────────────────────────────

 ### 2. Worker workspace path mismatch (repoPath bug)

 Three features (server-setup, note-input, integration) had
 workspaceFinalization blocked because the factory's finalization step used
 a stale repoPath pointing to test-directory3 while the worker correctly
 wrote code to test-directory4.

 Evidence from decision-log:

 │ "workspaceFinalization.repoPath points to test-directory3 (wrong) —
 │ attempting to finalize against a dirty repo there. The actual code is in
 │ test-directory4."

 Impact: The orchestrator had to manually git merge branches 3 times. This
 breaks autonomy — every blocked finalization requires human-equivalent
 recovery steps.

 Fix: The factory worker spawner and finalizer must use the same canonical
 path (the directory field from requirements.json).

 ───────────────────────────────────────────────────────────────────────────

 ### 3. User testing validator produces zero shards

 Both M1 and M2 scrutiny passed with 0 blocking issues, but run_user_testing
  returned 0 shards, 0 scenarios every time. The tool exists (ping shows
 it's healthy), but it never assigns work.

 Impact: End-to-end browser validation is completely non-functional. The
 factory's second validation gate is a no-op, making scrutiny the only real
 validator.

 Fix: Debug the shard assignment logic. The validator may need .feature
 files in the workspace or a specific directory structure that isn't being
 prepared.

 ───────────────────────────────────────────────────────────────────────────

 ### 4. .feature files never reach worker workspace

 Every worker handoff reported: "Concrete assertion documents
 (features/note-input.feature) were missing from the workspace." Workers
 implemented against textual prompts instead of canonical Gherkin files.

 Impact: The validation contract (the core assertion artifact) is invisible
 to workers. Tests semantically cover the scenarios, but there's no
 traceability from .feature file → test. This defeats the purpose of BDD.

 Fix: The worker spawner should copy .missions/current/features/*.feature
 into the workspace before worker execution.

 ───────────────────────────────────────────────────────────────────────────

 IMPROVEMENT — Efficiency & Effectiveness

 ### 5. Worker timeout is too short for AI/streaming features (30 min)

 Two workers hit the 30-minute wall: ai-chat-sidebar (had to be split into 3
 features) and chat-backend (needed 3 retries). Features involving SSE
 streaming, AI SDK integration, and session management are inherently
 complex to implement with TDD.

 Evidence: The successful chat-backend worker produced 117 lines of useful
 code in its first 30-minute run before timing out. In the second run, the
 code was already there and the worker just needed to add tests — completing
 in under 30 min.

 Fix options:
 - Make timeout proportional to assertion count (e.g., 5 min per scenario)
 - Allow run_worker to accept a timeoutMinutes parameter
 - Support worker resume/continue for timed-out features when partial work
   exists

 ───────────────────────────────────────────────────────────────────────────

 ### 6. No feature complexity warning before worker spawn

 The original ai-chat-sidebar had 12 Gherkin scenarios spanning SSE
 streaming, journal context injection, conversation history, frontend UI
 with token rendering, and error states — all in a single worker. The
 orchestrator had to discover this was too large after the 30-minute
 timeout.

 Fix: The factory should warn when a feature has >8 scenarios or spans
 multiple architectural layers (backend + frontend). Suggest splitting
 before spawning.

 ───────────────────────────────────────────────────────────────────────────

 ### 7. Worker model selection is trial-and-error

 The default worker model (ollama/kimi-k2.6:cloud) timed out on complex
 features. Switching to github-copilot/claude-sonnet-4.6 produced
 unparseable handoffs (format failure). Switching to
 openrouter/qwen/qwen3-coder-plus also failed on handoff format. It took 3
 model switches across 4 attempts before chat-backend succeeded.

 Impact: The orchestrator wasted 3 worker spawns (~1.5 hours) just finding a
 compatible model.

 Fix:
 - Test worker models for handoff format compliance before using them in
   missions
 - Cache model success/failure rates per feature type
 - Or: fix the handoff parser to be more lenient with different model output
   formats

 ───────────────────────────────────────────────────────────────────────────

 ### 8. Dirty workspace blocks worker spawns with no auto-clean

 Multiple times the factory rejected worker spawns: "Cannot start worker
 from a dirty repository." The dirt was always the same two files:
 - data/journal-entries.json (runtime data modified by tests)
 - node_modules/.vite/vitest/results.json (cache file)

 Fix: Auto-clean known dirty files (gitignored runtime data, cache
 directories) before spawning workers. Or: use git stash / git checkout -- .
  automatically.

 ───────────────────────────────────────────────────────────────────────────

 ### 9. State machine doesn't track actual phase

 The state.json was stuck on phase: "intake" throughout the entire mission —
 through discovery, validation contract, feature decomposition, and
 execution. Attempts to write "execution" were rejected as invalid.

 Impact: load_mission_state always reports "intake." The orchestrator has no
 reliable way to know what phase was actually completed. Phase-gating logic
 is effectively dead.

 Fix: Fix the state machine to accept valid phase transitions. The
 state.json validator appears to have a whitelist that's out of sync with
 the actual phase names used in the prompt.

 ───────────────────────────────────────────────────────────────────────────

 NICE TO HAVE — New Capabilities

 ### 10. Worker resume/continue for timed-out features

 When chat-backend timed out after 30 minutes, it had 117 lines of working
 code (SSE endpoint, session management, streamText integration). A fresh
 worker spawn had to rediscover the codebase state. If the factory supported
 run_worker(featureId, resume=true), the next worker could pick up where the
 previous one left off.

 ───────────────────────────────────────────────────────────────────────────

 ### 11. Automatic feature splitting for oversized features

 When a feature has >8 scenarios or spans both frontend and backend, the
 factory could proactively suggest a split before spawning. The orchestrator
 had to figure this out manually after a 30-minute timeout.

 ───────────────────────────────────────────────────────────────────────────

 ### 12. Parallel worker execution for independent features

 M2 features chat-frontend and entry-management have zero code dependencies
 on each other. They could run in parallel, cutting M2 execution time in
 half. Currently, workers run serially.

 ───────────────────────────────────────────────────────────────────────────

 ### 13. Phase transition auto-logging

 The orchestrator had to manually call log_decision at every phase boundary.
 The factory could auto-log phase transitions
 (intake→discovery→validation-contract→feature-decomposition→execution)
 based on artifact presence, reducing orchestrator overhead.

 ───────────────────────────────────────────────────────────────────────────

 ### 14. Worker handoff format validation at spawn time

 Two workers produced unparseable handoffs (JSONL format failure). The
 factory should validate that a model can produce compliant handoffs before
 using it for workers, or make the handoff parser more resilient to format
 variations.

 ───────────────────────────────────────────────────────────────────────────

 Summary Priority

 ┌─────┬────────────────────────────────┬─────────────────────────┬────────┐
 │ #   │ Issue                          │ Impact                  │ Effort │
 ├─────┼────────────────────────────────┼─────────────────────────┼────────┤
 │ C1  │ mark_feature_completed missing │ Blocks completion       │ Low    │
 │     │                                │ pipeline                │        │
 ├─────┼────────────────────────────────┼─────────────────────────┼────────┤
 │ C2  │ Workspace repoPath mismatch    │ 38% of features need    │ Medium │
 │     │                                │ manual merge            │        │
 ├─────┼────────────────────────────────┼─────────────────────────┼────────┤
 │ C3  │ User testing 0 shards          │ Second validation gate  │ Medium │
 │     │                                │ is dead                 │        │
 ├─────┼────────────────────────────────┼─────────────────────────┼────────┤
 │ C4  │ .feature files missing from    │ BDD traceability broken │ Low    │
 │     │ workspace                      │                         │        │
 ├─────┼────────────────────────────────┼─────────────────────────┼────────┤
 │ I5  │ Worker timeout too short       │ Causes retries, manual  │ Low    │
 │     │                                │ splitting               │        │
 ├─────┼────────────────────────────────┼─────────────────────────┼────────┤
 │ I6  │ No feature complexity warning  │ Wastes 30-min timeout   │ Low    │
 │     │                                │ discovering it          │        │
 ├─────┼────────────────────────────────┼─────────────────────────┼────────┤
 │ I7  │ Model handoff format failures  │ Wasted 3 worker spawns  │ Medium │
 ├─────┼────────────────────────────────┼─────────────────────────┼────────┤
 │ I8  │ No auto-clean of dirty         │ Blocks spawns, manual   │ Low    │
 │     │ workspace                      │ intervention            │        │
 ├─────┼────────────────────────────────┼─────────────────────────┼────────┤
 │ I9  │ State machine stuck on intake  │ Phase tracking dead     │ Low    │
 ├─────┼────────────────────────────────┼─────────────────────────┼────────┤
 │ N10 │ Worker resume capability       │ Saves re-work on        │ High   │
 │     │                                │ timeouts                │        │
 ├─────┼────────────────────────────────┼─────────────────────────┼────────┤
 │ N11 │ Auto feature splitting         │ Proactive, no timeout   │ Medium │
 │     │                                │ needed                  │        │
 ├─────┼────────────────────────────────┼─────────────────────────┼────────┤
 │ N12 │ Parallel workers               │ 2× speedup for M2       │ High   │
 ├─────┼────────────────────────────────┼─────────────────────────┼────────┤
 │ N13 │ Auto phase logging             │ Less orchestrator       │ Low    │
 │     │                                │ overhead                │        │
 ├─────┼────────────────────────────────┼─────────────────────────┼────────┤
 │ N14 │ Model handoff validation       │ Prevents bad model      │ Medium │
 │     │                                │ selection               │        │
 └─────┴────────────────────────────────┴─────────────────────────┴────────┘
