#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const platformPrefix = "@ictechgy/relay-";
const wrapper = "@ictechgy/relay";

function usage() {
  throw new Error("usage: stage-npm-packages.mjs --tarballs <dir> --manifest <file> --output <file>");
}

function readArguments(argv) {
  const result = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) usage();
    result[key.slice(2)] = value;
  }
  if (!result.tarballs || !result.manifest || !result.output) usage();
  return {
    tarballs: resolve(result.tarballs),
    manifest: resolve(result.manifest),
    output: resolve(result.output)
  };
}

function findStageId(value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findStageId(entry);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const key of ["stageId", "stage_id", "id"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key];
  }
  for (const nested of Object.values(value)) {
    const found = findStageId(nested);
    if (found) return found;
  }
  return undefined;
}

function validateManifest(manifest, tarballs) {
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== 4) {
    throw new Error("publish manifest must contain exactly four packages");
  }
  const names = manifest.packages.map((entry) => entry.name);
  if (
    names.slice(0, 3).some((name) => typeof name !== "string" || !name.startsWith(platformPrefix)) ||
    names[3] !== wrapper
  ) {
    throw new Error("publish manifest must stage three platform packages before the wrapper");
  }
  for (const entry of manifest.packages) {
    if (typeof entry.tarball !== "string" || !entry.tarball.endsWith(".tgz")) {
      throw new Error(`invalid tarball for ${entry.name}`);
    }
    if (!existsSync(join(tarballs, entry.tarball))) {
      throw new Error(`missing tarball for ${entry.name}: ${entry.tarball}`);
    }
  }
}

function stage(tarball) {
  const result = spawnSync(
    "npm",
    ["stage", "publish", tarball, "--access", "public", "--tag", "next", "--json"],
    { encoding: "utf8" }
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`npm stage publish failed for ${tarball}`);
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm stage publish did not return JSON for ${tarball}`);
  }
  const stageId = findStageId(payload);
  if (!stageId) throw new Error(`npm stage publish did not return a stage ID for ${tarball}`);
  return stageId;
}

const arguments_ = readArguments(process.argv);
const manifest = JSON.parse(await readFile(arguments_.manifest, "utf8"));
validateManifest(manifest, arguments_.tarballs);

const stages = manifest.packages.map((entry) => ({
  package: entry.name,
  tarball: entry.tarball,
  version: entry.version,
  distTag: "next",
  stageId: stage(join(arguments_.tarballs, entry.tarball))
}));

await writeFile(
  arguments_.output,
  `${JSON.stringify({ schemaVersion: 1, version: manifest.version, stages }, null, 2)}\n`
);
