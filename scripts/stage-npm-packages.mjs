#!/usr/bin/env node

import { existsSync } from "node:fs";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const expectedPackages = [
  "@ictechgy/relay-darwin-arm64",
  "@ictechgy/relay-darwin-x64",
  "@ictechgy/relay-linux-x64",
  "@ictechgy/relay"
];

function usage() {
  throw new Error(
    "usage: stage-npm-packages.mjs --tarballs <dir> --order <file> --manifest <file> --output <file> [--dry-run]"
  );
}

function hasExactKeys(value, expected) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

async function sha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function readArguments(argv) {
  const result = { dryRun: false };
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) usage();
    result[key.slice(2)] = value;
    index += 1;
  }
  if (!result.tarballs || !result.order || !result.manifest || !result.output) usage();
  return {
    tarballs: resolve(result.tarballs),
    order: resolve(result.order),
    manifest: resolve(result.manifest),
    output: resolve(result.output),
    dryRun: result.dryRun
  };
}

async function stagedInputs(arguments_) {
  const manifest = JSON.parse(await readFile(arguments_.manifest, "utf8"));
  const order = (await readFile(arguments_.order, "utf8")).trim().split("\n").filter(Boolean);
  if (
    !hasExactKeys(manifest, ["version", "packages"]) ||
    typeof manifest.version !== "string" ||
    !Array.isArray(manifest.packages) ||
    manifest.packages.length !== expectedPackages.length
  ) {
    throw new Error("publish manifest must contain exactly four packages");
  }
  if (order.length !== expectedPackages.length || new Set(order).size !== order.length) {
    throw new Error("publish order must contain four unique tarballs");
  }

  const byTarball = new Map(manifest.packages.map((entry) => [entry.tarball, entry]));
  const inputs = await Promise.all(order.map(async (tarball, index) => {
    const entry = byTarball.get(tarball);
    const platformPackage = index < expectedPackages.length - 1;
    const expectedKeys = platformPackage
      ? ["name", "tarball", "version", "sha256", "binarySha256"]
      : ["name", "tarball", "version", "sha256"];
    if (
      !entry ||
      !hasExactKeys(entry, expectedKeys) ||
      entry.name !== expectedPackages[index] ||
      entry.version !== manifest.version ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      (platformPackage && !/^[a-f0-9]{64}$/.test(entry.binarySha256)) ||
      (!platformPackage && Object.hasOwn(entry, "binarySha256"))
    ) {
      throw new Error(`publish order does not match expected package at position ${index + 1}`);
    }
    const path = join(arguments_.tarballs, tarball);
    if (!tarball.endsWith(".tgz") || !existsSync(path)) {
      throw new Error(`missing tarball for ${entry.name}: ${tarball}`);
    }
    if ((await sha256(path)) !== entry.sha256) {
      throw new Error(`tarball checksum mismatch for ${entry.name}: ${tarball}`);
    }
    return {
      package: entry.name,
      tarball,
      version: entry.version,
      sha256: entry.sha256,
      ...(entry.binarySha256 ? { binarySha256: entry.binarySha256 } : {}),
      path
    };
  }));
  if (byTarball.size !== inputs.length || manifest.packages.some((entry) => !order.includes(entry.tarball))) {
    throw new Error("publish manifest and publish order must contain the same tarballs");
  }
  return { version: manifest.version, inputs };
}

function stage(path) {
  const result = spawnSync("npm", ["stage", "publish", path, "--access", "public", "--tag", "next"], {
    encoding: "utf8"
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`npm stage publish failed for ${path}`);
}

async function writeReceipt(output, version, status, stages) {
  await writeFile(
    output,
    `${JSON.stringify({ schemaVersion: 1, version, status, stages }, null, 2)}\n`
  );
}

const arguments_ = readArguments(process.argv);
const { version, inputs } = await stagedInputs(arguments_);
const stages = [];

if (arguments_.dryRun) {
  for (const entry of inputs) {
    stages.push({
      package: entry.package,
      tarball: entry.tarball,
      version: entry.version,
      sha256: entry.sha256,
      ...(entry.binarySha256 ? { binarySha256: entry.binarySha256 } : {}),
      distTag: "next",
      status: "validated"
    });
  }
  await writeReceipt(arguments_.output, version, "validated", stages);
} else {
  await writeReceipt(arguments_.output, version, "staging", stages);
  for (const entry of inputs) {
    stage(entry.path);
    stages.push({
      package: entry.package,
      tarball: entry.tarball,
      version: entry.version,
      sha256: entry.sha256,
      ...(entry.binarySha256 ? { binarySha256: entry.binarySha256 } : {}),
      distTag: "next",
      status: "staged"
    });
    await writeReceipt(arguments_.output, version, "staging", stages);
  }
  await writeReceipt(arguments_.output, version, "staged", stages);
}
