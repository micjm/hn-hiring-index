import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HTML, methodology } from "./serve.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs");
const data = JSON.parse(await fs.readFile(path.join(ROOT, "data/index.json"), "utf8"));

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(path.join(OUT, "methodology"), { recursive: true });
await Promise.all([
  fs.writeFile(path.join(OUT, "index.html"), HTML),
  fs.writeFile(path.join(OUT, "methodology/index.html"), methodology(data)),
  fs.writeFile(path.join(OUT, ".nojekyll"), ""),
  fs.cp(path.join(ROOT, "data"), path.join(OUT, "data"), { recursive: true }),
  fs.cp(path.join(ROOT, "plots"), path.join(OUT, "plots"), { recursive: true }),
]);

console.log("Static site built in docs/");
