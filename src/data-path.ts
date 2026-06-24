import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function readDataFile(name: string): string {
  return readFileSync(join(ROOT, "data", name), "utf8");
}
