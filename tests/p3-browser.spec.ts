import { expect, test } from "@playwright/test";
import { DRAFT_SESSION_STORAGE_KEY } from "../src/lib/tasks/persistence";
import { serviceRegistry } from "../src/lib/services";

test("flagship task discovers bounded wallet-check services without purchase", async ({
  page,
}) => {
  await page.goto("/app");
  await page.evaluate((key) => localStorage.removeItem(key), DRAFT_SESSION_STORAGE_KEY);
  await page.reload();

  const input = page.getByRole("textbox", { name: "Your financial task" });
  await input.fill(
    "Pay this contractor 50 USDC, but check the wallet first. Spend no more than $0.05 checking.",
  );
  await page.getByRole("button", { name: "Submit task" }).click();
  await input.fill("0x1234567890abcdef");
  await page.getByRole("button", { name: "Submit task" }).click();
  const registryResponse = await page.request.get("/api/services");
  const registry = (await registryResponse.json()) as {
    services: Array<{ id: string; status: string; catalogOnly: boolean }>;
  };
  const live = registry.services.find((service) => !service.catalogOnly);

  await expect(page.getByText("validated task plan", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "wallet activity check", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Wallet activity summary", { exact: true }).first(),
  ).toBeVisible();
  if (live?.status === "available") {
    await expect(
      page.getByText("Wallet activity check", { exact: true }).first(),
    ).toBeVisible();
  } else {
    await expect(
      page.getByText("Wallet activity check", { exact: true }),
    ).toHaveCount(0);
  }
  await expect(page.getByText("wallet risk", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("wallet activity", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("$0.003", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("$0.004", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("service budget", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("$0.05", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "review service", exact: true }).first(),
  ).toBeVisible();

  await page.getByRole("button", { name: "review service", exact: true }).first().click();
  const selectedServiceId = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) throw new Error("draft session was not persisted");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !("discovery" in parsed) ||
      typeof parsed.discovery !== "object" ||
      parsed.discovery === null ||
      Array.isArray(parsed.discovery) ||
      !("selectedServiceId" in parsed.discovery) ||
      typeof parsed.discovery.selectedServiceId !== "string"
    ) {
      return undefined;
    }
    return parsed.discovery.selectedServiceId;
  }, DRAFT_SESSION_STORAGE_KEY);
  expect(selectedServiceId).toBe(
    live?.status === "available"
      ? live.id
      : "catalog-wallet-activity",
  );

  const mainText = await page.getByRole("main").innerText();
  expect(mainText).not.toMatch(
    /service purchased|payment submitted|settled|transaction confirmed|risk score|proof is ready|payment ready|completed check/i,
  );
});

test("services page renders the registry source with catalog status", async ({
  page,
}) => {
  await page.goto("/app/services");

  const serviceNames = serviceRegistry
    .listServices({ order: "price" })
    .map((service) => service.name);
  for (const name of serviceNames) {
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  }
  await expect(
    page.getByText(
      /live Hedera testnet service available\.|Hedera testnet service unavailable\.|development catalog only\./,
    ).last(),
  ).toBeVisible();
});
