#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const version = "0.2.0-test.0";
const artifacts = ["relay-linux-x86_64", "relay-macos-x86_64", "relay-macos-arm64"];

function run(script, arguments_) {
  const result = spawnSync(process.execPath, [script, ...arguments_], {
    cwd: root,
    encoding: "utf8"
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`${script} failed`);
}

const fixture = await mkdtemp(join(tmpdir(), "relay-npm-package-test-"));
try {
  const artifactRoot = join(fixture, "artifacts");
  for (const name of artifacts) {
    const directory = join(artifactRoot, name);
    const contents = Buffer.from(`relay fixture ${name}\n`);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), contents, { mode: 0o755 });
    await writeFile(
      join(directory, `${name}.sha256`),
      `${createHash("sha256").update(contents).digest("hex")}  ${name}\n`
    );
  }
  const output = join(fixture, "dist", "npm");
  run("scripts/package-npm.mjs", ["--artifacts", artifactRoot, "--output", output, "--version", version]);
  run("scripts/verify-npm-packages.mjs", ["--output", output]);
  const receipt = join(fixture, "npm-stage-manifest.json");
  run("scripts/stage-npm-packages.mjs", [
    "--tarballs", join(output, "tarballs"),
    "--order", join(output, "publish-order.txt"),
    "--manifest", join(output, "publish-manifest.json"),
    "--output", receipt,
    "--dry-run"
  ]);
  const staged = JSON.parse(await readFile(receipt, "utf8"));
  if (
    staged.status !== "validated" ||
    staged.stages?.map((entry) => entry.package).join(",") !== [
      "@ictechgy/relay-darwin-arm64",
      "@ictechgy/relay-darwin-x64",
      "@ictechgy/relay-linux-x64",
      "@ictechgy/relay"
    ].join(",")
  ) {
    throw new Error("stage manifest does not preserve the required package order");
  }
  const divergedManifest = JSON.parse(await readFile(join(output, "publish-manifest.json"), "utf8"));
  divergedManifest.packages.reverse();
  const divergedPath = join(fixture, "publish-manifest-diverged.json");
  await writeFile(divergedPath, `${JSON.stringify(divergedManifest)}\n`);
  const divergedReceipt = join(fixture, "diverged-stage-manifest.json");
  run("scripts/stage-npm-packages.mjs", [
    "--tarballs", join(output, "tarballs"),
    "--order", join(output, "publish-order.txt"),
    "--manifest", divergedPath,
    "--output", divergedReceipt,
    "--dry-run"
  ]);
  const diverged = JSON.parse(await readFile(divergedReceipt, "utf8"));
  if (diverged.stages?.map((entry) => entry.package).join(",") !== staged.stages.map((entry) => entry.package).join(",")) {
    throw new Error("stage manifest must use publish-order.txt instead of publish-manifest.json order");
  }
} finally {
  await rm(fixture, { recursive: true, force: true });
}
