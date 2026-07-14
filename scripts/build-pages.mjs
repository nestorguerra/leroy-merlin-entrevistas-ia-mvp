import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = join(root, "dist-pages");

await rm(destination, { recursive: true, force: true });
await mkdir(join(destination, "data"), { recursive: true });
await cp(join(root, "public"), destination, { recursive: true });
await Promise.all([
  cp(join(root, "data", "interviewees.json"), join(destination, "data", "interviewees.json")),
  cp(
    join(root, "data", "interviewees.template.json"),
    join(destination, "data", "interviewees.template.json"),
  ),
  writeFile(join(destination, ".nojekyll"), ""),
]);

console.log("Demo de GitHub Pages preparada en dist-pages/.");
