# Shared curated-check filter for ci-diagnose.
#
# Selects the entries from a PR's `statusCheckRollup` (as returned by
# `gh pr view --json statusCheckRollup`) that belong to the curated,
# diagnosable check set — everything else (SonarCloud, fullsend dispatch/*,
# etc.) is ignored.
#
# This file is the SINGLE SOURCE OF TRUTH for that membership test. It is
# loaded with `jq -f` by both:
#   - .fullsend/rhdh/agents/ci-diagnose.md (Phase 1)
#   - .github/workflows/ci-diagnose-agent.yaml (red-set / dedup computation)
#
# Both consumers must derive the same sorted set of red check names from the
# same rollup, or the bootstrap workflow and the agent's state marker will
# disagree about when to (re-)fire (see the dedup contract in both files).
# Edit the check names/types here ONLY — do not fork this predicate.
#
# Output modes (selected via the CURATED_MODE env var, so existing `jq -f`
# callers that set nothing keep getting the red set unchanged):
#   unset / anything else  → the curated checks that are currently RED
#   "settling"             → the curated checks that are still PENDING/running
# The bootstrap uses "settling" to hold off diagnosing until every curated
# check has finished, so it diagnoses once with the complete picture.

# Membership in the curated, diagnosable check set — independent of state.
def is_curated_check:
  ((.__typename == "StatusContext") and (.context | startswith("ci/prow/")))
  or ((.__typename == "StatusContext") and (.context | IN("publish", "smoketest")))
  or ((.__typename == "CheckRun") and (.name | IN("E2E Code Quality", "appConfigExamples coverage", "Python unit tests", "smoke")));

# A finished-and-failing check.
def is_red_state:
  ((.__typename == "StatusContext") and (.state | IN("FAILURE", "ERROR")))
  or ((.__typename == "CheckRun") and (.conclusion | IN("FAILURE", "TIMED_OUT", "ACTION_REQUIRED")));

# A check that has not settled yet (pending status, or a non-COMPLETED run).
def is_settling_state:
  ((.__typename == "StatusContext") and (.state | IN("PENDING", "EXPECTED")))
  or ((.__typename == "CheckRun") and (.status != null) and (.status != "COMPLETED"));

def is_curated_red: is_curated_check and is_red_state;
def is_curated_settling: is_curated_check and is_settling_state;

.statusCheckRollup
| if (env.CURATED_MODE == "settling")
  then map(select(is_curated_settling))
  else map(select(is_curated_red))
  end
