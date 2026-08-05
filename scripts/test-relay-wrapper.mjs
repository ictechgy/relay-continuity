#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceWrapper = join(root, "packages", "relay", "bin", "relay.js");
const platforms = {
  "darwin-arm64": "@ictechgy/relay-darwin-arm64",
  "darwin-x64": "@ictechgy/relay-darwin-x64",
  "linux-x64": "@ictechgy/relay-linux-x64"
};
const target = `${process.platform}-${process.arch}`;
const packageName = platforms[target];

if (!packageName) {
  process.stdout.write(`Skipped Relay wrapper execution tests on unsupported target ${target}.\n`);
  process.exit(0);
}

function expectStatus(wrapper, argument, expected) {
  const result = spawnSync(process.execPath, [wrapper, argument], {
    cwd: dirname(wrapper),
    encoding: "utf8"
  });
  if (result.error) throw result.error;
  if (result.status !== expected) {
    throw new Error(
      `Relay wrapper exited ${result.status}; expected ${expected} for ${argument}: ${result.stderr || result.stdout}`
    );
  }
}

const fixture = await mkdtemp(join(tmpdir(), "relay-wrapper-test-"));
try {
  const packageRoot = join(fixture, "package");
  const wrapper = join(packageRoot, "bin", "relay.js");
  const binary = join(packageRoot, "node_modules", ...packageName.split("/"), "bin", "relay");
  await mkdir(dirname(wrapper), { recursive: true });
  await mkdir(dirname(binary), { recursive: true });
  await copyFile(sourceWrapper, wrapper);
  await writeFile(join(packageRoot, "package.json"), '{"type":"module"}\n');
  await writeFile(
    binary,
    [
      "#!/usr/bin/env node",
      'if (process.argv[2] === "exit37") process.exit(37);',
      'if (process.argv[2] === "sigterm") {',
      '  process.kill(process.pid, "SIGTERM");',
      "  setInterval(() => {}, 1000);",
      "}",
      "process.exit(0);",
      ""
    ].join("\n")
  );
  await chmod(binary, 0o755);

  expectStatus(wrapper, "success", 0);
  expectStatus(wrapper, "exit37", 37);
  expectStatus(wrapper, "sigterm", 143);
  process.stdout.write(`Verified Relay wrapper exit and signal semantics on ${target}.\n`);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
