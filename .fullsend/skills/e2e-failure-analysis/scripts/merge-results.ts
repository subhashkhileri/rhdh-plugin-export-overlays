#!/usr/bin/env node
// merge-results.ts — Combine per-workspace JSON results into agent-result.json
// Usage: node --experimental-strip-types merge-results.ts --target-branch <branch> --output <path> <workspace-results-dir>

import * as fs from "fs";
import * as path from "path";

const FIX_CATEGORIES = ["infra_flake", "test_fix", "product_bug", "environment"] as const;
type FixCategory = (typeof FIX_CATEGORIES)[number];

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

// --- Argument parsing ---
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
  console.error("Usage: merge-results.ts --target-branch <branch> --output <path> <workspace-results-dir>");
  process.exit(1);
}

// --- Read workspace results ---
const files = fs.readdirSync(inputDir).filter((f) => f.endsWith(".json")).sort();
if (files.length === 0) {
  console.error(`No .json files found in ${inputDir}`);
  process.exit(1);
}

const workspaces: WorkspaceResult[] = files.map((f) => {
  const raw = fs.readFileSync(path.join(inputDir, f), "utf-8");
  try {
    return JSON.parse(raw) as WorkspaceResult;
  } catch (e) {
    console.error(`Failed to parse ${f}: ${(e as Error).message}`);
    process.exit(1);
  }
});

const dupWorkspaces = workspaces
  .map((w) => w.workspace)
  .filter((name, i, arr) => arr.indexOf(name) !== i);
if (dupWorkspaces.length > 0) {
  console.error(
    `Duplicate workspace result(s) found: ${[...new Set(dupWorkspaces)].join(", ")} — ` +
      `each workspace should be written once. Check for stale files from a previous run.`,
  );
  process.exit(1);
}

// --- Truncate long text at a line boundary instead of mid-sentence/mid-fence ---
function truncateAtBoundary(str: string, maxLen: number): string {
  const marker = "\n\n_(truncated)_";
  if (str.length <= maxLen) return str;
  const budget = maxLen - marker.length;
  const cut = str.lastIndexOf("\n", budget);
  return str.slice(0, cut > budget * 0.5 ? cut : budget) + marker;
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
// schema. This only checks invariants the schema can't express because they
// span multiple workspace entries.
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
      errors.push(
        `root_cause_slug "${slug}" has mixed fix_category values (${[...categories].join(", ")}) ` +
          `after umbrella merge — dominantCategory() should have unified these`,
      );
    }
  }

  return errors;
}

// --- Main ---
const finalWorkspaces = applyUmbrellaRule(workspaces);
const summary = generateSummary(finalWorkspaces);

const result: AgentResult = {
  target_branch: targetBranch,
  workspaces: finalWorkspaces,
  summary,
};

const validationErrors = validate(result);
if (validationErrors.length > 0) {
  console.error("Validation failed:");
  for (const e of validationErrors) console.error(`  - ${e}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
console.log(`Wrote ${outputPath}`);
console.log(`\n=== E2E Triage Results ===`);
console.log(summary);
