import { test } from "@e2e-test-utils";
// import { test } from "@playwright/test";
// import { RHDHDeployment } from "@e2e-test-utils/rhdh-deployment";


// let rhdh: RHDHDeployment;

test.beforeAll(async ({ rhdh }, testInfo) => {
  // test.setTimeout(300_000);
  console.log("before all timeout", testInfo.timeout);
  console.log("parent before all 1");
  // await rhdh.deploy();
  console.log("after deploy timeout");

});


test.describe("Tech Plugin", () => {
  test.describe("should load", () => {
    test("should load", async ({ page }, testInfo) => {
      console.log("test timeout", testInfo.timeout);
      await page.goto("https://www.google.com").visible();
      // await rhdh.deploy();
      // console.log("incrementalNumber", await rhdh.getIncrementalNumber());
    });
  });
  test.describe("nested describe", () => {
    test("nested test", async ({ page }, testInfo) => {
      console.log("test timeout", testInfo.timeout);
      // await rhdh.deploy();
      // console.log("incrementalNumber", await rhdh.getIncrementalNumber());
    });
  });
});



// import { test } from "@e2e-test-utils";
// // import { test } from "@playwright/test";
// import { RHDHDeployment } from "@e2e-test-utils/rhdh-deployment";


// let rhdh: RHDHDeployment;
// test.beforeAll(async ({}) => {
//   console.log("parent before all 2");
// });
// test.beforeAll(async ({}) => {
//   console.log("parent before all 1");
//   rhdh = new RHDHDeployment({
    
//     namespace: test.info().project.name,
//   });
//   await rhdh.k8sClient.applyConfigMapFromObject("dynamic-plugins", dynamicPluginsYaml, namespace);
//   await rhdh.deploy();
// });



// test.afterAll(async ({}) => {
//   console.log("parent after all");
// });

// test.beforeEach(async ({}) => {
//   console.log("parent beforeEach");
// });

// test.afterEach(async ({}) => {
//   console.log("parent afterEach");
// });

// test.describe("Tech Plugin", () => {
//   test.describe("should load", () => {
//     test("should load", async ({ page }) => {
//       await page.goto("https://www.google.com");
//       // await rhdh.deploy();
//       // console.log("incrementalNumber", await rhdh.getIncrementalNumber());
//     });
//   });
//   test.describe("nested describe", () => {
//     test("nested test", async ({ page }) => {
//       // await rhdh.deploy();
//       // console.log("incrementalNumber", await rhdh.getIncrementalNumber());
//     });
//   });
// });
