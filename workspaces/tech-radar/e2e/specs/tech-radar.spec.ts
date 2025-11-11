import { test, createBashSession } from "./bash-fixture";

// test.afterAll(async ({ bash }) => {
//   await bash('echo $OPENSHIFT_CI')
// })

test.describe("Tech Radar Plugin", () => {
  // const session = createBashSession({ workerIndex: "sdf" });
  test.beforeAll(async ({ bash }) => {
    await bash("export OPENSHIFT_CI=true");
    await bash("ls");
  });
  test.describe("should load", () => {
    test("should load", async ({ page, bash }) => {
      let result = await bash("echo $OPENSHIFT_CI");
      console.log(result);
      await bash('echo "hello"');
      await page.waitForTimeout(1000);
      // await bb('ls')
      await page.goto("https://www.google.com");
    }); 
  });
});
