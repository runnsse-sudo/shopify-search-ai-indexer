/* eslint-env node */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { certifySchemaRetirement } from "../build-tests/schema-retirement.mjs";

const manifestPath = process.argv[2];
if (!manifestPath)
  throw new Error(
    "Usage: npm run certify:autoschema-retirement -- <manifest.json>; offline captured HTML only",
  );
const path = resolve(manifestPath);
const manifest = JSON.parse(await readFile(path, "utf8"));
if (!Array.isArray(manifest.pages))
  throw new Error("Manifest must contain pages[]");
const pages = await Promise.all(
  manifest.pages.map(async (page) => {
    if (
      typeof page.requestedUrl !== "string" ||
      typeof page.htmlFile !== "string" ||
      !Number.isInteger(page.statusCode)
    )
      throw new Error(
        "Each page requires requestedUrl, htmlFile and statusCode",
      );
    return {
      ...page,
      finalUrl: page.finalUrl ?? page.requestedUrl,
      html: await readFile(resolve(dirname(path), page.htmlFile), "utf8"),
    };
  }),
);
const report = certifySchemaRetirement(pages);
console.log(JSON.stringify(report, null, 2));
if (report.decision !== "SAMPLE_PARITY_PASSED") process.exitCode = 1;
