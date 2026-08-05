#!/usr/bin/env node

import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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

function runExpectFailure(script, arguments_, expectedMessage) {
  const result = spawnSync(process.execPath, [script, ...arguments_], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status === 0) throw new Error(`${script} unexpectedly succeeded`);
  if (expectedMessage && !`${result.stdout}${result.stderr}`.includes(expectedMessage)) {
    throw new Error(`${script} did not report ${expectedMessage}`);
  }
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function rewritePackedPackage(fixture, output, directory, mutate) {
  const staging = await mkdtemp(join(fixture, "repack-"));
  const source = join(output, "packages", directory);
  const packageCopy = join(staging, directory);
  const destination = join(staging, "tarballs");
  await cp(source, packageCopy, { recursive: true });
  await mkdir(destination);
  await mutate(packageCopy);

  const packed = spawnSync(
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", destination],
    { cwd: packageCopy, encoding: "utf8" }
  );
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout);
  const filename = packed.stdout.trim().split(/\r?\n/).at(-1);
  const tarball = join(output, "tarballs", filename);
  await rename(join(destination, filename), tarball);

  const manifestPath = join(output, "publish-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entry = manifest.packages.find((candidate) => candidate.tarball === filename);
  if (!entry) throw new Error(`missing publish manifest entry for ${filename}`);
  entry.sha256 = await digest(tarball);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function mutateManifest(packageDirectory, mutate) {
  const path = join(packageDirectory, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  mutate(manifest);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function expectPackedMutationRejected(
  fixture,
  baseline,
  artifacts,
  directory,
  name,
  mutate,
  expectedMessage
) {
  const output = join(fixture, `mutated-${name}`);
  await cp(baseline, output, { recursive: true });
  await rewritePackedPackage(fixture, output, directory, mutate);
  runExpectFailure(
    "scripts/verify-npm-packages.mjs",
    ["--output", output, "--artifacts", artifacts],
    expectedMessage
  );
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
  run("scripts/verify-npm-packages.mjs", [
    "--output", output,
    "--artifacts", artifactRoot
  ]);
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
    !staged.stages?.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)) ||
    !staged.stages.slice(0, 3).every((entry) => /^[a-f0-9]{64}$/.test(entry.binarySha256)) ||
    Object.hasOwn(staged.stages.at(-1), "binarySha256") ||
    staged.stages?.map((entry) => entry.package).join(",") !== [
      "@ictechgy/relay-darwin-arm64",
      "@ictechgy/relay-darwin-x64",
      "@ictechgy/relay-linux-x64",
      "@ictechgy/relay"
    ].join(",")
  ) {
    throw new Error("stage manifest does not preserve the required package order");
  }

  await expectPackedMutationRejected(
    fixture,
    output,
    artifactRoot,
    "relay-darwin-arm64",
    "native-binary",
    async (directory) => {
      const path = join(directory, "bin", "relay");
      await writeFile(path, Buffer.concat([await readFile(path), Buffer.from("tampered\n")]));
    },
    "native binary does not match the verified release artifact"
  );

  const unsafeMetadataCases = [
    [
      "relay",
      "postinstall",
      (manifest) => { manifest.scripts = { postinstall: "node install.js" }; },
      "forbidden package metadata: scripts"
    ],
    [
      "relay",
      "bundle-dependencies",
      (manifest) => { manifest.bundleDependencies = []; },
      "forbidden package metadata: bundleDependencies"
    ],
    [
      "relay",
      "bundled-dependencies",
      (manifest) => { manifest.bundledDependencies = []; },
      "forbidden package metadata: bundledDependencies"
    ],
    [
      "relay-darwin-arm64",
      "os",
      (manifest) => { manifest.os = ["linux"]; },
      "os or cpu does not match the platform contract"
    ],
    [
      "relay-darwin-arm64",
      "cpu",
      (manifest) => { manifest.cpu = ["x64"]; },
      "os or cpu does not match the platform contract"
    ],
    [
      "relay",
      "bin",
      (manifest) => { manifest.bin = { relay: "bin/other.js" }; },
      "bin does not match the wrapper contract"
    ]
  ];
  for (const [directory, name, mutation, expectedMessage] of unsafeMetadataCases) {
    await expectPackedMutationRejected(
      fixture,
      output,
      artifactRoot,
      directory,
      name,
      (packageDirectory) => mutateManifest(packageDirectory, mutation),
      expectedMessage
    );
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
  const tamperedManifest = JSON.parse(await readFile(join(output, "publish-manifest.json"), "utf8"));
  tamperedManifest.packages[0].sha256 = "0".repeat(64);
  const tamperedPath = join(fixture, "publish-manifest-tampered.json");
  await writeFile(tamperedPath, `${JSON.stringify(tamperedManifest)}\n`);
  runExpectFailure("scripts/stage-npm-packages.mjs", [
    "--tarballs", join(output, "tarballs"),
    "--order", join(output, "publish-order.txt"),
    "--manifest", tamperedPath,
    "--output", join(fixture, "tampered-stage-manifest.json"),
    "--dry-run"
  ]);
  const missingBinaryManifest = JSON.parse(await readFile(join(output, "publish-manifest.json"), "utf8"));
  delete missingBinaryManifest.packages[0].binarySha256;
  const missingBinaryPath = join(fixture, "publish-manifest-missing-binary.json");
  await writeFile(missingBinaryPath, `${JSON.stringify(missingBinaryManifest)}\n`);
  runExpectFailure("scripts/stage-npm-packages.mjs", [
    "--tarballs", join(output, "tarballs"),
    "--order", join(output, "publish-order.txt"),
    "--manifest", missingBinaryPath,
    "--output", join(fixture, "missing-binary-stage-manifest.json"),
    "--dry-run"
  ]);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
