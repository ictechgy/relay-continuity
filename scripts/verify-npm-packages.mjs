#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedRepository = {
  type: "git",
  url: "git+https://github.com/ictechgy/relay-continuity.git"
};
const packageDirectories = [
  "relay-darwin-arm64",
  "relay-darwin-x64",
  "relay-linux-x64",
  "relay"
];

function usage() {
  throw new Error("usage: verify-npm-packages.mjs --templates | --output <dir>");
}

function argumentsFrom(argv) {
  if (argv.length === 3 && argv[2] === "--templates") return { templates: true };
  if (argv.length === 4 && argv[2] === "--output") return { output: resolve(argv[3]) };
  usage();
}

function assertRepository(manifest, source) {
  if (
    manifest.repository?.type !== expectedRepository.type ||
    manifest.repository?.url !== expectedRepository.url
  ) {
    throw new Error(`${source}: repository must equal ${expectedRepository.url}`);
  }
}

async function readManifest(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function readTarManifest(path) {
  const result = spawnSync("tar", ["-xOzf", path, "package/package.json"], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`${path}: unable to read packed package.json: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

async function verifyTemplates() {
  for (const directory of packageDirectories) {
    const path = join(root, "packages", directory, "package.json");
    assertRepository(await readManifest(path), path);
  }
}

async function verifyOutput(output) {
  const packages = join(output, "packages");
  const tarballs = join(output, "tarballs");
  const orderPath = join(output, "publish-order.txt");
  const publishManifestPath = join(output, "publish-manifest.json");
  if (!existsSync(packages) || !existsSync(tarballs) || !existsSync(orderPath) || !existsSync(publishManifestPath)) {
    throw new Error(`${output}: missing packages, tarballs, publish-order.txt, or publish-manifest.json`);
  }

  const order = (await readFile(orderPath, "utf8")).trim().split("\n").filter(Boolean);
  const publishManifest = JSON.parse(await readFile(publishManifestPath, "utf8"));
  if (order.length !== packageDirectories.length) {
    throw new Error(`${orderPath}: expected ${packageDirectories.length} package tarballs`);
  }
  if (!Array.isArray(publishManifest.packages) || publishManifest.packages.length !== order.length) {
    throw new Error(`${publishManifestPath}: expected ${order.length} package entries`);
  }

  for (const [index, directory] of packageDirectories.entries()) {
    const template = await readManifest(join(root, "packages", directory, "package.json"));
    const generated = await readManifest(join(packages, directory, "package.json"));
    const tarball = join(tarballs, order[index]);
    const published = publishManifest.packages[index];
    if (!existsSync(tarball) || basename(tarball) !== order[index]) {
      throw new Error(`${orderPath}: missing tarball ${order[index]}`);
    }
    const packed = readTarManifest(tarball);
    for (const [manifest, source] of [
      [template, join(root, "packages", directory, "package.json")],
      [generated, join(packages, directory, "package.json")],
      [packed, tarball]
    ]) {
      assertRepository(manifest, source);
      if (manifest.name !== template.name) throw new Error(`${source}: package name does not match ${directory}`);
    }
    if (packed.version !== generated.version) throw new Error(`${tarball}: version does not match generated manifest`);
    if (
      published?.name !== generated.name ||
      published?.tarball !== order[index] ||
      published?.version !== generated.version
    ) {
      throw new Error(`${publishManifestPath}: entry ${index + 1} does not match ${directory}`);
    }
  }
}

const arguments_ = argumentsFrom(process.argv);
await verifyTemplates();
if (arguments_.output) await verifyOutput(arguments_.output);
