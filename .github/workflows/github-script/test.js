#!/usr/bin/env node
const path = require('path');
const { getOctokit } = require('@actions/github');
const core = require('@actions/core');

const [,, scriptFile, contextJson, token] = process.argv;

(async () => {
    if (!scriptFile || !contextJson) {
    console.error('Usage: node test.js <script-path> \'<context-json>\'');
    process.exit(1);
    }

    process.env['GITHUB_STEP_SUMMARY']=path.resolve(process.cwd(), 'tests', 'summary.html');

    context = JSON.parse(contextJson);
    const github = getOctokit(token);
    github.context = context;
    
    const scriptPath = path.resolve(process.cwd(), scriptFile);
    const script = require(scriptPath);    
    await script({ github, context, core });
})();