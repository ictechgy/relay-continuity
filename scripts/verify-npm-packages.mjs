#!/usr/bin/env node

import { createReadStream, existsSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedRepository = {
  type: "git",
  url: "git+https://github.com/ictechgy/relay-continuity.git"
};
const packageContracts = [
  {
    directory: "relay-darwin-arm64",
    asset: "relay-macos-arm64",
    os: ["darwin"],
    cpu: ["arm64"],
    files: ["bin/relay"]
  },
  {
    directory: "relay-darwin-x64",
    asset: "relay-macos-x86_64",
    os: ["darwin"],
    cpu: ["x64"],
    files: ["bin/relay"]
  },
  {
    directory: "relay-linux-x64",
    asset: "relay-linux-x86_64",
    os: ["linux"],
    cpu: ["x64"],
    files: ["bin/relay"]
  },
  {
    directory: "relay",
    bin: { relay: "bin/relay.js" },
    files: ["bin/relay.js"]
  }
];
const packageDirectories = packageContracts.map(({ directory }) => directory);
const platformPackageNames = packageContracts
  .filter(({ asset }) => asset)
  .map(({ directory }) => `@ictechgy/${directory}`);
const MAX_PACKED_MANIFEST_BYTES = 1024 * 1024;
const MAX_NATIVE_BINARY_BYTES = 16 * 1024 * 1024;
const forbiddenManifestKeys = ["scripts", "bundleDependencies", "bundledDependencies"];

function usage() {
  throw new Error(
    "usage: verify-npm-packages.mjs --templates | --output <dir> --artifacts <dir>"
  );
}

function argumentsFrom(argv) {
  if (argv.length === 3 && argv[2] === "--templates") return { templates: true };
  const result = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) usage();
    result[key.slice(2)] = resolve(value);
  }
  if (Object.keys(result).sort().join(",") !== "artifacts,output") usage();
  return result;
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

function readTarEntry(path, entry, limit) {
  const result = spawnSync("tar", ["-xOzf", path, entry], {
    encoding: null,
    maxBuffer: limit + 1
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`${path}: unable to read ${entry} from packed package`);
  }
  if (result.stdout.length > limit) throw new Error(`${path}: ${entry} exceeds byte limit`);
  return result.stdout;
}

function readTarManifest(path) {
  return JSON.parse(
    readTarEntry(path, "package/package.json", MAX_PACKED_MANIFEST_BYTES).toString("utf8")
  );
}

async function sha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function boundedNativeSha256(path, source) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_NATIVE_BINARY_BYTES
  ) {
    throw new Error(
      `${source}: native binary must be a regular file no larger than ${MAX_NATIVE_BINARY_BYTES} bytes`
    );
  }
  return sha256(path);
}

async function findFiles(directory, expectedName, matches = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name);
    if (entry.isFile() && entry.name === expectedName) matches.push(candidate);
    if (entry.isDirectory()) await findFiles(candidate, expectedName, matches);
  }
  return matches;
}

async function uniqueArtifact(directory, expectedName) {
  const matches = await findFiles(directory, expectedName);
  if (matches.length !== 1) {
    throw new Error(`${directory}: expected exactly one ${expectedName}, found ${matches.length}`);
  }
  return matches[0];
}

function exactKeys(value, expected, source) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (!isDeepStrictEqual(actual, wanted)) {
    throw new Error(`${source}: expected keys ${wanted.join(", ")}`);
  }
}

function assertManifestContract(manifest, contract, source) {
  assertRepository(manifest, source);
  if (manifest.name !== `@ictechgy/${contract.directory}`) {
    throw new Error(`${source}: package name does not match ${contract.directory}`);
  }
  for (const key of forbiddenManifestKeys) {
    if (Object.hasOwn(manifest, key)) throw new Error(`${source}: forbidden package metadata: ${key}`);
  }
  if (!isDeepStrictEqual(manifest.files, contract.files)) {
    throw new Error(`${source}: files does not match the package contract`);
  }

  if (contract.asset) {
    if (
      !isDeepStrictEqual(manifest.os, contract.os) ||
      !isDeepStrictEqual(manifest.cpu, contract.cpu)
    ) {
      throw new Error(`${source}: os or cpu does not match the platform contract`);
    }
    if (Object.hasOwn(manifest, "bin") || Object.hasOwn(manifest, "optionalDependencies")) {
      throw new Error(`${source}: platform package exposes unexpected wrapper metadata`);
    }
    return;
  }

  if (!isDeepStrictEqual(manifest.bin, contract.bin)) {
    throw new Error(`${source}: bin does not match the wrapper contract`);
  }
  if (Object.hasOwn(manifest, "os") || Object.hasOwn(manifest, "cpu")) {
    throw new Error(`${source}: wrapper must not restrict os or cpu metadata`);
  }
  const dependencies = manifest.optionalDependencies;
  if (
    !dependencies ||
    !isDeepStrictEqual(Object.keys(dependencies).sort(), [...platformPackageNames].sort()) ||
    Object.values(dependencies).some((version) => version !== manifest.version)
  ) {
    throw new Error(`${source}: wrapper optional dependencies must exactly match its version`);
  }
}

function expectedGeneratedManifest(template, version) {
  const expected = JSON.parse(JSON.stringify(template));
  expected.version = version;
  if (expected.optionalDependencies) {
    for (const dependency of Object.keys(expected.optionalDependencies)) {
      expected.optionalDependencies[dependency] = version;
    }
  }
  return expected;
}

async function verifyTemplates() {
  for (const contract of packageContracts) {
    const path = join(root, "packages", contract.directory, "package.json");
    assertManifestContract(await readManifest(path), contract, path);
  }
}

async function verifyOutput(output, artifacts) {
  const packages = join(output, "packages");
  const tarballs = join(output, "tarballs");
  const orderPath = join(output, "publish-order.txt");
  const publishManifestPath = join(output, "publish-manifest.json");
  if (!existsSync(packages) || !existsSync(tarballs) || !existsSync(orderPath) || !existsSync(publishManifestPath)) {
    throw new Error(`${output}: missing packages, tarballs, publish-order.txt, or publish-manifest.json`);
  }

  const order = (await readFile(orderPath, "utf8")).trim().split("\n").filter(Boolean);
  const publishManifest = JSON.parse(await readFile(publishManifestPath, "utf8"));
  exactKeys(publishManifest, ["version", "packages"], publishManifestPath);
  if (order.length !== packageDirectories.length || new Set(order).size !== order.length) {
    throw new Error(`${orderPath}: expected ${packageDirectories.length} package tarballs`);
  }
  if (!Array.isArray(publishManifest.packages) || publishManifest.packages.length !== order.length) {
    throw new Error(`${publishManifestPath}: expected ${order.length} package entries`);
  }

  for (const [index, contract] of packageContracts.entries()) {
    const directory = contract.directory;
    const templatePath = join(root, "packages", directory, "package.json");
    const generatedPath = join(packages, directory, "package.json");
    const template = await readManifest(templatePath);
    const generated = await readManifest(generatedPath);
    const tarball = join(tarballs, order[index]);
    const published = publishManifest.packages[index];
    if (!existsSync(tarball) || basename(tarball) !== order[index]) {
      throw new Error(`${orderPath}: missing tarball ${order[index]}`);
    }
    const packed = readTarManifest(tarball);
    for (const [manifest, source] of [
      [template, templatePath],
      [generated, generatedPath],
      [packed, tarball]
    ]) {
      assertManifestContract(manifest, contract, source);
    }

    const expected = expectedGeneratedManifest(template, generated.version);
    if (!isDeepStrictEqual(generated, expected)) {
      throw new Error(`${generatedPath}: generated manifest diverges from its template`);
    }
    if (!isDeepStrictEqual(packed, expected)) {
      throw new Error(`${tarball}: packed manifest diverges from its template`);
    }

    const platformPackage = Boolean(contract.asset);
    exactKeys(
      published,
      platformPackage
        ? ["name", "tarball", "version", "sha256", "binarySha256"]
        : ["name", "tarball", "version", "sha256"],
      `${publishManifestPath}: entry ${index + 1}`
    );
    if (
      published?.name !== generated.name ||
      published?.tarball !== order[index] ||
      published?.version !== generated.version ||
      published.version !== publishManifest.version ||
      !/^[a-f0-9]{64}$/.test(published?.sha256) ||
      published.sha256 !== await sha256(tarball)
    ) {
      throw new Error(`${publishManifestPath}: entry ${index + 1} does not match ${directory}`);
    }

    if (platformPackage) {
      if (!/^[a-f0-9]{64}$/.test(published.binarySha256)) {
        throw new Error(`${publishManifestPath}: entry ${index + 1} has no native binary digest`);
      }
      const artifact = await uniqueArtifact(artifacts, contract.asset);
      const checksum = await uniqueArtifact(artifacts, `${contract.asset}.sha256`);
      const checksumDigest = (await readFile(checksum, "utf8")).trim().split(/\s+/)[0];
      const artifactDigest = await boundedNativeSha256(artifact, artifact);
      const generatedDigest = await boundedNativeSha256(
        join(packages, directory, "bin", "relay"),
        generatedPath
      );
      const packedBinary = readTarEntry(
        tarball,
        "package/bin/relay",
        MAX_NATIVE_BINARY_BYTES
      );
      const packedDigest = sha256Buffer(packedBinary);
      if (
        !/^[a-f0-9]{64}$/.test(checksumDigest) ||
        checksumDigest !== artifactDigest ||
        published.binarySha256 !== artifactDigest ||
        generatedDigest !== artifactDigest ||
        packedDigest !== artifactDigest
      ) {
        throw new Error(`${tarball}: native binary does not match the verified release artifact`);
      }
    }
  }
}

const arguments_ = argumentsFrom(process.argv);
await verifyTemplates();
if (arguments_.output) await verifyOutput(arguments_.output, arguments_.artifacts);
