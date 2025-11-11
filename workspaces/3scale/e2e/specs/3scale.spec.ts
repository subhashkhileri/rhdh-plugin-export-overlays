import { test } from "@e2e-test-utils";

test.beforeAll(async ({}) => {
  console.log("parent before all");
});
test.afterAll(async ({}) => {
  console.log("parent after all");
});

test.describe("Tech Plugin", () => {
  test.describe("should load", () => {
    test("should load", async ({ page , rhdh}) => {
      await page.goto("https://www.google.com");
      await rhdh.deploy();
      // console.log("incrementalNumber", await rhdh.getIncrementalNumber());
    });
  });
  test.describe("nested describe", () => {
    test("nested test", async ({ page }) => {
      // await rhdh.deploy();
      // console.log("incrementalNumber", await rhdh.getIncrementalNumber());
    });
  });
});
