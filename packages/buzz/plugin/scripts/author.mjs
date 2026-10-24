// Installs the type-only `@buzz/author` preview from a block/buzz-app checkout:
//   npm run author -- ~/buzz-app
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const app = process.argv[2];
if (!app) {
  console.error("usage: npm run author -- <path to a block/buzz-app checkout>");
  process.exit(1);
}
execFileSync("pnpm", ["author:build"], { cwd: resolve(app), stdio: "inherit" });
execFileSync("npm", ["install", "--no-save", "--no-package-lock", resolve(app, "dist-author")], { stdio: "inherit" });
