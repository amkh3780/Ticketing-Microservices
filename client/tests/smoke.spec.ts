// Simple Playwright smoke test; run with `npx playwright test` from client/
import { test, expect } from "@playwright/test";

test.describe("client smoke", () => {
  test("homepage renders and shows navbar", async ({ page }) => {
    await page.goto(process.env.CLIENT_BASE_URL || "http://localhost:3000/");
    await expect(page.locator("body")).toBeVisible();
    await expect(page.getByRole("link", { name: /sign/i })).toBeVisible();
  });
});
