// @ts-check
/** @param {import('@actions/github-script').AsyncFunctionArguments} AsyncFunctionArguments */
module.exports = async ({github, context, core}) => {
  const releaseBranch = core.getInput('release_branch');
  const singlePR = core.getInput('pr');
  const path = 'versions.json';

  /** @type { Array<{ number: number, branch: String, repository?: String}> } */
  const pullRequests = [];
  if (singlePR !== '') {
      const prNumber = parseInt(singlePR);
      if (Number.isNaN(prNumber)) {
        core.setFailed(`PR workflow parameter is not a valid number: ${singlePR}`);
        return;
      }
      const response = await github.rest.pulls.get({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: prNumber,
      });
      if (response.data.base.ref !== releaseBranch) {
        core.setFailed(`PR #${singlePR} is not based on release branch ${releaseBranch}`);
        return;
      }
      pullRequests.push({
        number: response.data.number,
        branch: response.data.head.ref,
        repository: response.data.head.repo?.full_name
      });
  } else {
      /** @type {import('@octokit/types').GetResponseTypeFromEndpointMethod<typeof github.rest.pulls.list>} */
      let response; 
      do {
          response = await github.rest.pulls.list({
            owner: context.repo.owner,
            repo: context.repo.repo,
            state: 'open',
            base: releaseBranch,
            per_page: 100,
          });
          pullRequests.push(...response.data.map(pr => ({
            number: pr.number,
            branch: pr.head.ref,
            repository: pr.head.repo?.full_name
          })));
      } while (response.data.length > 0);
  }

  const { data: sourceFile } = await github.rest.repos.getContent({
    owner: context.repo.owner,
    repo: context.repo.repo,
    path,
    ref: releaseBranch,
  });
  if (!('type' in sourceFile) || sourceFile.type !== 'file') {
    core.setFailed(`\`${path}\` is not a file on branch \`${releaseBranch}\``);
    return;
  }

  const sourceContent = Buffer.from(
    sourceFile.content,
    (Buffer.isEncoding(sourceFile.encoding) ? sourceFile.encoding : 'utf-8')
  ).toString('utf-8');
  const sourceSha = sourceFile.sha;

  /** @type { Array<number> } */
  const updatedPullRequests = [];
  /** @type { Array<number> } */
  const skippedPullRequests = [];
  /** @type { Array<number> } */
  const conflictingPullRequests = [];
  /** @type { Array<number> } */
  const failedPullRequests = [];
  for (const pr of pullRequests) {
    core.info(`Syncing the \`${path}\` file to PR #${pr.number} (${pr.branch})`);
    try {
      const owner = pr.repository ? pr.repository.split('/')[0] : context.repo.owner;
      const repo = pr.repository ? pr.repository.split('/')[1] : context.repo.repo;

      const prFiles = (await github.rest.pulls.listCommits({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: pr.number
      })).data.filter(c => c.commit.author?.name !== 'github-actions[bot]')
      .flatMap(c => c.files ?? []);

      if (prFiles.find(f => f.filename === path)) {
        core.info(`Skipping PR #${pr.number}: \`${path}\` has been manually modified in the PR`);
        await github.rest.issues.createComment({
          owner,
          repo,
          issue_number: pr.number,
          body: `The file \`${path}\` could not be synced from branch \`${pr.branch}\` into this PR because it was manually modified in this PR.
You will have to update it manually to avoid conflicts.`
        });
        conflictingPullRequests.push(pr.number);
        continue;
      }
  
      const { data: targetFile } = await github.rest.repos.getContent({
        owner,
        repo: pr.repository ? pr.repository.split('/')[1] : context.repo.repo,
        path,
        ref: pr.branch,
      });
      if (!('type' in targetFile) || targetFile.type !== 'file') {
        core.warning(`\`${path}\` is not a file on branch ${pr.branch}`);
        continue;
      }    
      const targetContent = Buffer.from(
        targetFile.content,
        (Buffer.isEncoding(targetFile.encoding) ? targetFile.encoding : 'utf-8')
      ).toString('utf-8');
      const targetSha = targetFile.sha;

      if (sourceContent === targetContent) {
        core.info(`Skipping PR #${pr.number}: \`${path}\` already up-to-date`);
        skippedPullRequests.push(pr.number);
        continue;
      }
    
      await github.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message: `chore: sync \`${path}\` from ${pr.branch}`,
        content: Buffer.from(sourceContent).toString('base64'),
        sha: targetSha,
        branch: pr.branch,
      });

      core.info(`\`${path}\` updated in PR #${pr.number}`);
      updatedPullRequests.push(pr.number);
    } catch(err) {
      core.warning(`Skipping PR #${pr.number} due to error: ${err.message}`);
      failedPullRequests.push(pr.number);
    }
  }
  core.summary
    .addHeading(`${updatedPullRequests.length} PRs updated:`, 4)
    .addList(updatedPullRequests.map(pr => pr.toString()))
    .addHeading(`${skippedPullRequests.length} PRs already up-to-date:`, 4)
    .addList(skippedPullRequests.map(pr => pr.toString()))
    .addHeading(`${conflictingPullRequests.length} PRs not updated to keep manual changes:`, 4)
    .addList(conflictingPullRequests.map(pr => pr.toString()))
    .addHeading(`${failedPullRequests.length} PRs not updated due to failure:`, 4)
    .addList(failedPullRequests.map(pr => pr.toString()))
    .write();
}
