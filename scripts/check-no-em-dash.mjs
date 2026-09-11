import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const emDash = String.fromCodePoint(0x2014);
const textExtensions = new Set([
  ".css",
  ".json",
  ".js",
  ".mjs",
  ".md",
  ".mdx",
  ".ts",
  ".tsx",
  ".txt",
]);
const roots = ["DESIGN.md", "README.md", "src", "docs", ".agent-state"];
const offenders = [];

function visit(relativePath) {
  const absolutePath = path.join(root, relativePath);
  const stats = fs.statSync(absolutePath);
  if (stats.isDirectory()) {
    for (const entry of fs.readdirSync(absolutePath)) {
      visit(path.join(relativePath, entry));
    }
    return;
  }
  if (!textExtensions.has(path.extname(relativePath).toLowerCase())) return;
  const contents = fs.readFileSync(absolutePath, "utf8");
  if (contents.includes(emDash)) offenders.push(relativePath);
}

for (const relativePath of roots) visit(relativePath);

if (offenders.length > 0) {
  console.error(`Em dash found in: ${offenders.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("No em dashes found in authored project files.");
}
