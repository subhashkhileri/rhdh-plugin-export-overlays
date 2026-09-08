#!/usr/bin/env node
// merge-results.ts — Combine per-workspace JSON results into agent-result.json
// Usage: node --experimental-strip-types merge-results.ts --target-branch <branch> --output <path> <workspace-results-dir>

import * as fs from "node:fs";
import * as path from "node:path";

const FIX_CATEGORIES = ["infra_flake", "test_fix", "product_bug", "environment"] as const;
type FixCategory = (typeof FIX_CATEGORIES)[number];
const VALID_CATEGORIES = new Set<string>(FIX_CATEGORIES);
const VALID_ACTIONS = new Set(["create", "comment", "skip"]);

interface Test {
  name: string;
  error: string;
}

interface Issue {
  action: "create" | "comment" | "skip";
  number?: number;
  title?: string;
  labels: string[];
  body: string;
  cycle_ready_to_code: boolean;
}

interface WorkspaceResult {
  workspace: string;
  fix_category: FixCategory;
  tests: Test[];
  root_cause: string;
  root_cause_slug: string;
  issue?: Issue;
}

interface AgentResult {
  target_branch: string;
  workspaces: WorkspaceResult[];
  summary: string;
}

// --- Per-file parsing ---
// Catches the most common LLM authoring mistakes (wrong enum casing, a
// string where an integer is required, a slug that isn't kebab-case) at the
// individual workspace file, with the file name in the error. This is
// separate from schema conformance — the harness's validation_loop already
// validates the final agent-result.json against
// e2e-triage-result.schema.json, but that runs after umbrella merging, so an
// error there can't always be traced back to the input file that caused it.
// Re-encoding the *entire* schema here would just create a second copy that
// can drift; this only checks the handful of fields an LLM is most likely
// to get subtly wrong. `root_cause_slug`'s pattern mirrors the schema's —
// if that pattern changes there, update it here too.
function parseWorkspaceResult(file: string, raw: string): WorkspaceResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file}: failed to parse JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${file}: must be a JSON object`);
  }
  const r = parsed as Record<string, unknown>;

  if (typeof r.workspace !== "string" || r.workspace.length === 0) {
    throw new Error(`${file}: missing or invalid "workspace"`);
  }
  if (!VALID_CATEGORIES.has(r.fix_category as string)) {
    throw new Error(
      `${file}: invalid fix_category "${r.fix_category}" (expected: ${[...VALID_CATEGORIES].join(", ")})`,
    );
  }
  if (typeof r.root_cause_slug !== "string" || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(r.root_cause_slug)) {
    throw new Error(`${file}: invalid root_cause_slug "${r.root_cause_slug}"`);
  }
  if (r.issue && typeof r.issue === "object") {
    const issue = r.issue as Record<string, unknown>;
    if (!VALID_ACTIONS.has(issue.action as string)) {
      throw new Error(`${file}: invalid issue.action "${issue.action}"`);
    }
    if (issue.action === "comment" && typeof issue.number !== "number") {
      throw new Error(
        `${file}: issue.action is "comment" but issue.number is ${typeof issue.number} (expected integer)`,
      );
    }
  }

  return parsed as WorkspaceResult;
}

// --- Truncate long text at a line (or word) boundary instead of
// mid-sentence/mid-fence ---
function truncateAtBoundary(str: string, maxLen: number): string {
  const marker = "\n\n_(truncated)_";
  if (str.length <= maxLen) return str;
  const budget = maxLen - marker.length;
  const half = budget * 0.5;

  let cut = str.lastIndexOf("\n", budget);
  if (cut <= half) {
    // No newline in the back half of the budget (e.g. one very long line) —
    // fall back to a word boundary so we don't split a token/URL.
    cut = str.lastIndexOf(" ", budget);
  }
  if (cut <= half) cut = budget;

  return str.slice(0, cut) + marker;
}

// --- Category dominance ---
// When ≥3 workspaces share a root_cause_slug, they merge into one umbrella
// entry with a single fix_category. Rank favors actionable categories over
// infra_flake so a single misclassified sibling can't cause a real bug to be
// silently skipped — the tradeoff is that one bad classification can pull an
// otherwise-transient group into "create issue" territory. That's considered
// the safer failure mode (a human closes a spurious issue) vs the reverse
// (a real bug never gets filed).
const CATEGORY_RANK: Record<FixCategory, number> = {
  test_fix: 3,
  product_bug: 2,
  environment: 1,
  infra_flake: 0,
};

function dominantCategory(categories: FixCategory[]): FixCategory {
  return categories.reduce((a, b) => (CATEGORY_RANK[a] >= CATEGORY_RANK[b] ? a : b));
}

// --- Umbrella merge ---
function applyUmbrellaRule(results: WorkspaceResult[]): WorkspaceResult[] {
  const groups = new Map<string, WorkspaceResult[]>();
  for (const ws of results) {
    const slug = ws.root_cause_slug;
    if (!groups.has(slug)) groups.set(slug, []);
    groups.get(slug)!.push(ws);
  }

  const merged: WorkspaceResult[] = [];
  for (const [slug, members] of groups) {
    if (members.length >= 3) {
      // Merge into one umbrella entry
      const tests = members.flatMap((m) => m.tests);
      const category = dominantCategory(members.map((m) => m.fix_category));
      const rootCause = members
        .map((m) => `[${m.workspace}] ${m.root_cause}`)
        .join("\n");
      const firstDesc = members[0].root_cause.slice(0, 100);

      let issue: Issue | undefined;
      const issueMembers = members.filter((m) => m.issue && m.issue.action !== "skip");
      if (issueMembers.length > 0) {
        let body = issueMembers
          .map((m) => `## ${m.workspace}\n\n${m.issue!.body}`)
          .join("\n\n---\n\n");
        const allLabels = new Set(issueMembers.flatMap((m) => m.issue!.labels));

        // Siblings may already have separate open issues (found during dedup)
        // before the group was recognized as sharing one root cause. Comment
        // on the oldest one and flag the rest — don't silently drop them.
        const commentNumbers = [
          ...new Set(
            issueMembers
              .filter((m) => m.issue!.action === "comment" && m.issue!.number != null)
              .map((m) => m.issue!.number as number),
          ),
        ].sort((a, b) => a - b);

        if (commentNumbers.length > 1) {
          const others = commentNumbers.slice(1).map((n) => `#${n}`).join(", ");
          body = `**Note:** Related existing issues found for other workspaces in this group: ${others} — review for manual dedup.\n\n${body}`;
        }

        issue = {
          action: commentNumbers.length > 0 ? "comment" : "create",
          ...(commentNumbers.length > 0
            ? { number: commentNumbers[0] }
            : { title: `[fullsend] E2E: ${slug} — ${firstDesc}` }),
          labels: [...allLabels],
          body: truncateAtBoundary(body, 16384),
          cycle_ready_to_code: issueMembers.some((m) => m.issue!.cycle_ready_to_code),
        };
      }

      merged.push({
        workspace: slug,
        fix_category: category,
        tests,
        root_cause: truncateAtBoundary(rootCause, 4096),
        root_cause_slug: slug,
        ...(issue ? { issue } : {}),
      } as WorkspaceResult);
    } else {
      merged.push(...members);
    }
  }

  return merged.sort((a, b) => a.workspace.localeCompare(b.workspace));
}

// --- Summary generation ---
function generateSummary(results: WorkspaceResult[]): string {
  const lines: string[] = [`Workspaces classified: ${results.length}`, ""];
  for (const ws of results) {
    lines.push(`  [${ws.workspace}]`);
    lines.push(`    Category:  ${ws.fix_category}`);
    lines.push(`    Slug:      ${ws.root_cause_slug}`);
    lines.push(`    Tests:     ${ws.tests.length}`);
    const action = ws.issue?.action ?? "skip";
    lines.push(`    Action:    ${action}`);
    lines.push("");
  }
  return truncateAtBoundary(lines.join("\n"), 4096);
}

// --- Validation ---
// Full schema conformance (required fields, enums, length limits, the
// create/comment allOf rules) is enforced downstream by the harness's
// validation_loop (validate-output-schema.sh against
// e2e-triage-result.schema.json) and by fullsend-check-output. Re-checking
// those rules here would be a second copy that can silently drift from the
// schema. This only checks an invariant the schema can't express because it
// spans multiple workspace entries.
function validate(result: AgentResult): string[] {
  const errors: string[] = [];

  const slugCategories = new Map<string, Set<FixCategory>>();
  for (const ws of result.workspaces) {
    if (!ws.root_cause_slug) continue;
    if (!slugCategories.has(ws.root_cause_slug)) slugCategories.set(ws.root_cause_slug, new Set());
    slugCategories.get(ws.root_cause_slug)!.add(ws.fix_category);
  }
  for (const [slug, categories] of slugCategories) {
    if (categories.size > 1) {
      // Applies regardless of group size: dominantCategory() only runs for
      // groups of ≥3, but two workspaces sharing a slug with different
      // categories is the same underlying problem — a slug is supposed to
      // mean "same root cause," which implies "same fix_category."
      errors.push(
        `root_cause_slug "${slug}" has different fix_category values across workspaces ` +
          `(${[...categories].join(", ")}). Workspaces sharing a slug should share a fix_category — ` +
          `reconcile them to the same category, or use different slugs if they aren't actually the same cause.`,
      );
    }
  }

  return errors;
}

function main(): void {
  const args = process.argv.slice(2);
  let targetBranch = "";
  let outputPath = "";
  let inputDir = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target-branch" && args[i + 1]) {
      targetBranch = args[++i];
    } else if (args[i] === "--output" && args[i + 1]) {
      outputPath = args[++i];
    } else if (!args[i].startsWith("--")) {
      inputDir = args[i];
    }
  }

  if (!targetBranch || !outputPath || !inputDir) {
    process.stderr.write("Usage: merge-results.ts --target-branch <branch> --output <path> <workspace-results-dir>\n");
    process.exit(1);
  }

  const files = fs.readdirSync(inputDir).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) {
    process.stderr.write(`No .json files found in ${inputDir}\n`);
    process.exit(1);
  }

  const workspaces: WorkspaceResult[] = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(inputDir, f), "utf-8");
    try {
      workspaces.push(parseWorkspaceResult(f, raw));
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      process.exit(1);
    }
  }

  const dupWorkspaces = workspaces
    .map((w) => w.workspace)
    .filter((name, i, arr) => arr.indexOf(name) !== i);
  if (dupWorkspaces.length > 0) {
    process.stderr.write(
      `Duplicate workspace result(s) found: ${[...new Set(dupWorkspaces)].join(", ")} — ` +
        `each workspace should be written once. Check for stale files from a previous run.\n`,
    );
    process.exit(1);
  }

  const finalWorkspaces = applyUmbrellaRule(workspaces);
  const summary = generateSummary(finalWorkspaces);

  const result: AgentResult = {
    target_branch: targetBranch,
    workspaces: finalWorkspaces,
    summary,
  };

  const validationErrors = validate(result);
  if (validationErrors.length > 0) {
    process.stderr.write("Validation failed:\n");
    for (const e of validationErrors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`Wrote ${outputPath}`);
  console.log(`\n=== E2E Triage Results ===`);
  console.log(summary);
}

main();
