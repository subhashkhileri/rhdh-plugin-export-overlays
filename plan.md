# Plan — Automated ci-diagnose → fix hand-off

Iteration branch: `feat/fullsend-ci-diagnose-agent-iteration`
PR #3356 (squash-merged as `94253dd1`) and its follow-up PR #3520 (`28cddab8`,
adds the `/fs-diagnose` comment trigger) are now on `main`. This branch has
been rebased onto current `upstream/main`, so PR #3518's base is plain `main`
and its diff is just this iteration's own changes.

## Goal

Today, when `ci-diagnose` finds a fixable failure, it only *links* `/fs-fix` in
the sticky comment and waits for a human to type the command. This iteration
**automates that hand-off**: after posting the sticky diagnosis, the post-script
submits a `CHANGES_REQUESTED` review as `fullsend-ai-review[bot]`, which is the
built-in bot→fix on-ramp in pinned `reusable-dispatch.yml` — but only under
tight guards, and capped at **2 auto-attempts per PR** by a counter the agent
cannot modify.

## Architecture finding — why not forge `/fs-fix`, and why the post-script *can*

An earlier draft of this PR posted `/fs-fix` as a machine-user PAT from a new
`ci-diagnose-autofix.yaml` workflow. That is **not** the chosen approach.

**What is true:** the post-script cannot post `/fs-fix` as a `User`. It runs
three layers down inside fullsend's pinned reusable workflow. Every token it
can see is an App token (`type: Bot`). `fullsend.yaml` drops Bot
`issue_comment`s (`comment.user.type != 'Bot'`), and a repo-custom PAT cannot
be seeded into the pinned harness env (`workflow_call.secrets` is GCP/OTEL/Jira
only). Forging a human slash command is also the wrong shape: ADR 0054 says
bot-to-bot hand-off is labels / forge events, not slash commands. This repo
already does that (`ci-diagnose` label cycle, e2e-triage `ready-to-code`).

**What was wrong:** that finding does **not** mean the hand-off cannot live in
the post-script. Fix has two live on-ramps in `reusable-dispatch.yml`:

1. Non-bot `/fs-fix`
2. `pull_request_review` + `changes_requested` from `fullsend-ai-review[bot]`
   (or `${ORG}-review[bot]`) on same-repo PRs without `fullsend-no-fix`; bot
   PR authors auto-qualify

ci-diagnose already uses `role: review` / `slug: fullsend-ai-review`. Mint
grants that App `pull_requests: write`. App-token writes **do** emit webhooks
(only `GITHUB_TOKEN` is suppressed). The diagnose post-script can therefore
`gh pr review --request-changes` as the same identity the real review agent
uses. Frozen `fix.md` already reads that review body in bot mode.

Do **not** CEL-trigger `fix.yaml` (hits generic `harness-run`: default-branch
checkout, no `HUMAN_INSTRUCTION`, no eligibility). Do **not** allowlist bot
`/fs-fix` in managed `fullsend.yaml`. A thin `workflow_dispatch` wrapper
around `reusable-fix.yml` is a fallback (Approach 2) but that file is a
per-org leftover (ADR 44 / 62).

**Chosen approach (Approach 1):** `post-ci-diagnose.sh` submits
`CHANGES_REQUESTED` as the review App. No PAT, no new workflow, no eligibility
marker in the sticky comment (the post-script reads `agent-result.json`).

## Flow

```
CI goes red → ci-diagnose-agent.yaml (bootstrap) cycles the `ci-diagnose` label
  → ci-diagnose agent runs, emits agent-result.json (comment_body + checks)
  → post-ci-diagnose.sh upserts the sticky comment (App token)
  → same script, same token: if guards pass, gh pr review --request-changes
    with a body that names each pr_regression suggestion +
    <!-- ci-diagnose-autofix: <sha> -->
  → pull_request_review (submitted) fires
  → fullsend.yaml (Bot filter does not apply to reviews) → inlined fix job
  → fix.md bot mode reads the last CHANGES_REQUESTED body from that bot
```

## What has to be true for the hand-off to happen (guards)

The post-script reviews nothing unless **all** hold. API errors skip the
hand-off (fail closed) and do **not** fail the sticky comment already posted.

1. **Diagnosis is not stale** — analyzed `head_sha` still matches the PR head.
   The stale-notice path never requests changes.
2. **There is something this PR caused that a change *in this repo* can fix**
   — ≥1 check with `classification == pr_regression` and a non-empty
   `suggestion` in `agent-result.json`. `pre_existing` is diagnosed and, when
   an open PR already addresses it, linked in the sticky comment — it is **not**
   auto-fixed on this PR. Excluded from hand-off: `pre_existing`, `flake`,
   `config_env`, `product_bug`, `needs_human`.
3. **PR author is the AI coder bot** — `fullsend-ai-coder[bot]`. Never human PRs.
4. **Same-repo branch, not a fork** — `.head.repo.full_name ==
   .base.repo.full_name`.
5. **Under the auto-attempt cap** — fewer than 2 prior auto-fix reviews on
   this PR (counter below).
6. **Not manually disabled** — the existing `fullsend-no-fix` label is absent
   (reuse the platform's opt-out; `/fs-fix-stop` already sets it).
7. **Human hasn't taken over** — no non-Bot comment whose body matches
   `^\s*/fs-fix(\s|$)`.
8. **Not already handed off for this exact commit** — a review body already
   contains `<!-- ci-diagnose-autofix: <head_sha> -->`.

## The iteration cap — how "2" is enforced immune to the agent

The counter lives in state **no agent can write**. Neither the diagnose agent
nor the fix agent can post reviews (read-only sandboxes; only the runner-side
post-script writes to GitHub). So the **count of our own auto-fix reviews is
the counter**:

- Every auto-fix review the post-script submits carries a hidden marker
  embedding the head SHA it targeted: `<!-- ci-diagnose-autofix: <sha> -->`.
- Before reviewing, the post-script counts existing PR **reviews** containing
  that marker prefix. Semantics: **lifetime count, cap = 2, no automatic
  reset.** If ≥ 2, stop (and drop a one-time "auto-fix budget exhausted" issue
  comment, marker-idempotent via `<!-- ci-diagnose-autofix-exhausted -->`).
- The marker is what distinguishes diagnose-handoff reviews from real
  review-agent `CHANGES_REQUESTED` events that share `fullsend-ai-review[bot]`.
- **Idempotency per SHA (guard #8):** if a review already contains the marker
  for the *current* head SHA, skip.
- Per-PR, no separate state store; resets only if a trusted human
  dismisses/deletes the reviews (an intentional reset, not agent tampering).
  Rationale for lifetime-2: if two full fix attempts didn't get the PR green,
  a human should look.

Why not reuse the fix agent's built-in `FIX_ITERATION` cap: it counts
`fullsend-fix`-authored commits against a **single shared** ceiling (5 bot / 10
human) and cannot distinguish "ci-diagnose-triggered" from "review-triggered" or
"human-triggered" attempts. The marker-review counter is the only way to scope
the limit to *this* loop at exactly 2. The built-in cap still applies as a
coarser backstop — whichever is tighter wins.

## The review body (what frozen fix.md reads)

Because `fix.md` is frozen and bot-mode fix reads the last
`CHANGES_REQUESTED` body from the review bot, the body is self-sufficient:

```
CI diagnosis found PR-regression failures on `<HEAD_SHA>`.

These findings are caused by this PR. Implement each suggested fix. Do not
treat them as out of scope. Leave flake, pre_existing, config_env,
product_bug, and needs_human checks alone.

### `E2E Code Quality`

<suggestion>

Root cause: <root_cause>

<!-- ci-diagnose-autofix: <HEAD_SHA> -->
```

**Dependent schema/prompt change (diagnose-side only, fix agent untouched):**
`suggestion` stays required for `pre_existing`. Auto-hand-off is
`pr_regression` only. For `pre_existing`, Phase 3b searches **any** open PR
(human or bot; no tracking-issue / `[fullsend] E2E:` filter) whose title or
body addresses the same failure, and records matches in `related_prs` + the
sticky comment. No eligibility marker in `comment_body`.

## Files to change

| File | Change |
|------|--------|
| `.fullsend/rhdh/scripts/post-ci-diagnose.sh` | After sticky upsert: evaluate guards, maybe `gh pr review --request-changes` as the review App. Fail-closed on API errors; never fail the already-posted sticky. |
| `.github/workflows/ci-diagnose-autofix.yaml` | **DELETE.** PAT + forged `/fs-fix` path is not used. |
| `.github/CODEOWNERS` | Drop the deleted workflow's owners line. Keep `ci-diagnose-agent.yaml`. |
| `.fullsend/rhdh/agents/ci-diagnose.md` | Drop the eligibility marker. Footer: auto hand-off + `/fs-fix` / `/fs-fix-stop`. Phase 3b: search open PRs for `pre_existing` and render `related_prs`. Constraints: hand-off is the post-script review. |
| `.fullsend/rhdh/schemas/ci-diagnose-result.schema.json` | `suggestion` required for `pre_existing`; optional `related_prs` on a check; `comment_body` no longer requires the eligibility marker. |
| `.fullsend/rhdh/harness/ci-diagnose.yaml` | Comment only: post-script also submits the review. No token wiring (`role: review` already mints the App token). |
| `docs/fullsend.md` | Document the review hand-off, the guards, the cap. No PAT provisioning. |
| `.fullsend/rhdh/agents/fix.md` | **No change** — bot mode already reads the review body. |
| `plan.md` | This file (design record). |

## Post-script logic sketch (pseudocode)

```
# after sticky upsert; STALE diagnoses return here
maybe_handoff_to_fix:
  stale || empty head_sha                              && return
  count(checks where classification==pr_regression
        and suggestion nonempty) >= 1                  || return
  pr = gh api repos/<repo>/pulls/<n>                   || return  # fail closed
  pr.user.login == "fullsend-ai-coder[bot]"            || return
  pr.head.repo.full_name == pr.base.repo.full_name     || return
  labels has no "fullsend-no-fix"                      || return
  no HUMAN comment matching ^\s*/fs-fix(\s|$)          || return
  no review body containing "<!-- ci-diagnose-autofix: <sha> -->" || return
  n = count reviews whose body contains "<!-- ci-diagnose-autofix:"
  [ "$n" -lt 2 ]                                       || (maybe exhausted note; return)
  gh pr review --request-changes --body-file REVIEW
```

## Security considerations

- **No extra secret.** The review App token is the same mint already used to
  post the sticky comment. Diagnose sandbox stays read-only; only the
  post-script writes GitHub.
- **Blast radius:** guards restrict action to bot-authored, same-repo PRs only
  — a fork PR or human PR can never trigger an auto-fix.
- **Loop safety:** a diagnose-handoff review cannot re-trigger ci-diagnose
  (that path is the `ci-diagnose` label). The 2-attempt marker cap + existing
  `FIX_ITERATION` backstop + `fullsend.yaml` per-PR fix concurrency (a human
  `/fs-fix` cancels an in-flight bot fix) together stop runaways. Prefetch
  takes the **last** `CHANGES_REQUESTED` from the review bot — same identity
  as the real review agent, which is why the review body must be prescriptive
  and must tell fix not to treat the findings as out of scope.
- **Reset only by trusted humans:** the only way to reset the counter is
  dismissing/deleting the marked reviews, which requires write access.

## Testing note

The post-script runs inside the diagnose job on the PR branch (the harness
checks out the PR). Unlike an `issue_comment` workflow that executes the
default-branch copy, this path can be exercised on the open PR once a
bot-authored PR in this repo goes red with a `pr_regression` finding — or
after merge. Guard skips (human PR, no `pr_regression`, cap) are observable
as `::notice::` lines in the diagnose post-script logs.

## Stacked-PR / branching (resolved)

- Branch was originally created off `b0582732` (tip of
  `feat/fullsend-ci-diagnose-agent`), while PR #3356 was still open.
- **PR #3356 merged** (squash-merged onto `main` as `94253dd1`), along with two
  post-review fixup commits (`2f1b16b9`, `3c0410fac`) and a follow-up PR #3520
  (`28cddab8`, adds the `/fs-diagnose` comment trigger) — all now on `main`.
- **Rebase performed:** `git rebase --onto upstream/main b0582732 HEAD` —
  this drops the now-squashed-and-superseded original commits (everything up
  to and including `b0582732`) and replays only this iteration's own commit on
  top of current `upstream/main`. One conflict, in `docs/fullsend.md` (both
  #3520 and this iteration edited the same CI Diagnose table row) — resolved
  by merging both edits into the row. The schema file's two independent hunks
  (`minItems: 0` from the fixup, `pre_existing` additions from this iteration)
  auto-merged cleanly.
- PR #3518 (open, base already `main`) was then force-pushed with the rebased
  branch, shrinking its diff to just this iteration's own 6 files.
- Keep commits scoped; never `git add -A` (untracked `.codex/` must stay out).

## Decisions (resolved)

1. **Host of the hand-off:** ✅ `post-ci-diagnose.sh` via `CHANGES_REQUESTED`
   as `fullsend-ai-review[bot]` (Approach 1). The PAT workflow is deleted.
   Posting `/fs-fix` as a User is unnecessary once the review on-ramp is used.
2. **Human back-off:** ✅ Yes — once any human posts `/fs-fix`, auto-fix stays
   silent for that PR (guard #7).
3. **`fix.md` / fix harness:** ✅ No change — bot mode already reads the last
   `CHANGES_REQUESTED` body from the review bot.
4. **Hand-off set:** ✅ `pr_regression` only. `pre_existing` is reported
   (and linked to an open PR when Phase 3b finds one), not auto-fixed
   inline. `flake` / `config_env` / `product_bug` / `needs_human` → not
   handed off.
5. **Counter:** ✅ Lifetime count of reviews containing
   `<!-- ci-diagnose-autofix:`, cap 2, no auto-reset; per-SHA idempotency.
   Marker (not author login) distinguishes diagnose reviews from real review
   agent reviews that share the same bot.
6. **Token identity:** ✅ Existing review App mint. No `FS_AUTOFIX_TOKEN`.
7. **Review body:** ✅ Prescriptive per-check `suggestion` + `root_cause`, plus
   explicit "caused by this PR / do not treat as out of scope" instruction.

## Open questions (resolved)

1. **Budget-exhausted UX:** ✅ Post one short issue comment the first time the
   cap is hit (marker-idempotent via `<!-- ci-diagnose-autofix-exhausted -->`),
   then stay silent.
2. **Secret name:** ✅ N/A — no PAT. Feature is on whenever diagnose runs with
   the review App token (already required to post the sticky comment).
