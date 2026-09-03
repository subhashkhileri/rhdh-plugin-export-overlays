# Shared curated-check filter for ci-diagnose — the SINGLE SOURCE OF TRUTH for
# which of a PR's checks ci-diagnose looks at.
#
# Input : a PR rollup from `gh pr view --json statusCheckRollup`.
# Output: the curated checks in a given state (see CURATED_MODE below).
#         Everything non-curated (SonarCloud, fullsend dispatch/*, …) is dropped.
#
# Loaded with `jq -f` by both consumers, which MUST agree on the red set or the
# dedup contract breaks:
#   - .fullsend/rhdh/agents/ci-diagnose.md      (Phase 1)
#   - .github/workflows/ci-diagnose-agent.yaml  (red-set / dedup / settle-gate)
#
# CURATED_MODE (env var) picks the output; unset keeps the classic red set, so
# existing callers are unaffected:
#   unset / other  → curated checks that are RED (finished & failing)
#   "settling"     → curated checks that are still PENDING or running
#
# ─── To change what ci-diagnose watches, edit ONLY this block ───────────────
def curated:
  {
    # Commit statuses (Prow, comment-commands), matched on their context:
    status_prefixes:  ["ci/prow/"],           # matched by prefix
    status_names:     ["publish", "smoketest"],

    # GitHub Actions checks, matched on their name:
    checkrun_names:   ["E2E Code Quality", "appConfigExamples coverage",
                       "Python unit tests", "smoke"],

    # Which states count as "red" (failed) vs "settling" (not finished):
    red_states:       ["FAILURE", "ERROR"],                        # StatusContext.state
    red_conclusions:  ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED"], # CheckRun.conclusion
    settling_states:  ["PENDING", "EXPECTED"],                     # StatusContext.state
  };
# ────────────────────────────────────────────────────────────────────────────

# Is this rollup entry one of the curated checks (regardless of state)?
def is_curated:
  if   .__typename == "StatusContext" then
         # `// ""` guards a null/absent context: treat it as non-curated rather
         # than crashing startswith() and failing the whole bootstrap step.
         (.context // "") as $ctx
         | (curated.status_prefixes | any(. as $p | $ctx | startswith($p)))
           or ($ctx | IN(curated.status_names[]))
  elif .__typename == "CheckRun" then
         .name | IN(curated.checkrun_names[])
  else false
  end;

# Has it finished and failed?
def is_red:
  if   .__typename == "StatusContext" then .state | IN(curated.red_states[])
  elif .__typename == "CheckRun"      then .conclusion | IN(curated.red_conclusions[])
  else false
  end;

# Is it still pending / running (not settled yet)?
def is_settling:
  if   .__typename == "StatusContext" then .state | IN(curated.settling_states[])
  elif .__typename == "CheckRun"      then (.status != null and .status != "COMPLETED")
  else false
  end;

.statusCheckRollup
| if env.CURATED_MODE == "settling"
  then map(select(is_curated and is_settling))
  else map(select(is_curated and is_red))
  end
