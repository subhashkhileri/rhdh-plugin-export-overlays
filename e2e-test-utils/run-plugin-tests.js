#!/usr/bin/env node
import { execSync } from 'child_process';

const pluginName = process.argv[2];
const extraArgs = process.argv.slice(3).join(' '); // Pass through additional playwright args

if (!pluginName) {
  console.error('Error: Please provide a plugin name');
  process.exit(1);
}

const command = `playwright test --project ${pluginName} ${extraArgs}`;

console.log(`Running: ${command}\n`);

try {
  execSync(command, { stdio: 'inherit' });
} catch (error) {
  process.exit(error.status || 1);
}