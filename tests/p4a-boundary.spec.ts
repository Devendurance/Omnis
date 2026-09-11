import { expect, test } from "@playwright/test";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { preProcessFile } from "typescript";

const projectRoot = resolve(process.cwd());
const clientRegistryEntry = resolve(
  projectRoot,
  "src/lib/services/index.ts",
);

function resolveLocalImport(
  sourceFile: string,
  specifier: string,
): string | undefined {
  const base = specifier.startsWith("@/")
    ? resolve(projectRoot, "src", specifier.slice(2))
    : resolve(dirname(sourceFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
  ];
  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function collectLocalGraph(entry: string): readonly string[] {
  const pending = [entry];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const sourceFile = pending.pop();
    if (!sourceFile || visited.has(sourceFile)) continue;
    visited.add(sourceFile);
    const source = readFileSync(sourceFile, "utf8");
    for (const imported of preProcessFile(source, true, true).importedFiles) {
      const localFile = resolveLocalImport(sourceFile, imported.fileName);
      if (localFile) pending.push(localFile);
    }
  }
  return [...visited];
}

const runtimeConfigKeys = [
  "HEDERA_TESTNET_PAYER_ACCOUNT_ID",
  "HEDERA_TESTNET_PAYER_PRIVATE_KEY",
  "HEDERA_X402_SERVICE_ACCOUNT_ID",
  "BLOCKY402_TESTNET_URL",
] as const;

test("client service registry graph excludes P4A server modules", () => {
  const files = collectLocalGraph(clientRegistryEntry);
  const forbidden = [
    "@x402/core/server",
    "@x402/hedera",
    "@hiero-ledger/sdk",
    "server-only",
    "process.env",
    "createClientHederaSigner",
    "HTTPFacilitatorClient",
    "Blocky402FacilitatorClient",
    "HEDERA_TESTNET_PAYER_PRIVATE_KEY",
    "OMNIS_P4A_SPIKE_TOKEN",
  ];
  const violations: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const imports = preProcessFile(source, true, true).importedFiles;
    for (const imported of imports) {
      if (forbidden.includes(imported.fileName)) {
        violations.push(`${file}: import ${imported.fileName}`);
      }
    }
    for (const token of forbidden) {
      if (source.includes(token)) violations.push(`${file}: ${token}`);
    }
  }
  expect(violations).toEqual([]);
  expect(files).not.toContain(
    resolve(projectRoot, "src/lib/services/server/runtime-registry.ts"),
  );
  expect(files).not.toContain(
    resolve(projectRoot, "src/lib/services/hedera-x402/resource.ts"),
  );
});

test("P4A module import and missing config perform no remote checks", async () => {
  const requests: string[] = [];
  const previousFetch = globalThis.fetch;
  const previousValues = new Map(
    runtimeConfigKeys.map((key) => [key, process.env[key]]),
  );
  globalThis.fetch = (async (input) => {
    requests.push(String(input));
    throw new Error("remote checks are not allowed during import");
  }) as typeof fetch;
  for (const key of runtimeConfigKeys) delete process.env[key];

  // Dynamic imports are intentional: static imports execute before the fetch spy and cannot prove import-time isolation.
  try {
    const facilitatorModule = await import(
      "../src/lib/services/hedera-x402/facilitator"
    );
    new facilitatorModule.Blocky402FacilitatorClient();
    await import("../src/lib/services/hedera-x402/preflight");
    const resourceModule = await import(
      "../src/lib/services/hedera-x402/resource"
    );
    resourceModule.resetWalletActivityRuntimeForTests();
    await expect(resourceModule.getWalletActivityRuntime()).rejects.toMatchObject({
      code: "P4A_CONFIG_INVALID",
    });
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of runtimeConfigKeys) {
      const value = previousValues.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  expect(requests).toEqual([]);
});
