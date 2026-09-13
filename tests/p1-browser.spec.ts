import { expect, test } from "@playwright/test";
import { DRAFT_SESSION_STORAGE_KEY } from "../src/lib/tasks/persistence";


test("clarification updates the same draft into a validated plan without execution", async ({
  page,
}) => {
  await page.goto("/app");

  const input = page.getByRole("textbox", { name: "Your financial task" });
  const submit = page.getByRole("button", { name: "Submit task" });
  await input.fill(
    "Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.",
  );
  await submit.click();

  await expect(page.getByText("Who should receive 50 USDC?", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("task draft", { exact: true })).toBeVisible();
  const firstTaskId = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) throw new Error("draft session was not persisted");
    const session = JSON.parse(raw) as { task?: { id?: string } };
    if (!session.task?.id) throw new Error("draft task id is missing");
    return session.task.id;
  }, DRAFT_SESSION_STORAGE_KEY);

  await input.fill("0x1234567890abcdef");
  await submit.click();

  await expect(page.getByText("validated task plan", { exact: true })).toBeVisible();
  await expect(page.getByText("50 USDC", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("0.05 USD", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("human approval required", { exact: true }).last()).toBeVisible();
  const secondTaskId = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) throw new Error("planned session was not persisted");
    const session = JSON.parse(raw) as { task?: { id?: string } };
    if (!session.task?.id) throw new Error("planned task id is missing");
    return session.task.id;
  }, DRAFT_SESSION_STORAGE_KEY);

  expect(secondTaskId).toBe(firstTaskId);
  await page.reload();
  await expect(page.getByText("validated task plan", { exact: true })).toBeVisible();
  // Product contract: a planned, unpaid, unapproved task stays
  // conversationally correctable, so the composer remains enabled.
  await expect(input).toBeEnabled();
  await input.fill("Actually make that 0.20 USDC.");
  await expect(submit).toBeEnabled();
  const reset = page.getByRole("button", { name: "start a new task" });
  await expect(reset).toBeVisible();
  await reset.click();
  await expect(input).toBeEnabled();
  await expect(reset).toHaveCount(0);
  const mainText = await page.getByRole("main").innerText();
  expect(mainText).not.toMatch(
    /service purchased|payment submitted|settled|transaction confirmed|proof is ready/i,
  );
  await expect(page).toHaveURL(/\/app$/);
});

test("reload preserves follow-up payment context", async ({ page }) => {
  await page.goto("/app");
  await page.evaluate((key) => localStorage.removeItem(key), DRAFT_SESSION_STORAGE_KEY);
  await page.reload();

  const input = page.getByRole("textbox", { name: "Your financial task" });
  const submit = page.getByRole("button", { name: "Submit task" });
  await input.fill("Pay to 0x1234567890abcdef.");
  await submit.click();
  await expect(
    page.getByText("What amount should Omnis pay?", { exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  await input.fill("50");
  await submit.click();
  await expect(
    page.getByText(
      "Which supported asset should Omnis use? P1 supports USDC only.",
      { exact: true },
    ),
    ).toBeVisible({ timeout: 10_000 });

  const firstTaskId = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) throw new Error("draft session was not persisted");
    const session = JSON.parse(raw) as { task?: { id?: string } };
    if (!session.task?.id) throw new Error("draft task id is missing");
    return session.task.id;
  }, DRAFT_SESSION_STORAGE_KEY);

  await page.reload();
  await input.fill("USDC");
  await submit.click();
  await expect(page.getByText("validated task plan", { exact: true })).toBeVisible();
  await expect(page.getByText("50 USDC", { exact: true }).last()).toBeVisible();
  const secondTaskId = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) throw new Error("planned session was not persisted");
    const session = JSON.parse(raw) as { task?: { id?: string } };
    if (!session.task?.id) throw new Error("planned task id is missing");
    return session.task.id;
  }, DRAFT_SESSION_STORAGE_KEY);
  expect(secondTaskId).toBe(firstTaskId);
});
