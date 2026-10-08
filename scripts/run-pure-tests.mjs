import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = readdirSync(new URL("../tests/", import.meta.url))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => fileURLToPath(new URL(`../tests/${name}`, import.meta.url)));
if (!files.length) throw new Error("No pure tests discovered");
const env = { ...process.env };
delete env.DATABASE_URL;
console.log(
  `PURE_TEST_FILE_COUNT=${files.length}; INTEGRATION_EXCLUDED=YES; NETWORK_DISABLED=YES`,
);
const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--import",
    new URL("./pure-test-isolation.mjs", import.meta.url).href,
    "--test",
    ...files,
  ],
  { cwd: root, env, stdio: "inherit", shell: false },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
