/**
 * UI audit: joins each pass's report.json into one report.json at the top of
 * the output folder, with a short count per pass, so the artifact has one file
 * to read first. A pass that did not run is listed as missing.
 *
 * Usage: node e2e/ui-audit/merge-reports.mjs <output folder>
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const outDir = process.argv[2] ?? "ui-audit-output";
const passes = ["main", "billing"];
const merged = { generatedAt: new Date().toISOString(), passes: {}, pictures: [] };

for (const pass of passes) {
  const file = path.join(outDir, pass, "report.json");
  if (!existsSync(file)) {
    merged.passes[pass] = { missing: true };
    continue;
  }
  const report = JSON.parse(readFileSync(file, "utf8"));
  const pictures = report.pictures ?? [];
  merged.passes[pass] = {
    pictures: pictures.filter((p) => p.file).length,
    failedStates: pictures.filter((p) => p.error).length,
    widerThanViewport: pictures.filter((p) => p.widerThanViewport).length,
    withConsoleErrors: pictures.filter((p) => (p.consoleErrors ?? []).length > 0).length,
    withPageErrors: pictures.filter((p) => (p.pageErrors ?? []).length > 0).length,
  };
  for (const picture of pictures) {
    const inPass = (name) => (name ? `${pass}/${name}` : name);
    merged.pictures.push({
      pass,
      ...picture,
      file: inPass(picture.file) ?? null,
      ...(picture.topFile ? { topFile: inPass(picture.topFile) } : {}),
      ...(picture.errorPicture ? { errorPicture: inPass(picture.errorPicture) } : {}),
    });
  }
}

writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(merged, null, 2)}\n`);
console.log(JSON.stringify(merged.passes, null, 2));
