import { test } from "@playwright/test";
/**
 * Temporary test placeholder to check if the e2e test framework setup is working
 * TODO: Remove this test once the actual test is implemented
 */

test("Tech Radar e2e test", async ({ page }) => {
  await page.goto("/");
  // login with guest user
  await page.getByRole("button", { name: "Enter" }).click();
  await page.waitForTimeout(10000);
});
