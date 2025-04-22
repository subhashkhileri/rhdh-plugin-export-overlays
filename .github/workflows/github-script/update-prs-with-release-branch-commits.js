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

  for (const pr of pullRequests) {
    core.info(`Syncing the \`${path}\` file to PR #${pr.number} (${pr.branch})`);
    try {
      const owner = pr.repository ? pr.repository.split('/')[0] : context.repo.owner;
      const repo = pr.repository ? pr.repository.split('/')[1] : context.repo.repo;

      const prFiles = await github.rest.pulls.listFiles({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: pr.number
      });
      if (prFiles.data
        .find(f => f.filename === path)
      ) {
        core.info(`Skipping PR #${pr.number}: \`${path}\` has been modified by the PR`);
        await github.rest.issues.createComment({
          owner,
          repo,
          issue_number: pr.number,
          body: `The file \`${path}\` could not be synced from branch \`${pr.branch}\` into this PR because it was manually modified in this PR.
You will have to updfate it manually to avoid conflicts.`
        });    
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
    } catch(err) {
      core.warning(`Skipping PR #${pr.number} due to error: ${err.message}`);
    }
  }
}
