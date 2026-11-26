import { expect, test } from "./fixtures";
import { gotoApp } from "./helpers";

test("the embedded page cannot approve a provider launch", async ({ page, backend }) => {
  test.setTimeout(90_000);
  await gotoApp(page, backend.bootBase);
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-nav-autonomy").click();
  const panel = page.getByTestId("owner-trust-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("owner-trust-no-process")).toContainText("No external AI process");
  await expect(page.getByTestId("owner-trust-code")).toContainText("application-identity-unestablished");
  await page.getByTestId("owner-trust-review").click();
  await expect(page.getByTestId("owner-trust-reason")).toContainText("embedded page cannot approve");
  const refused = await page.evaluate(async () => {
    const injected = (window as unknown as { __AGETOR?: { port: string; token: string } }).__AGETOR;
    const params = new URLSearchParams((location.hash || location.search).replace(/^[#?]/, ""));
    const port = injected?.port ?? params.get("api") ?? "";
    const token = injected?.token ?? params.get("token") ?? "";
    const response = await fetch(`http://127.0.0.1:${port}/api/owner-trust/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ approved: true, challengeId: "forged" }),
    });
    return response.status;
  });
  expect(refused).toBe(400);
});
