import { test as base } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';

// Bash executor type
type BashExecutor = (command: string) => Promise<string>;

// Worker-scoped fixtures (one bash session per spec file in a worker)
type BashWorkerFixtures = {
  bashSession: BashExecutor;
};

// Test-scoped fixtures (just passes through the worker fixture)
type BashTestFixtures = {
  bash: BashExecutor;
};

// Create a bash session instance
export function createBashSession(identifier: string): {
  executor: BashExecutor;
  cleanup: () => void;
} {
  const bashProcess = spawn('bash', { stdio: ['pipe', 'pipe', 'pipe'] });
  let isCleanedUp = false;

  const executor: BashExecutor = async (command: string): Promise<string> => {
    if (isCleanedUp) {
      throw new Error('Bash session has been cleaned up');
    }

    return new Promise((resolve, reject) => {
      let output = '';
      let error = '';
      const marker = `__PLAYWRIGHT_BASH_EXIT_${Date.now()}__`;

      const onStdout = (data: Buffer) => {
        const text = data.toString();
        if (text.includes(marker)) {
          cleanup();
          
          const codeMatch = text.match(new RegExp(`${marker}=(\\d+)`));
          const exitCode = codeMatch ? Number(codeMatch[1]) : 0;

          if (exitCode === 0) {
            console.log('✅ Output:', error.trim() || output.trim());
            resolve(error.trim() || output.trim());
          } else {
            console.log('❌ Output:', error.trim() || output.trim() || 'Command failed');
            reject(new Error(error.trim() || output.trim() || 'Command failed'));
          }
        } else {
          output += text;
        }
      };

      const onStderr = (data: Buffer) => {
        error += data.toString();
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        bashProcess.stdout.off('data', onStdout);
        bashProcess.stderr.off('data', onStderr);
        bashProcess.off('error', onError);
      };

      bashProcess.stdout.on('data', onStdout);
      bashProcess.stderr.on('data', onStderr);
      bashProcess.on('error', onError);

      // Execute command and echo exit code with unique marker
      bashProcess.stdin.write(`${command}\necho "${marker}=$?"\n`);
    });
  };

  const cleanup = () => {
    if (isCleanedUp) return;
    
    isCleanedUp = true;
    try {
      bashProcess.stdin.end();
      bashProcess.kill('SIGTERM');
      
      // Force kill after timeout
      setTimeout(() => {
        if (!bashProcess.killed) {
          bashProcess.kill('SIGKILL');
        }
      }, 1000);
    } catch (err) {
      console.error(`Error cleaning up bash session [${identifier}]:`, err);
    }
  };

  return { executor, cleanup };
}

// Create the test fixture with worker-scoped bash session (one per spec file)
export const test = base.extend<BashTestFixtures, BashWorkerFixtures>({
  // Worker-scoped: one bash session per spec file
  bashSession: [
    async ({}, use, workerInfo) => {
      const identifier = `worker-${workerInfo.workerIndex}`;
      console.log(`🐚 Creating bash session for worker ${workerInfo.workerIndex}`);
      
      const session = createBashSession(identifier);

      try {
        await use(session.executor);
      } finally {
        console.log(`🧹 Cleaning up bash session for worker ${workerInfo.workerIndex}`);
        session.cleanup();
      }
    },
    { scope: 'worker', auto: true }
  ],

  // Test-scoped: just passes through the worker's bash session
  // Setting auto: true makes it available in beforeAll/afterAll hooks
  bash: [
    async ({ bashSession }, use) => {
      await use(bashSession);
    },
    { auto: true , scope: 'test'}
  ],
});

export { expect } from '@playwright/test';