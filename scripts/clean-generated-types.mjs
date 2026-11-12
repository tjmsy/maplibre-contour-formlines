import { readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const distDirectory = resolve(scriptDirectory, "..", "dist");
const generatedFiles = await readdir(distDirectory, { withFileTypes: true });

await Promise.all(
  generatedFiles
    .filter(
      (entry) => entry.isFile() && /(?:\.test|-jest)\.d\.ts$/.test(entry.name),
    )
    .map((entry) => rm(resolve(distDirectory, entry.name))),
);
