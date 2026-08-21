#!/usr/bin/env bash
# Post-script: upsert ONE sticky CI-diagnose comment on the PR.
#
# Runs on the GitHub Actions runner AFTER the sandbox is destroyed.
# The ci-diagnose agent runs read-only and cannot write to GitHub. It renders
# the comment markdown into agent-result.json (`comment_body`); this script
# posts it — editing the existing sticky comment in place when one exists, so
# re-runs UPDATE the comment rather than spamming a new one per check.
#
# This script does NOT:
#   - Push branches, create PRs, or create issues (ci-diagnose is diagnose-only)
#   - Add or remove labels (the bootstrap workflow owns the ci-diagnose label)
#   - Perform any classification (the agent does that in-sandbox)
#
# Steps:
#   1. Locate and validate agent-result.json
#   2. Scan the result file for secrets (gitleaks) — refuse to post on a hit
#   3. Resolve the PR number (from the result, falling back to GITHUB_ISSUE_URL)
#   4. Find the existing sticky comment via the `<!-- ci-diagnose -->` marker
#   5. PATCH it in place if found, else create a new comment
#
# Required environment variables:
#   GH_TOKEN          — GitHub token with pull-requests/issues write
#   REPO_FULL_NAME    — owner/repo (default: redhat-developer/rhdh-plugin-export-overlays)
#
# Optional environment variables:
#   GITHUB_ISSUE_URL  — HTML URL of the PR (fallback source for the PR number)
#   PUSH_TOKEN        — dedicated write token (falls back to GH_TOKEN)
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
GITLEAKS_VERSION="8.30.1"
GITLEAKS_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"

STICKY_MARKER="<!-- ci-diagnose -->"
REPO_FULL_NAME="${REPO_FULL_NAME:-redhat-developer/rhdh-plugin-export-overlays}"

: "${GH_TOKEN:?GH_TOKEN is required}"
export GH_TOKEN
echo "::add-mask::${GH_TOKEN}"

PUSH_TOKEN="${PUSH_TOKEN:-${GH_TOKEN}}"
echo "::add-mask::${PUSH_TOKEN}"

# Promote to PUSH_TOKEN for write permissions on PR comments.
export GH_TOKEN="${PUSH_TOKEN}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

sanitize_for_gha() {
  local text="${1:-}" prev=""
  while [[ "${text}" != "${prev}" ]]; do
    prev="${text}"
    text="${text//::/}"
    text="${text//\%0A/}"
    text="${text//\%0a/}"
    text="${text//\%0D/}"
    text="${text//\%0d/}"
  done
  text="${text//$'\n'/ }"
  text="${text//$'\r'/}"
  echo "${text}"
}

install_gitleaks() {
  if command -v gitleaks >/dev/null 2>&1; then
    return 0
  fi
  echo "Installing gitleaks v${GITLEAKS_VERSION}..."
  mkdir -p "${HOME}/.local/bin"
  if curl -fsSL --proto =https \
    "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
    -o /tmp/gitleaks.tar.gz \
    && echo "${GITLEAKS_SHA256}  /tmp/gitleaks.tar.gz" | sha256sum -c --quiet \
    && tar xzf /tmp/gitleaks.tar.gz -C "${HOME}/.local/bin" gitleaks \
    && rm /tmp/gitleaks.tar.gz; then
    export PATH="${HOME}/.local/bin:${PATH}"
    echo "gitleaks installed"
    return 0
  fi
  echo "::error::Failed to install gitleaks"
  return 1
}

# ---------------------------------------------------------------------------
# 1. Locate agent-result.json
# ---------------------------------------------------------------------------
RESULT_FILE=""
for dir in iteration-*/output; do
  if [[ -f "${dir}/agent-result.json" ]]; then
    RESULT_FILE="${dir}/agent-result.json"
  fi
done

if [[ -z "${RESULT_FILE}" ]]; then
  echo "::warning::No agent-result.json found"
  ls -R iteration-*/ 2>/dev/null || true
  exit 0
fi

RESULT_FILE="$(cd "$(dirname "${RESULT_FILE}")" && pwd)/$(basename "${RESULT_FILE}")"
echo "Found agent-result.json: ${RESULT_FILE}"

if ! jq empty "${RESULT_FILE}" 2>/dev/null; then
  echo "::error::agent-result.json is not valid JSON"
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Scan agent-result.json for secrets
# ---------------------------------------------------------------------------
if ! install_gitleaks; then
  echo "::error::Failed to install gitleaks — refusing to post without secret scan"
  exit 1
fi
echo "Scanning agent-result.json for secrets..."
SCAN_DIR="$(mktemp -d)"
cp "${RESULT_FILE}" "${SCAN_DIR}/agent-result.json"
if ! gitleaks detect --source "${SCAN_DIR}" --no-git --redact 2>/dev/null; then
  echo "::error::Secret detected in agent-result.json — refusing to post"
  rm -rf "${SCAN_DIR}"
  exit 1
fi
rm -rf "${SCAN_DIR}"
echo "Result file scan passed"

# ---------------------------------------------------------------------------
# 3. Resolve PR number and comment body
# ---------------------------------------------------------------------------
PR_NUMBER="$(jq -r '.pr_number // empty' "${RESULT_FILE}")"
if [[ ! "${PR_NUMBER}" =~ ^[0-9]+$ ]]; then
  # Fall back to parsing the PR number from the trigger URL.
  PR_NUMBER="${GITHUB_ISSUE_URL##*/}"
fi
if [[ ! "${PR_NUMBER}" =~ ^[0-9]+$ ]]; then
  echo "::error::Could not resolve a numeric PR number (result=${PR_NUMBER}, url=${GITHUB_ISSUE_URL:-unset})"
  exit 1
fi

BODY_FILE="$(mktemp)"
jq -r '.comment_body // empty' "${RESULT_FILE}" > "${BODY_FILE}"
if [[ ! -s "${BODY_FILE}" ]]; then
  echo "::error::agent-result.json has no comment_body"
  rm -f "${BODY_FILE}"
  exit 1
fi

# Guard: the body must carry the sticky marker so future runs can find it.
if ! grep -qF "${STICKY_MARKER}" "${BODY_FILE}"; then
  echo "::error::comment_body is missing the sticky marker '${STICKY_MARKER}' — refusing to post"
  rm -f "${BODY_FILE}"
  exit 1
fi

VERDICT="$(jq -r '.verdict // "unknown"' "${RESULT_FILE}")"
CHECK_COUNT="$(jq -r '.checks | length' "${RESULT_FILE}")"
echo "PR #${PR_NUMBER} — verdict: ${VERDICT} — ${CHECK_COUNT} check(s)"

# ---------------------------------------------------------------------------
# 4. Find the existing sticky comment
# ---------------------------------------------------------------------------
EXISTING_ID="$(gh api "repos/${REPO_FULL_NAME}/issues/${PR_NUMBER}/comments" --paginate \
  --jq "[.[] | select(.body | contains(\"${STICKY_MARKER}\"))] | last | .id // empty" 2>/dev/null || true)"

# ---------------------------------------------------------------------------
# 5. Upsert the comment
# ---------------------------------------------------------------------------
if [[ -n "${EXISTING_ID}" ]]; then
  echo "Editing existing sticky comment #${EXISTING_ID}..."
  patch_stderr="$(mktemp)"
  if jq -n --rawfile body "${BODY_FILE}" '{body: $body}' \
    | gh api "repos/${REPO_FULL_NAME}/issues/comments/${EXISTING_ID}" \
        -X PATCH --input - --silent 2>"${patch_stderr}"; then
    echo "Updated sticky comment #${EXISTING_ID} on PR #${PR_NUMBER}"
  else
    echo "::error::Failed to edit comment #${EXISTING_ID}: $(sanitize_for_gha "$(cat "${patch_stderr}")")"
    rm -f "${patch_stderr}" "${BODY_FILE}"
    exit 1
  fi
  rm -f "${patch_stderr}"
else
  echo "No existing sticky comment — creating a new one..."
  create_stderr="$(mktemp)"
  if gh pr comment "${PR_NUMBER}" --repo "${REPO_FULL_NAME}" \
      --body-file "${BODY_FILE}" 2>"${create_stderr}"; then
    echo "Created sticky comment on PR #${PR_NUMBER}"
  else
    echo "::error::Failed to create comment on PR #${PR_NUMBER}: $(sanitize_for_gha "$(cat "${create_stderr}")")"
    rm -f "${create_stderr}" "${BODY_FILE}"
    exit 1
  fi
  rm -f "${create_stderr}"
fi

rm -f "${BODY_FILE}"

echo ""
echo "=== CI Diagnose posted ==="
echo "PR:      #${PR_NUMBER}"
echo "Verdict: ${VERDICT}"
echo "Checks:  ${CHECK_COUNT}"
echo ""
echo "Post-ci-diagnose complete."
