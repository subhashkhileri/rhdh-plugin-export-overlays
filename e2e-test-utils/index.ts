import { RHDHDeployment } from "@e2e-test-utils/rhdh-deployment";
import { test as base } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

type RHDHDeploymentTestFixtures = {
  rhdh: RHDHDeployment;
};

type RHDHDeploymentWorkerFixtures = {
  rhdhDeploymentWorker: RHDHDeployment;
};

// Create the test fixture with worker-scoped bash session (one per spec file)
export const test = base.extend<
  RHDHDeploymentTestFixtures,
  RHDHDeploymentWorkerFixtures
>({
  rhdhDeploymentWorker: [
    async ({}, use, workerInfo) => {
      console.log(
        `Deploying rhdh for plugin ${workerInfo.project.name} in namespace ${workerInfo.project.name}`
      );

      require("dotenv").config({
        path: `workspaces/${workerInfo.project.name}/e2e/.env`,
        override: true,
      });

      const rhdhDeployment = new RHDHDeployment({
        method: "helm",
        version: "1.8",
        namespace: "rhdh",
        configmap: "app-config-rhdh",
        secrets: "rhdh-secrets",
        dynamicPlugins: "dynamic-plugins",
        valueFile: "helm/value_file.yaml",
      });

      try {
        // Run test setup script if it exists
        const testSetupPath = path.resolve(
          process.cwd(),
          `workspaces/${workerInfo.project.name}/e2e/test-setup.ts`
        );
        if (fs.existsSync(testSetupPath)) {
          console.log(`Running test setup script: ${testSetupPath}`);
          const testSetup = await import(testSetupPath);
          if (typeof testSetup.default === "function") {
            await testSetup.default();
          } else if (typeof testSetup.setup === "function") {
            await testSetup.setup();
          }
        }

        await rhdhDeployment.deploy();
        await use(rhdhDeployment);
      } finally {
        console.log(`Deleting namespace ${workerInfo.project.name}`);
        rhdhDeployment.cleanup();
      }
    },
    { scope: "worker", auto: true },
  ],

  // Test-scoped: just passes through the worker's bash session
  // Setting auto: true makes it available in beforeAll/afterAll hooks
  rhdh: [
    async ({ rhdhDeploymentWorker }, use) => {
      await use(rhdhDeploymentWorker);
    },
    { auto: true, scope: "test" },
  ],
});

export { expect } from "@playwright/test";
