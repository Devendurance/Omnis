import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const routes = [
  "/",
  "/app",
  "/app/tasks",
  "/app/activity",
  "/app/policies",
  "/app/agents",
  "/app/services",
  "/app/approvals",
  "/app/proof",
  "/app/wallet",
];
const notice =
  "UI preview only. No wallet was connected. No service request or payment was submitted.";
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (
      window as unknown as { __OMNIS_PREVIEW_MODE?: boolean }
    ).__OMNIS_PREVIEW_MODE = true;
  });
});

for (const route of routes) {
  test(`${route}: usable page, truthful content, accessible structure`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page).toHaveTitle(/useOmnis/);
    if (route !== "/") {
      await expect(
        page
          .getByRole("button", { name: "connect wallet", exact: true })
          .first(),
      ).toBeVisible();
      const mainText = await page.getByRole("main").innerText();
      if (route !== "/app/services") {
        expect(mainText).not.toMatch(
          /0x[a-fA-F0-9]{4,}|\$\d|\d+\.\d+\s*USDC|transaction confirmed|task complete\. proof is ready\./i,
        );
      }
    }
    await noOverflow(page);
    const audit = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(audit.violations).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("circular brand lockups use the supplied mark variants and favicon", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.locator(".hero-title .brand-mark-light")).toHaveCount(1);
  await expect(page.locator(".hero-title .brand-mark-light")).toHaveAttribute(
    "src",
    /useomnis-circular-mark-light/,
  );
  await expect(
    page.locator("[data-landing-nav] .brand-mark-light"),
  ).toHaveCount(2);
  await expect(
    page.locator("[data-landing-nav] .brand-mark-light").first(),
  ).toBeVisible();
  await expect(page.locator(".cinematic-footer .brand-mark-light")).toHaveCount(
    2,
  );

  const markRatio = await page
    .locator(".hero-title .brand-mark-light")
    .evaluate((element) => {
      const image = element as HTMLImageElement;
      return image.naturalWidth / image.naturalHeight;
    });
  expect(Math.abs(markRatio - 1)).toBeLessThan(0.03);

  await page.goto("/app");
  await expect(page.locator(".sidebar .brand-mark-ink")).toBeVisible();
  await expect(page.locator(".app-footer .brand-mark-ink")).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await expect(page.locator(".app-header .brand-mark-ink")).toBeVisible();

  const iconLinks = await page
    .locator('link[rel="icon"]')
    .evaluateAll((links) =>
      links.map((link) => (link as HTMLLinkElement).href),
    );
  expect(iconLinks.some((href) => href.includes("/favicon.ico"))).toBe(true);
  expect(iconLinks.some((href) => href.includes("icon.svg"))).toBe(false);

  for (const asset of [
    "/brand/useomnis-circular-mark-light.png",
    "/brand/useomnis-circular-mark-ink.png",
    "/favicon.ico",
    "/apple-icon.png",
  ]) {
    expect((await page.request.get(asset)).ok()).toBe(true);
  }
});

for (const route of [
  "/unknown",
  "/app/unknown",
  "/app/tasks/missing",
  "/app/services/missing",
  "/app/approvals/missing",
  "/app/proof/missing",
]) {
  test(`${route}: unknown records never become fabricated records`, async ({
    page,
  }) => {
    const response = await page.goto(route);
    expect(response?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: "This route ends here." }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /back to/ }).last(),
    ).toBeVisible();
  });
}

test("landing motion uses truthful, pausable ambient media", async ({
  page,
}) => {
  await page.goto("/");
  const videos = page.locator("[data-motion-video] video");
  await expect(videos).toHaveCount(2);
  const mediaContract = await videos.first().evaluate((element) => {
    const video = element as HTMLVideoElement;
    return {
      muted: video.muted,
      loop: video.loop,
      playsInline: video.playsInline,
      tabIndex: video.tabIndex,
      poster: video.getAttribute("poster"),
    };
  });
  expect(mediaContract).toEqual({
    muted: true,
    loop: true,
    playsInline: true,
    tabIndex: -1,
    poster: "/media/omnis-galaxy-poster.webp",
  });

  const toggle = page
    .getByRole("button", { name: "pause ambient motion" })
    .first();
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(
    page.getByRole("button", { name: "play ambient motion" }).first(),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-motion-video]").first()).toHaveAttribute(
    "data-motion-state",
    "poster",
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "play ambient motion" }).first(),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("button", { name: "play ambient motion" })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "pause ambient motion" }).first(),
  ).toHaveAttribute("aria-pressed", "false");
});

test("reduced motion keeps the wordmark and poster static", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("[data-motion-toggle]")).toHaveCount(0);
  await expect(page.locator("[data-fluid-wordmark]")).toHaveCount(0);
  expect(
    await page
      .locator("[data-motion-video] video")
      .first()
      .evaluate((element) => (element as HTMLVideoElement).src),
  ).toBe("");
  await expect(page.getByRole("heading", { name: "useOmnis" })).toBeVisible();
});

test("hero lockup melts from logo through letters and recovers", async ({
  page,
}) => {
  await page.goto("/");
  const lockup = page.locator(".hero-title .brand-lockup");
  const canvas = page.locator(".fluid-wordmark-canvas");
  await expect(page.locator("[data-fluid-wordmark='ready']")).toHaveCount(1);
  const box = await lockup.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;

  const clean = await canvas.screenshot();
  await page.mouse.move(box.x + box.width * 0.16, box.y + box.height * 0.5);
  await expect(canvas).toHaveAttribute("data-fluid-state", "active");
  await page.mouse.move(box.x + box.width * 0.72, box.y + box.height * 0.44);
  await expect(canvas).toHaveAttribute("data-fluid-state", "active");
  await page.waitForTimeout(120);
  const melted = await canvas.screenshot();
  expect(Buffer.compare(clean, melted)).not.toBe(0);
  await page.mouse.move(box.x - 80, box.y - 80);
  await expect(canvas).toHaveAttribute("data-fluid-state", "ready", {
    timeout: 2000,
  });
});

test("desktop landing uses stacked sheets and adaptive fixed navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const landing = page.locator("main.landing");
  const header = page.locator("[data-landing-nav]");
  await expect(landing).toHaveAttribute("data-lenis-state", "ready");
  await expect(landing).toHaveAttribute("data-stack-enabled", "true");
  await expect(landing).toHaveAttribute("data-stack-mode", "sticky");
  await expect(header).toHaveAttribute("data-nav-theme", "cosmic");
  await expect(header).toHaveCSS("position", "fixed");

  await page.evaluate(() => {
    const policy = document.querySelector<HTMLElement>("#policy");
    if (!policy) throw new Error("policy sheet is missing");
    window.scrollTo(0, policy.offsetTop - window.innerHeight / 2);
  });
  await page.waitForTimeout(260);
  const beforePolicy = await page.evaluate(() => {
    const policy = document.querySelector<HTMLElement>("#policy");
    const hero = document.querySelector<HTMLElement>(".hero");
    if (!policy || !hero) throw new Error("landing sheets are missing");
    return {
      heroTop: hero.getBoundingClientRect().top,
      policyTop: policy.getBoundingClientRect().top,
    };
  });
  expect(beforePolicy.heroTop).toBeGreaterThanOrEqual(-1);
  expect(beforePolicy.policyTop).toBeGreaterThan(100);

  await page.evaluate(() => {
    const policy = document.querySelector<HTMLElement>("#policy");
    if (!policy) throw new Error("policy sheet is missing");
    window.scrollTo(0, policy.offsetTop + 24);
  });
  await page.waitForTimeout(420);
  await expect(header).toHaveAttribute("data-nav-theme", "editorial");
  await expect(header).toHaveAttribute("data-active-section", "policy");
  await expect(
    page.locator('[data-nav-target="policy"][aria-current="location"]'),
  ).toHaveCount(2);

  const stackedAtPolicy = await page.evaluate(() => {
    const hero = document.querySelector<HTMLElement>(".hero");
    const policy = document.querySelector<HTMLElement>("#policy");
    if (!hero || !policy) throw new Error("landing sheets are missing");
    return {
      heroTop: hero.getBoundingClientRect().top,
      policyTop: policy.getBoundingClientRect().top,
      policyZ: Number.parseInt(getComputedStyle(policy).zIndex, 10),
      heroZ: Number.parseInt(getComputedStyle(hero).zIndex, 10),
    };
  });
  expect(Math.abs(stackedAtPolicy.heroTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(stackedAtPolicy.policyTop)).toBeLessThanOrEqual(1);
  expect(stackedAtPolicy.policyZ).toBeGreaterThan(stackedAtPolicy.heroZ);

  await page.keyboard.press("Tab");
  await expect(landing).toHaveAttribute("data-stack-enabled", "false");
  await expect(landing).toHaveAttribute("data-stack-mode", "flow");
});

test("footer landing anchors resolve from the absolute bottom", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto("/");
  await expect(page.locator("main.landing")).toHaveAttribute(
    "data-lenis-state",
    "ready",
  );
  for (const section of [
    "policy",
    "services",
    "approval",
    "settlement",
    "proof",
  ]) {
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
    await page.waitForTimeout(720);
    await page
      .locator(`a[data-landing-anchor][href="#${section}"]`)
      .last()
      .click();
    await expect(page).toHaveURL(new RegExp(`#${section}$`));
    const position = await page.locator(`#${section}`).evaluate((element) => ({
      top: element.getBoundingClientRect().top,
      viewport: window.innerHeight,
    }));
    expect(position.top).toBeGreaterThanOrEqual(-2);
    expect(position.top).toBeLessThan(position.viewport * 0.25);
  }
});

test("mobile landing keeps conventional flow while retaining landing smoothing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await expect(page.locator("main.landing")).toHaveAttribute(
    "data-lenis-state",
    "ready",
  );
  await expect(page.locator("main.landing")).toHaveAttribute(
    "data-stack-enabled",
    "false",
  );
  await expect(page.locator("main.landing")).toHaveAttribute(
    "data-stack-mode",
    "flow",
  );
  await expect(page.locator("[data-landing-nav]")).toHaveCSS(
    "position",
    "fixed",
  );
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).scrollBehavior,
    ),
  ).toBe("auto");

  await page.goto("/app");
  expect(
    await page.evaluate(() =>
      document.documentElement.matches(":has(main.landing)"),
    ),
  ).toBe(false);
});

test("composer captures a draft and asks for missing recipient without executing", async ({
  page,
}) => {
  await page.goto("/app");
  await page.evaluate(() => localStorage.clear());
  const input = page.getByRole("textbox", { name: "Your financial task" });
  const submit = page.getByRole("button", { name: "Submit task" });
  await expect(submit).toBeDisabled();
  await page
    .getByRole("button", { name: /Check a wallet before paying/ })
    .click();
  await expect(input).toBeFocused();
  const text = await input.inputValue();
  expect(text).toContain("Spend no more than $0.05 checking.");
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
      mutations.push(request.url());
    }
  });
  await submit.click();
  await expect(
    page.getByText("Who should receive 50 USDC?", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("task draft", { exact: true })).toBeVisible();
  await expect(page.locator(".task-plan-card")).toBeVisible();
  await expect(input).toHaveValue("");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(mutations).toEqual([]);
  await expect(page).toHaveURL(/\/app$/);
});

test("wallet controls consistently explain the preview and return focus", async ({
  page,
}) => {
  await page.goto("/app/wallet");
  const buttons = page.getByRole("button", {
    name: "connect wallet",
    exact: true,
  });
  for (const button of await buttons.all()) {
    await button.click();
    await expect(page.getByRole("dialog")).toContainText(notice);
    const audit = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(audit.violations).toEqual([]);
    await page.getByRole("button", { name: "back to exploring" }).click();
    await expect(button).toBeFocused();
  }
  await expect(
    page.getByText("wallet disconnected", { exact: true }),
  ).toBeVisible();
});

test("search and filters keep registry-backed services explicit", async ({
  page,
}) => {
  await page.goto("/app/services");
  await page
    .getByRole("button", { name: "wallet checks", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "wallet checks", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByText("Wallet risk signal", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("searchbox", { name: "Search services" })
    .fill("wallet activity");
  await expect(
    page.getByText("Wallet activity summary", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Wallet risk signal", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText(
    /development catalog only|Hedera testnet service unavailable|live Hedera testnet service available/,
  );
  await expect(
    page.getByRole("heading", { name: "No services connected yet." }),
  ).toHaveCount(0);
});

test("keyboard skip link and desktop navigation", async ({ page }) => {
  await page.goto("/app");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "skip to content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  const nav = page.getByRole("navigation", {
    name: "Product navigation",
    exact: true,
  });
  await nav.getByRole("link", { name: "policies", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/policies$/);
  await expect(
    nav.getByRole("link", { name: "policies", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});

test("mobile drawer traps focus, closes, and navigates", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/app");
  const trigger = page.getByRole("button", { name: "Open navigation" });
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const dialog = page.getByRole("dialog", { name: "Product navigation" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Close navigation" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByRole("link", { name: "proof", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/proof$/);
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Proof", exact: true }),
  ).toBeVisible();
  await noOverflow(page);
});

for (const width of [320, 375, 600, 1024, 1440]) {
  test(`reflow and navigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const route of routes) {
      await page.goto(route);
      await page.evaluate(() => document.fonts.ready);
      await noOverflow(page);
      await expect(page.locator("h1")).toBeVisible();
    }
  });
}

test("reduced motion, forced colors, zoom and expanded text preserve access", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator(".pin-spacer")).toHaveCount(0);
  await page.getByRole("link", { name: "the proof", exact: true }).click();
  await expect(page.locator("#proof h2")).toBeInViewport();
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.goto("/app");
  await page
    .getByRole("button", { name: "connect wallet", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  // A 720 CSS-pixel viewport models a 1440px display at 200% browser zoom.
  await page.setViewportSize({ width: 720, height: 500 });
  await page.emulateMedia({ forcedColors: "none" });
  await page.goto("/app/approvals");
  await page.addStyleTag({
    content:
      "html { font-size: 200%; } p, h1, h2, button { overflow-wrap: anywhere; }",
  });
  await noOverflow(page);
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeVisible();
});

test("capture review surfaces", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const [route, name] of [
    ["/", "landing"],
    ["/app", "workspace"],
    ["/app/services", "services"],
    ["/app/wallet", "wallet"],
  ]) {
    await page.goto(route);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: `output/playwright/${name}-desktop.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/app");
  await page.screenshot({
    path: "output/playwright/workspace-mobile.png",
    fullPage: true,
  });
  await page.goto("/");
  await page.screenshot({
    path: "output/playwright/landing-mobile.png",
    fullPage: true,
  });
});
