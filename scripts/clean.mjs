import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

await Promise.all([
  rm(resolve(root, "build"), { recursive: true, force: true }),
  rm(resolve(root, "coverage"), { recursive: true, force: true })
]);
