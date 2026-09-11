import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

test.describe("P5A Security & Secret Leakage Prevention", () => {
  test("server authentication module enforces server-only runtime boundary", () => {
    const serverAuthFile = path.join(
      process.cwd(),
      "src",
      "lib",
      "auth",
      "server.ts",
    );
    expect(fs.existsSync(serverAuthFile)).toBe(true);
    const content = fs.readFileSync(serverAuthFile, "utf-8");
    expect(content).toContain('import "server-only";');
  });

  test("client-side components and configs do not reference server secret env vars", () => {
    const clientDirs = [
      path.join(process.cwd(), "src", "components"),
      path.join(process.cwd(), "src", "app", "app"),
      path.join(process.cwd(), "src", "app", "page.tsx"),
      path.join(process.cwd(), "src", "lib", "auth", "context.tsx"),
      path.join(process.cwd(), "src", "lib", "auth", "config.ts"),
      path.join(process.cwd(), "src", "lib", "auth", "types.ts"),
    ];

    function scanFiles(targetPath: string): string[] {
      if (!fs.existsSync(targetPath)) return [];
      const stat = fs.statSync(targetPath);
      if (!stat.isDirectory()) return [targetPath];
      const entries = fs.readdirSync(targetPath);
      return entries.flatMap((entry) => scanFiles(path.join(targetPath, entry)));
    }

    const files = clientDirs.flatMap(scanFiles);
    for (const file of files) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      const content = fs.readFileSync(file, "utf-8");
      expect(content).not.toContain("PRIVY_APP_SECRET");
      expect(content).not.toContain("PRIVY_VERIFICATION_KEY");
      expect(content).not.toContain("PRIVY_SERVER_SECRET");
    }
  });

  test("persisted session and tasks never contain server credentials or auth tokens", () => {
    const persistenceFile = path.join(
      process.cwd(),
      "src",
      "lib",
      "tasks",
      "persistence.ts",
    );
    const content = fs.readFileSync(persistenceFile, "utf-8");
    expect(content).not.toContain("PRIVY_APP_SECRET");
    expect(content).not.toContain("PRIVY_VERIFICATION_KEY");
    expect(content).not.toContain("accessToken");
  });
});
