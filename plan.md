# Plan — Automated ci-diagnose → fix hand-off

Iteration branch: `feat/fullsend-ci-diagnose-agent-iteration`
PR #3356 (squash-merged as `94253dd1`) and its follow-up PR #3520 (`28cddab8`,
adds the `/fs-diagnose` comment trigger) are now on `main`. This branch has
been rebased onto current `upstream/main`, so PR #3518's base is plain `main`
and its diff is just this iteration's own changes.

## Goal

Today, when `ci-diagnose` finds a fixable failure, it only *links* `/fs-fix` in
the sticky comment and waits for a human to type the command. This iteration
**automates that hand-off**: a `/fs-fix` comment is posted automatically (as a
real user, not a bot) that points the fix agent at the diagnosis — but only
under tight guards, and capped at **2 auto-attempts per PR** by a counter the
agent cannot modify.

## ⚠️ Architecture finding — the hand-off cannot live in the post-script

The original design put the hand-off in `post-ci-diagnose.sh`. **That is not
wireable** with the pinned upstream, and the reason is worth recording so we
don't revisit it:

- The post-script runs three layers down, **inside fullsend's own code**:
  `our shim` → `reusable-dispatch.yml@84c8bbbb (fullsend-ai/fullsend, pinned)`
  → `harness-run` job → `./.defaults/ action.yml` "Run fullsend" step →
  `fullsend run` → the post-script.
- `fullsend run` expands the harness YAML `env.runner: FOO: ${FOO}` entries from
  the **process env of that step** — a copy of an existing var, never a source.
  Every var e2e-triage/ci-diagnose reference (`GH_TOKEN`,
  `GOOGLE_APPLICATION_CREDENTIALS`, `GITHUB_ISSUE_URL`, …) is **seeded by an
  upstream step first** (mint-token, setup-gcp, the "Run harness agent" env
  block). A new `${FS_AUTOFIX_TOKEN}` has **no seeder**, so it expands to `""`.
- There is no repo-side way to seed it: it's a PAT, so it can't be a committed
  literal (and gitleaks in the post-script would block the run), and repo
  `vars` are non-secret (logged) so a PAT can't live there either. The only
  secret-safe seeder is `${{ secrets.X }}`, and the only steps that could write
  it into this job's env are in the **pinned upstream repo we don't own**.
- Upstream's `workflow_call.secrets` is a **fixed list** (GCP/OTEL/JIRA) with no
  slot for a custom secret, and our shim passes named secrets, not
  `secrets: inherit` — so the secret can't even enter the reusable workflow's
  scope. fullsend's own action says it plainly: *"Does not read agent
  configuration from the repository; configure the job environment or CLI as
  needed"* — i.e. the **caller** must set up the env, and for built-in flows the
  caller is upstream, which wires only the fixed set.

**Why e2e-triage doesn't hit this:** it never needs a *new* secret. It hands off
to the coder via a **`ready-to-code` label**, and the dispatcher explicitly
allows **bot-applied labels** to trigger the code stage. The `fix` stage has
**no label trigger** — it's reachable only by a `/fs-fix` *comment* (non-bot
required) or a `changes_requested` review from `fullsend-review[bot]`. Comments
from bots are dropped by the shim's `comment.user.type != 'Bot'` filter, which
is exactly why a **non-bot token** is required — and that token can only be
consumed from a workflow **we own**.

**Chosen approach:** move the hand-off into a new repo-owned workflow,
`.github/workflows/ci-diagnose-autofix.yaml`, which runs in this repo's context
and can read `${{ secrets.FS_AUTOFIX_TOKEN }}` directly. Same token identity,
same guards, same 2-attempt cap — only the host moves. `post-ci-diagnose.sh` and
`ci-diagnose.yaml` need **no token wiring**.

## Flow

```
CI goes red → ci-diagnose-agent.yaml (bootstrap) cycles the `ci-diagnose` label
  → ci-diagnose agent runs, emits comment_body incl. an autofix-eligibility marker
  → post-ci-diagnose.sh upserts the sticky comment (App token, type Bot)
  → issue_comment (created/edited) fires
  → NEW ci-diagnose-autofix.yaml wakes, checks guards + cap
  → posts `/fs-fix …` as the machine-user PAT (type User)
  → passes the shim's non-Bot filter → dispatches the fix stage
```

## What has to be true for the hand-off to happen (guards)

The autofix workflow posts nothing unless **all** hold:

1. **The triggering comment is the diagnosis comment** — authored by a `Bot`
   and its body contains the sticky marker `<!-- ci-diagnose -->` and the
   autofix-eligibility marker (below). This keeps the workflow from reacting to
   arbitrary comments, and — since the `/fs-fix` comment it posts carries
   neither the diagnosis marker nor is bot-authored — prevents any self-loop.
2. **PR author is the AI coder bot** — `github.event.issue.user.login ==
   "fullsend-ai-coder[bot]"` (`.user.type == "Bot"`). Only auto-fix PRs the bot
   itself opened, never human PRs.
3. **Same-repo branch, not a fork** — `gh api repos/<repo>/pulls/<n>` with
   `.head.repo.full_name == .base.repo.full_name`. Never act on fork PRs (a fork
   head is untrusted and outside this repo's control).
4. **There is something a change *in this repo* can fix** — the eligibility
   marker's `fixable` array is non-empty (≥1 check classified `pr_regression`
   **or `pre_existing`**). This is the "would a change in this repo fix it" axis
   (= e2e-triage's `test_fix`), not the "did the PR cause it" axis. The fix is
   applied **inline** on the bot's PR (goal: make that PR mergeable), even for
   `pre_existing` findings it didn't cause. Excluded: `flake` (no code change
   helps → summary only, per e2e-triage's `infra_flake`), `config_env` (rerun,
   not a code fix), `product_bug` (fix is upstream), `needs_human`.
5. **Under the auto-attempt cap** — fewer than 2 prior auto-fix hand-offs on
   this PR (counter below).
6. **Not manually disabled** — the existing `fullsend-no-fix` label is absent
   (reuse the platform's opt-out; `/fs-fix-stop` already sets it).
7. **Human hasn't taken over** — no human `/fs-fix` comment already on the PR.
8. **Not already handed off for this exact commit** — idempotency per head SHA
   (below).

## The iteration cap — how "2" is enforced immune to the agent

The counter lives in state **no agent can write**. Neither the diagnose agent
nor the fix agent can post/edit/delete PR comments (read-only sandboxes; only
the runner-side post-script and this repo-owned workflow write to GitHub). So the
**count of our own auto-fix comments is the counter**:

- Every auto-fix `/fs-fix` comment the workflow posts carries a hidden marker
  embedding the head SHA it targeted: `<!-- ci-diagnose-autofix: <sha> -->`.
- Before posting, the workflow counts existing PR comments containing the
  `ci-diagnose-autofix` marker **authored by the machine-user**. Semantics:
  **lifetime count, cap = 2, no automatic reset.** If ≥ 2, stop (and optionally
  drop a one-time "auto-fix budget exhausted — a human can take over with
  `/fs-fix`" note).
- **Idempotency per SHA (guard #8):** if a marker already exists for the
  *current* head SHA, skip (don't hand off twice for the same commit). The
  post-script edits the sticky comment in place on every re-run, so the workflow
  fires on each `edited` event — this guard makes repeated fires no-ops until a
  new commit changes the SHA.
- Per-PR, no separate state store; resets only if a trusted human deletes the
  comments (an intentional reset, not agent tampering). Rationale for
  lifetime-2: if two full fix attempts didn't get the PR green, a human should
  look; a fix agent that keeps *introducing* failures is exactly the runaway the
  cap exists to stop.

Why not reuse the fix agent's built-in `FIX_ITERATION` cap: it counts
`fullsend-fix`-authored commits against a **single shared** ceiling (5 bot / 10
human) and cannot distinguish "ci-diagnose-triggered" from "review-triggered" or
"human-triggered" attempts. The marker-comment counter is the only way to scope
the limit to *this* loop at exactly 2. The built-in cap still applies as a
coarser backstop — whichever is tighter wins.

## The token — why a non-bot PAT, and what admin must provision

- A GitHub App / `GITHUB_TOKEN` write produces a `type: Bot` comment (dropped by
  the shim filter) **and** suppresses the webhook (anti-recursion). A **real
  GitHub user's PAT** produces `type: User` → passes the filter *and* emits the
  webhook that dispatches fix.
- **Identity: a dedicated machine-user account** (type `User`, not an
  App/`[bot]`). Not a real human's PAT.
- **Admin steps (one-time, prerequisite):**
  1. Create/designate a machine-user GitHub account (none exists in the org
     today — all fullsend identities are Apps/`[bot]`).
  2. Add it as a **write collaborator** (the dispatcher authorizes `/fs-fix`
     via the collaborator permission API — admin/maintain/write).
  3. Issue a **fine-grained PAT scoped to this repo only**: `Pull requests:
     write` + `Metadata: read`. Nothing else — it only posts a comment.
  4. Store it as the repo secret `FS_AUTOFIX_TOKEN`.
- The machine-user's own `/fs-fix` comments are **excluded** from guard #7's
  "a human took over" detection.
- The secret is consumed **only** by `.github/workflows/ci-diagnose-autofix.yaml`
  (our repo's context). It never touches the harness, the sandbox, or the
  post-script.

## The autofix-eligibility marker (diagnose-side)

The workflow can only see what's in the sticky comment (public GitHub data) — it
cannot read `agent-result.json`. So the ci-diagnose agent embeds a small
machine-readable marker in `comment_body` that the workflow parses:

```
<!-- ci-diagnose-autofix-eligible: {"sha":"<HEAD_SHA>","fixable":["ci/prow/e2e-ocp-helm","appConfigExamples coverage"]} -->
```

- `sha` — the analyzed head SHA (matches the existing state marker's `sha`).
- `fixable` — names of checks classified `pr_regression` or `pre_existing`
  (empty ⇒ guard #4 fails ⇒ no hand-off).

Names only — no suggestions in the marker (keeps it small and avoids embedding
prose that could contain `-->`). The full per-check `root_cause` / `evidence` /
`suggestion` stay in the human-readable sticky comment, which the `/fs-fix` body
points the fix agent to read.

## The comment the workflow posts

Because `fix.md` is frozen and human-mode fix only *guarantees*
`HUMAN_INSTRUCTION` (= the `/fs-fix` body), the body is self-sufficient for
action: it names the fixable checks (from the marker) **and** links the sticky
comment for full root_cause/evidence/suggestions. It degrades gracefully if the
agent never opens the sticky comment.

```
/fs-fix CI is failing on this PR. Apply fixes for these findings (all fixable
in this repo); leave any flake / config_env / product_bug checks alone:

- `E2E Code Quality`
- `appConfigExamples coverage`

Full root cause / evidence / suggested fixes: see the CI diagnosis comment
(marker <!-- ci-diagnose -->) on this PR.

<!-- ci-diagnose-autofix: <HEAD_SHA> -->
```

The `<!-- ci-diagnose-autofix: <sha> -->` marker is what the counter (and the
per-SHA idempotency guard) keys off.

**Dependent schema/prompt change (diagnose-side only, fix agent untouched):**
extend `ci-diagnose-result.schema.json`'s conditional-required rule to add
`pre_existing` (so `suggestion` is always populated for the fixable set), and
extend `ci-diagnose.md` remediation guidelines to require a prescriptive
`suggestion` for `pre_existing` too.

## Files to change

| File | Change |
|------|--------|
| `.github/workflows/ci-diagnose-autofix.yaml` | **NEW.** `issue_comment` (created/edited) trigger; coarse `if:` gate (PR comment, Bot author, marker present); steps evaluate guards 2–8, count autofix markers, and post `/fs-fix` via `${{ secrets.FS_AUTOFIX_TOKEN }}`. Guard reads use `github.token`; only the final comment uses the PAT. Minimal `permissions:` + a per-PR `concurrency` group. |
| `.fullsend/rhdh/agents/ci-diagnose.md` | (1) Emit the `<!-- ci-diagnose-autofix-eligible: … -->` marker in `comment_body`. (2) Footer wording: hand-off is automatic for bot-authored same-repo PRs; `/fs-fix` becomes "a human can take over / stop with `/fs-fix-stop`"; note the 2-attempt auto cap. (3) Require a prescriptive `suggestion` for `pre_existing`. |
| `.fullsend/rhdh/schemas/ci-diagnose-result.schema.json` | Add `pre_existing` to the conditional-required rule so `suggestion` is required for it (currently `pr_regression`/`flake` only). |
| `docs/fullsend.md` | Document the auto hand-off, the guards, the cap, and the `FS_AUTOFIX_TOKEN` / `FS_AUTOFIX_USER` provisioning. |
| `.github/CODEOWNERS` | Add `/.github/workflows/ci-diagnose-autofix.yaml` to the maintainer-approval block (same owners as the other fullsend workflows). |
| `.fullsend/rhdh/scripts/post-ci-diagnose.sh` | **No change** — it already posts `comment_body` (marker included) verbatim; the stale-notice path omits the marker, so a stale diagnosis never hands off. |
| `.fullsend/rhdh/harness/ci-diagnose.yaml` | **No change** — no token wiring is possible or needed. |
| `.fullsend/rhdh/agents/fix.md` | **No change** — rely on `HUMAN_INSTRUCTION` precedence. |
| `plan.md` | This file (remove before final merge, or keep as design record — your call). |

## Workflow logic sketch (pseudocode)

```
on: issue_comment [created, edited]
if: issue.pull_request
    && comment.user.type == 'Bot'
    && contains(comment.body, '<!-- ci-diagnose -->')
    && contains(comment.body, '<!-- ci-diagnose-autofix-eligible:')
job (permissions: read; final post uses FS_AUTOFIX_TOKEN):
  marker   = parse ci-diagnose-autofix-eligible JSON from comment body
  sha      = marker.sha ; fixable = marker.fixable
  [ ${#fixable[@]} -gt 0 ]                          || exit 0   # guard #4
  issue.user.login == "fullsend-ai-coder[bot]"      || exit 0   # guard #2
  pr = gh api repos/<repo>/pulls/<n>
  pr.head.repo.full_name == pr.base.repo.full_name  || exit 0   # guard #3 (no fork)
  labels has no "fullsend-no-fix"                    || exit 0   # guard #6
  no HUMAN /fs-fix comment on PR                     || exit 0   # guard #7 (human took over)
  no ci-diagnose-autofix marker for <sha> yet        || exit 0   # guard #8 (idempotent per SHA)
  n = count PR comments by $AUTOFIX_USER with "<!-- ci-diagnose-autofix:"
  [ "$n" -lt 2 ]                                     || exit 0   # guard #5 (cap; optional note)
  GH_TOKEN=$FS_AUTOFIX_TOKEN gh pr comment <n> --body "$FS_FIX_BODY"
```

**Detecting "a human took over"** (guard #7): a PR comment whose body starts with
`/fs-fix` and whose author is **neither** a bot **nor** the machine-user ⇒ back off.

## Security considerations

- **Token isolation:** `FS_AUTOFIX_TOKEN` lives only in the repo-owned workflow's
  context — never in the harness, sandbox, or post-script. A prompt-injected
  diagnose/fix agent cannot see or use it.
- **Blast radius:** guards restrict action to bot-authored, same-repo PRs only —
  a fork PR or human PR can never trigger an auto-fix, so an attacker can't get
  the machine-user to act on attacker-controlled code.
- **`issue_comment` runs from the default branch.** Like the shim, this
  workflow's behavior is defined by its default-branch version, so a PR cannot
  edit it to exfiltrate the secret. (Corollary: it can only be **tested** once
  it's on the repo's default branch — see below.)
- **Loop safety:** the eligibility gate (marker + Bot author) means our own
  `/fs-fix` comment can't re-trigger the workflow; the 2-attempt marker cap +
  existing `FIX_ITERATION` backstop + `fullsend.yaml` per-PR fix concurrency
  (a human `/fs-fix` cancels an in-flight bot fix) together stop runaways.
- **Reset only by trusted humans:** the only way to reset the counter is deleting
  the marker comments, which requires write access.

## Testing note

`issue_comment`-triggered workflows execute the **default-branch** copy of the
file. This workflow is not yet on `main` (PR #3518 is open), so it still can't
be exercised end-to-end until #3518 merges. Plan to validate end-to-end after
merge, or on a scratch repo where the file is on the default branch.

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

1. **Host of the hand-off:** ✅ Repo-owned workflow
   `.github/workflows/ci-diagnose-autofix.yaml` (post-script can't reach a
   non-bot secret — see the architecture finding).
2. **Human back-off:** ✅ Yes — once any human posts `/fs-fix`, auto-fix stays
   silent for that PR (guard #7).
3. **`fix.md` / fix harness:** ✅ No change — rely on `HUMAN_INSTRUCTION`.
4. **Hand-off set:** ✅ `pr_regression` + `pre_existing` (fixable-in-repo axis),
   fixed **inline** on the bot PR. `flake` → summary only; `config_env` /
   `product_bug` / `needs_human` → not handed off.
5. **Counter:** ✅ Lifetime count of machine-user autofix-marker comments, cap 2,
   no auto-reset; per-SHA idempotency.
6. **Token identity:** ✅ Dedicated machine-user PAT, repo secret
   `FS_AUTOFIX_TOKEN`, consumed only by the autofix workflow.
7. **Comment shape:** ✅ Hybrid — inline fixable check names + link the sticky
   comment for full detail (marker carries names only, not suggestions).

## Open questions (resolved)

1. **Budget-exhausted UX:** ✅ Post one short note the first time the cap is hit
   (marker-idempotent via `<!-- ci-diagnose-autofix-exhausted -->`), then stay
   silent.
2. **Secret name:** ✅ `FS_AUTOFIX_TOKEN` (secret) + `FS_AUTOFIX_USER` (repo
   variable for the machine-user login). Feature no-ops if either is unset.
</content>
</invoke>
