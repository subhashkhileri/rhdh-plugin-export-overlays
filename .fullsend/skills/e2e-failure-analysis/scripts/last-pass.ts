#!/usr/bin/env node
// Find the most recent nightly run in which a given failed test PASSED, within a
// look-back window — to tell a transient flake (passed recently on the same branch
// HEAD → no code change → infra_flake) apart from a real regression (started failing
// after specific commits → inspect the diff).
//
// Reads each build's Playwright results.json (structured status), not log glyphs.
//
// Usage:
//   node --experimental-strip-types last-pass.ts <PROW_OR_GCSWEB_URL> <query...> [--days N]
//
//   <query...>  substrings identifying the test; ALL must appear in
//               "<projectName> <specFile> <specTitle>". Typically the project name
//               plus a slice of the title, e.g.
//                 "rbac-default-permissions" "User should got default permissions"
//   --days N    look-back window (default 7), anchored on the current run's date.

const BUCKET = "test-platform-results";
const GCS = `https://storage.googleapis.com/${BUCKET}`;
const CONTAINER = "redhat-developer-rhdh-plugin-export-overlays-ocp-helm";
const PROW_VIEW = "https://prow.ci.openshift.org/view/gs";

type Status = "pass" | "fail" | "flaky" | "skipped" | "absent" | "nolog";
const MAP: Record<string, Status> = { expected: "pass", unexpected: "fail", flaky: "flaky", skipped: "skipped" };

function parseUrl(url: string) {
  const parts = new URL(url.replace(/\/$/, "")).pathname
    .replace(/^\/view\/gs\//, "").replace(/^\/gcs\//, "").split("/");
  const i = parts.indexOf("logs");
  if (i < 0) return null; // only periodic/nightly jobs carry history
  const job = parts[i + 1];
  // Branch and step name are both derived from the job name — no hardcoded values.
  // Job shape: <prefix>-<branch>-<step>, e.g. ...-overlays-release-1.10-e2e-ocp-helm-nightly
  // or ...-overlays-main-e2e-ocp-helm-nightly. branch ∈ {main, release-x.y};
  // subdir (the artifacts step dir) is whatever follows the branch segment.
  const branch = job.match(/-(release-\d+\.\d+)-/)?.[1] ?? "main";
  const subdir = job.split(`-${branch}-`).pop()!;
  return { job, jobId: parts[i + 2], subdir, branch };
}

async function getJson(url: string): Promise<any | null> {
  const res = await fetch(url);
  return res.ok ? res.json() : null;
}

async function listBuilds(job: string): Promise<string[]> {
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const q = new URLSearchParams({ prefix: `logs/${job}/`, delimiter: "/", maxResults: "1000" });
    if (token) q.set("pageToken", token);
    const data = await getJson(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o?${q}`);
    for (const p of data?.prefixes ?? []) ids.push(p.replace(/\/$/, "").split("/").pop()!);
    token = data?.nextPageToken;
  } while (token);
  return ids.filter((b) => /^\d+$/.test(b)).sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1));
}

async function startedMs(job: string, id: string): Promise<number | null> {
  const j = await getJson(`${GCS}/logs/${job}/${id}/started.json`);
  return typeof j?.timestamp === "number" ? j.timestamp * 1000 : null;
}

function* walk(suite: any): Generator<{ project: string; hay: string; status: string }> {
  for (const sp of suite.specs ?? [])
    for (const t of sp.tests ?? [])
      yield { project: t.projectName ?? "", hay: `${t.projectName ?? ""} ${sp.file ?? ""} ${sp.title ?? ""}`, status: t.status };
  for (const s of suite.suites ?? []) yield* walk(s);
}

async function testStatus(job: string, subdir: string, id: string, query: string[]): Promise<Status> {
  const url = `${GCS}/logs/${job}/${id}/artifacts/${subdir}/${CONTAINER}/artifacts/playwright-report/results.json`;
  const data = await getJson(url);
  if (!data) return "nolog";
  const matches = [...walk({ suites: data.suites ?? [] })].filter((t) => query.every((q) => t.hay.includes(q)));
  if (!matches.length) return "absent";
  if (matches.some((m) => MAP[m.status] === "fail")) return "fail";
  if (matches.some((m) => MAP[m.status] === "flaky")) return "flaky";
  if (matches.some((m) => MAP[m.status] === "pass")) return "pass";
  return "skipped";
}

const fmt = (ms: number | null) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z" : "?");
const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : "<date>");

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const di = argv.indexOf("--days");
  const days = di >= 0 ? Number(argv[di + 1]) : 7;
  const [url, ...query] = argv.filter((a, i) => a !== "--days" && !(di >= 0 && i === di + 1));

  if (!url || !query.length) {
    process.stderr.write('Usage: last-pass.ts <PROW_URL> <query...> [--days N]\n  e.g. <url> "rbac-default-permissions" "User should got default permissions"\n');
    process.exit(1);
  }
  const ref = parseUrl(url);
  if (!ref) {
    process.stderr.write(`ERROR: Not a periodic/nightly (logs/) URL — history unavailable: ${url}\n`);
    process.exit(1);
  }

  process.stderr.write(`Job:    ${ref.job}\nBranch: ${ref.branch}\nQuery:  ${query.map((q) => `"${q}"`).join(" ")}\n\n`);

  const currentMs = await startedMs(ref.job, ref.jobId);
  const cutoff = (currentMs ?? Date.now()) - days * 86_400_000;

  const trail: { id: string; ms: number | null; status: Status }[] = [];
  let lastPass: { id: string; ms: number | null } | null = null;

  for (const id of await listBuilds(ref.job)) {
    const ms = await startedMs(ref.job, id);
    if (ms !== null && ms < cutoff && id !== ref.jobId) break; // outside window
    const status = await testStatus(ref.job, ref.subdir, id, query);
    trail.push({ id, ms, status });
    if ((status === "pass" || status === "flaky") && id !== ref.jobId) { // green (incl. flaky-passed)
      lastPass = { id, ms };
      break;
    }
  }

  const LABEL: Record<Status, string> = { pass: "PASS  ", fail: "FAIL  ", flaky: "FLAKY ", skipped: "skip  ", absent: "absent", nolog: "no-log" };
  process.stdout.write("Run history (newest first, within window):\n");
  for (const r of trail) process.stdout.write(`  ${LABEL[r.status]}  ${fmt(r.ms)}  ${r.id}${r.id === ref.jobId ? "  <-- current" : ""}\n`);
  process.stdout.write("\n");

  if (!lastPass) {
    process.stdout.write(`RESULT: Test did NOT pass in the last ${days} days → not a transient flake.\n  → Likely a real regression, long-standing break, or newly-added/product-bug test.\n  → Widen with --days 14, or check when it was added: git log -S '<test title>' upstream/${ref.branch} -- <spec-file>\n`);
    return;
  }

  const gap = currentMs && lastPass.ms ? ` (~${Math.round((currentMs - lastPass.ms) / 3_600_000)}h before the failing run)` : "";
  process.stdout.write(`RESULT: Last passed in build ${lastPass.id} on ${fmt(lastPass.ms)}${gap}\n  Artifacts (prow): ${PROW_VIEW}/${BUCKET}/logs/${ref.job}/${lastPass.id}\n\n`);
  process.stdout.write(
    `Next: diff branch '${ref.branch}' between the two runs (branch is explicit below):\n` +
      `  git fetch upstream ${ref.branch}\n` +
      `  git log --oneline --since="${iso(lastPass.ms)}" --until="${iso(currentMs)}" upstream/${ref.branch}\n` +
      `  # scoped to the failing workspace:\n` +
      `  git log --oneline --since="${iso(lastPass.ms)}" --until="${iso(currentMs)}" upstream/${ref.branch} -- workspaces/<workspace>/\n\n` +
      "Interpretation:\n" +
      `  - No commits in the window  → same '${ref.branch}' HEAD passed then failed → lean INFRA_FLAKE (rerun).\n` +
      `  - Commits touch the workspace/plugin → inspect them → possible REGRESSION / product change.\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err}\n`);
  process.exit(1);
});
