#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflow = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");

const contracts = [
  [
    "archive attestation authority",
    /  archive:\n    permissions:\n      attestations: write\n      contents: read\n      id-token: write\n/
  ],
  [
    "packaging attestation read authority",
    /  npm-packages:\n    needs: archive\n    runs-on: ubuntu-latest\n    permissions:\n      attestations: read\n      contents: read\n    steps:\n/
  ],
  [
    "pinned attestation action",
    /actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4\.2\.2/
  ],
  ["ephemeral GitHub CLI authentication", /GH_TOKEN: \$\{\{ github\.token \}\}/],
  ["repository provenance binding", /--repo "\$GITHUB_REPOSITORY"/],
  ["workflow provenance binding", /--signer-workflow "\$SIGNER_WORKFLOW"/],
  ["source ref binding", /--source-ref "\$GITHUB_REF"/],
  ["source commit binding", /--source-digest "\$GITHUB_SHA"/],
  ["hosted runner policy", /--deny-self-hosted-runners/],
  [
    "native payload verification input",
    /node scripts\/verify-npm-packages\.mjs \\\n            --output dist\/npm \\\n            --artifacts release-assets/
  ]
];

for (const [name, pattern] of contracts) {
  if (!pattern.test(workflow)) throw new Error(`release workflow violates ${name}`);
}
if (/\bNPM_TOKEN\b/.test(workflow)) {
  throw new Error("release workflow must not use a long-lived npm token");
}

process.stdout.write("Verified release workflow authority and provenance contracts.\n");
