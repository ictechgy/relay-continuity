#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflow = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");
const ciWorkflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
const codeqlWorkflow = await readFile(resolve(root, ".github/workflows/codeql.yml"), "utf8");
const codeqlConfig = await readFile(resolve(root, ".github/codeql/codeql-config.yml"), "utf8");
const relayMain = await readFile(resolve(root, "src/main.rs"), "utf8");

function jobBlock(source, sourceName, name) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) throw new Error(`${sourceName} workflow has no ${name} job`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function mappingEntries(source, sourceName, header) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === header);
  if (start < 0) throw new Error(`${sourceName} workflow has no ${header.trim()} mapping`);
  const indentation = header.length - header.trimStart().length;
  const entries = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const lineIndentation = line.length - line.trimStart().length;
    if (lineIndentation <= indentation) break;
    entries.push(line);
  }
  return entries;
}

function expectFailure(action, label, expectedMessage) {
  try {
    action();
  } catch (error) {
    if (expectedMessage !== undefined && error.message !== expectedMessage) {
      throw new Error(`${label} failed for the wrong reason: ${error.message}`);
    }
    return;
  }
  throw new Error(`${label} unexpectedly passed`);
}

function declaredJobNeeds(source, sourceName, name) {
  const job = jobBlock(source, sourceName, name);
  const match = job.match(/^    needs:\s*(.+)$/m);
  if (!match) return [];
  const value = match[1].trim();
  const needs = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1).split(",").map((entry) => entry.trim())
    : [value];
  if (needs.some((entry) => !/^[A-Za-z0-9_-]+$/.test(entry))) {
    throw new Error(`${sourceName} workflow ${name} job has an unparsed needs contract`);
  }
  return needs;
}

function transitivelyNeeds(source, sourceName, name, required, visiting = new Set()) {
  if (name === required) return true;
  if (visiting.has(name)) throw new Error(`${sourceName} workflow has a needs cycle at ${name}`);
  const nextVisiting = new Set(visiting).add(name);
  return declaredJobNeeds(source, sourceName, name).some((dependency) =>
    transitivelyNeeds(source, sourceName, dependency, required, nextVisiting)
  );
}

function verifyPinnedNode24(source, sourceName, name) {
  const job = jobBlock(source, sourceName, name);
  const matches = job.match(
    /- uses: actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7\.0\.0\n        with:\n          node-version: '24'\n(?:          registry-url: https:\/\/registry\.npmjs\.org\n)?          package-manager-cache: false/g
  ) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `${sourceName} workflow ${name} job must select Node 24 with the reviewed immutable setup-node pin`
    );
  }
}

function verifyRemoteActionPin(value, location) {
  if (value.startsWith("./")) return;
  if (value.startsWith("docker://")) {
    if (!/^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/.test(value)) {
      throw new Error(`${location} must pin docker actions to an immutable sha256 digest`);
    }
    return;
  }
  const remote = value.match(/^([^@\s]+)@([0-9a-f]{40})$/);
  if (!remote || !remote[1].includes("/")) {
    throw new Error(`${location} must pin every remote action to a full 40-hex commit SHA`);
  }
}

const tagPushCondition = "github.event_name == 'push' && github.ref_type == 'tag'";
const releaseAuthorityConditions = [
  ["archive", tagPushCondition],
  ["npm-packages", tagPushCondition],
  ["npm-publish", `${tagPushCondition} && vars.PUBLISH_NPM == 'true'`]
];

function jobLevelConditions(source, sourceName, name) {
  const job = jobBlock(source, sourceName, name);
  return [...job.matchAll(/^    if:\s*(.*?)\s*$/gm)].map((match) => match[1]);
}

function verifyReleaseAuthorityTriggers(source) {
  const contractConditions = jobLevelConditions(source, "release", "release-contract");
  if (contractConditions.length !== 0) {
    throw new Error("release-contract must run for workflow_dispatch branch validation");
  }

  for (const [name, expected] of releaseAuthorityConditions) {
    const actual = jobLevelConditions(source, "release", name);
    if (actual.length !== 1 || actual[0] !== expected) {
      throw new Error(
        `release workflow ${name} job must have the exact authority guard: ${expected}`
      );
    }
  }
}

function mutateJobBlock(source, sourceName, name, mutate) {
  const original = jobBlock(source, sourceName, name);
  const replacement = mutate(original);
  if (replacement === original) {
    throw new Error(`${sourceName} workflow ${name} mutation fixture was not found`);
  }
  const start = source.indexOf(original);
  return `${source.slice(0, start)}${replacement}${source.slice(start + original.length)}`;
}

function namedStepBlock(source, sourceName, jobName, stepName) {
  const job = jobBlock(source, sourceName, jobName);
  const lines = job.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `      - name: ${stepName}`);
  if (start < 0) {
    throw new Error(`${sourceName} workflow ${jobName} job has no ${stepName} step`);
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^      - /.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function literalRunScript(step, sourceName, stepName) {
  const lines = step.split(/\r?\n/);
  const start = lines.findIndex((line) => line === "        run: |");
  if (start < 0) throw new Error(`${sourceName} workflow ${stepName} step has no literal run script`);
  return lines
    .slice(start + 1)
    .map((line) => {
      if (!line) return "";
      if (!line.startsWith("          ")) {
        throw new Error(`${sourceName} workflow ${stepName} step has an unparsed run script`);
      }
      return line.slice(10);
    })
    .join("\n");
}

function verifyLinuxArtifactInspection(source) {
  const stepName = "Reject dynamic, interpreted, or GLIBC-linked Linux artifacts";
  const step = namedStepBlock(source, "release", "archive", stepName);
  if (!/^        shell: bash$/m.test(step)) {
    throw new Error("Linux artifact inspection must select bash explicitly");
  }
  const script = literalRunScript(step, "release", stepName);
  const meaningfulLines = script.split(/\r?\n/).filter((line) => line.trim());
  if (meaningfulLines[0] !== "set -euo pipefail") {
    throw new Error("Linux artifact inspection must start in strict pipefail mode");
  }
  if (
    !script.includes(
      'for tool in file readelf strings grep; do\n  command -v "$tool" >/dev/null\ndone'
    )
  ) {
    throw new Error("Linux artifact inspection must verify every required tool explicitly");
  }
  if (!script.includes('diagnostics_dir="$(mktemp -d)"')) {
    throw new Error("Linux artifact inspection must use a fresh diagnostics directory");
  }
  if (!script.includes(`trap 'rm -rf -- "$diagnostics_dir"' EXIT`)) {
    throw new Error("Linux artifact inspection must clean its diagnostics directory");
  }

  const expectedInvocations = [
    'file relay-linux-x86_64 > "$diagnostics_dir/file.txt"',
    'readelf -d relay-linux-x86_64 > "$diagnostics_dir/dynamic.txt"',
    'readelf -l relay-linux-x86_64 > "$diagnostics_dir/program-headers.txt"',
    'strings relay-linux-x86_64 > "$diagnostics_dir/strings.txt"'
  ];
  const actualInvocations = meaningfulLines
    .map((line) => line.trim())
    .filter((line) =>
      /(?:^|[^A-Za-z0-9_-])(?:file|readelf|strings)(?:\s+-[dl])?\s+relay-linux-x86_64(?:\s|$)/.test(
        line
      )
    );
  if (JSON.stringify(actualInvocations) !== JSON.stringify(expectedInvocations)) {
    throw new Error(
      "Linux artifact diagnostic tools must run directly and capture output before inspection"
    );
  }

  const rejectPatternContract = `reject_pattern() {
  local pattern="$1"
  local input="$2"
  local violation="$3"
  local status=0
  grep -E "$pattern" "$input" >/dev/null || status=$?
  case "$status" in
    0)
      echo "$violation" >&2
      return 1
      ;;
    1)
      return 0
      ;;
    *)
      echo "Linux artifact inspection failed while reading captured diagnostics" >&2
      return 1
      ;;
  esac
}`;
  if (!script.includes(rejectPatternContract)) {
    throw new Error("Linux artifact negative checks must reject matches and grep errors");
  }

  for (const inspection of [
    `grep -E 'x86-64.*static' "$diagnostics_dir/file.txt" >/dev/null`,
    `reject_pattern '(NEEDED)' "$diagnostics_dir/dynamic.txt" \\\n  "Linux release artifact has a dynamic dependency"`,
    `reject_pattern '(^|[[:space:]])(PT_)?INTERP([[:space:]]|$)' \\\n  "$diagnostics_dir/program-headers.txt" \\\n  "Linux release artifact has an ELF interpreter segment"`,
    `reject_pattern 'GLIBC_[0-9]' "$diagnostics_dir/strings.txt" \\\n  "Linux release artifact retains a GLIBC symbol contract"`
  ]) {
    if (!script.includes(inspection)) {
      throw new Error(`Linux artifact inspection is missing: ${inspection}`);
    }
  }
}

function productionGitStatusArgs(source) {
  const functionMatch = source.match(
    /fn dirty_entries_with_rules\([\s\S]*?\n}\nfn dirty_entries\(/
  );
  if (!functionMatch) {
    throw new Error("production dirty-entry function could not be isolated");
  }
  const functionSource = functionMatch[0];
  const stringLiteral = /"(?:\\.|[^"\\])*"/g;
  const invocationCount = functionSource.match(/\bgit_bytes\s*\(/g)?.length ?? 0;
  const calls = [
    ...functionSource.matchAll(
      /\bgit_bytes\(\s*root\s*,\s*&\[(?<arguments>[\s\S]*?)\]\s*,?\s*\)/g
    )
  ];
  if (calls.length !== invocationCount) {
    throw new Error("production git_bytes arguments must use a literal string slice");
  }
  const statusCalls = calls
    .map(({ groups }) => {
      const rawArguments = groups.arguments;
      if (rawArguments.replace(stringLiteral, "").replace(/[\s,]/g, "") !== "") {
        throw new Error("production git_bytes slice contains a nonliteral argument");
      }
      return [...rawArguments.matchAll(stringLiteral)].map(([literal]) => JSON.parse(literal));
    })
    .filter((args) => args[0] === "status" && args.includes("--porcelain=v1"));

  if (statusCalls.length !== 1) {
    throw new Error(`expected exactly one production porcelain Git status call, found ${statusCalls.length}`);
  }
  return statusCalls[0];
}

function verifyNoFloatingRunnerLabels(source, sourceName) {
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*runs-on:\s*(.*?)\s*(?:#.*)?$/);
    if (!match) continue;
    if (/(?:^|[\s,[{"'])([A-Za-z0-9._-]+-latest)(?=$|[\s,\]}"'])/.test(match[1])) {
      throw new Error(`${sourceName} workflow line ${index + 1} uses a floating runner label`);
    }
  }
}

function verifyReleaseSmokeGitStatusFixture(workflowSource, rustSource) {
  const expected = productionGitStatusArgs(rustSource).join(" ");
  const archiveJob = jobBlock(workflowSource, "release", "archive");
  if ((archiveJob.match(/^\s*'case "\$\*" in'\s*\\\s*$/gm) ?? []).length !== 1) {
    throw new Error("release smoke fake Git fixture must match the complete argument vector");
  }
  const fakeGitCommands = [
    ...archiveJob.matchAll(/^\s*'\s*"([^"]+)"\)\s+.*;;'\s*\\\s*$/gm)
  ].map((match) => match[1]);
  const statusCommands = fakeGitCommands.filter(
    (command) => command === "status" || command.startsWith("status ")
  );

  if (statusCommands.length !== 1 || statusCommands[0] !== expected) {
    throw new Error(
      `release smoke fake Git status fixture must match production exactly: expected ${JSON.stringify(expected)}, found ${JSON.stringify(statusCommands)}`
    );
  }
  return expected;
}

const githubActionPins = new Map([
  ["actions/checkout", { sha: "3d3c42e5aac5ba805825da76410c181273ba90b1", version: "v7.0.1" }],
  ["actions/upload-artifact", { sha: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", version: "v7.0.1" }],
  ["actions/download-artifact", { sha: "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", version: "v8.0.1" }],
  ["actions/setup-node", { sha: "820762786026740c76f36085b0efc47a31fe5020", version: "v7.0.0" }],
  ["github/codeql-action/init", { sha: "5595ccaf912efad79be6eef63a5619ff05969be3", version: "v4.37.6" }],
  ["github/codeql-action/analyze", { sha: "5595ccaf912efad79be6eef63a5619ff05969be3", version: "v4.37.6" }]
]);
const actionCounts = new Map([...githubActionPins.keys()].map((action) => [action, 0]));
const combinedWorkflows = `${ciWorkflow}\n${workflow}\n${codeqlWorkflow}`;

for (const [sourceName, source] of [
  ["ci", ciWorkflow],
  ["release", workflow],
  ["codeql", codeqlWorkflow]
]) {
  verifyNoFloatingRunnerLabels(source, sourceName);
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const uses = line.match(/^\s*(?:-\s*)?uses\s*:\s*(?:"([^"]*)"|'([^']*)'|([^#]*?))(?:\s+#\s*(.*?)\s*)?$/);
    if (!uses) continue;

    const value = (uses[1] ?? uses[2] ?? uses[3]).trim();
    const comment = uses[4]?.trim();
    verifyRemoteActionPin(value, `${sourceName} workflow line ${index + 1}`);
    const action = [...githubActionPins.keys()].find((candidate) => value.startsWith(`${candidate}@`));
    if (!action) continue;

    const approved = githubActionPins.get(action);
    if (value !== `${action}@${approved.sha}` || comment !== approved.version) {
      throw new Error(`${sourceName} workflow line ${index + 1} uses an unapproved ${action} pin`);
    }
    actionCounts.set(action, actionCounts.get(action) + 1);
  }
}
for (const [action, approved] of githubActionPins) {
  const actual = actionCounts.get(action);
  if (actual === 0) {
    throw new Error(`workflows must use approved ${action} at least once`);
  }
  const rawReferences = combinedWorkflows.match(new RegExp(`${action}@`, "g"))?.length ?? 0;
  if (rawReferences !== actual) {
    throw new Error(`workflows contain an unparsed ${action} reference`);
  }
}
verifyPinnedNode24(ciWorkflow, "ci", "test");
verifyPinnedNode24(workflow, "release", "release-contract");
verifyPinnedNode24(workflow, "release", "npm-publish");
verifyRemoteActionPin(`docker://example.invalid/image@sha256:${"a".repeat(64)}`, "fixture");
for (const value of ["docker://example.invalid/image:latest", "docker://example.invalid/image@main"]) {
  try {
    verifyRemoteActionPin(value, "fixture");
    throw new Error(`mutable docker action unexpectedly passed: ${value}`);
  } catch (error) {
    if (error.message.startsWith("mutable docker action unexpectedly passed")) throw error;
  }
}

for (const sourceName of ["ci", "release", "codeql"]) {
  expectFailure(
    () => jobBlock("jobs:\n", sourceName, "missing"),
    `${sourceName} jobBlock source-name regression`,
    `${sourceName} workflow has no missing job`
  );
  expectFailure(
    () => mappingEntries("name: fixture\n", sourceName, "permissions:"),
    `${sourceName} mappingEntries source-name regression`,
    `${sourceName} workflow has no permissions: mapping`
  );
}

verifyReleaseAuthorityTriggers(workflow);
const dispatchBlockedContract = mutateJobBlock(
  workflow,
  "release",
  "release-contract",
  (job) => job.replace("  release-contract:\n", `  release-contract:\n    if: ${tagPushCondition}\n`)
);
expectFailure(
  () => verifyReleaseAuthorityTriggers(dispatchBlockedContract),
  "workflow_dispatch release-contract guard mutation",
  "release-contract must run for workflow_dispatch branch validation"
);
for (const [jobName, condition] of releaseAuthorityConditions) {
  const guard = `    if: ${condition}`;
  const withoutGuard = mutateJobBlock(workflow, "release", jobName, (job) =>
    job.replace(`${guard}\n`, "")
  );
  expectFailure(
    () => verifyReleaseAuthorityTriggers(withoutGuard),
    `${jobName} missing authority guard mutation`,
    `release workflow ${jobName} job must have the exact authority guard: ${condition}`
  );

  const requiredFragments = [
    "github.event_name == 'push' && ",
    " && github.ref_type == 'tag'",
    ...(jobName === "npm-publish" ? [" && vars.PUBLISH_NPM == 'true'"] : [])
  ];
  for (const fragment of requiredFragments) {
    const weakened = mutateJobBlock(workflow, "release", jobName, (job) =>
      job.replace(guard, guard.replace(fragment, ""))
    );
    expectFailure(
      () => verifyReleaseAuthorityTriggers(weakened),
      `${jobName} weakened authority guard mutation: ${fragment}`,
      `release workflow ${jobName} job must have the exact authority guard: ${condition}`
    );
  }
}

verifyLinuxArtifactInspection(workflow);
for (const tool of ["file", "readelf", "strings", "grep"]) {
  const tools = ["file", "readelf", "strings", "grep"].filter((candidate) => candidate !== tool);
  const weakened = workflow.replace(
    "for tool in file readelf strings grep; do",
    `for tool in ${tools.join(" ")}; do`
  );
  if (weakened === workflow) throw new Error("Linux tool availability mutation fixture not found");
  expectFailure(
    () => verifyLinuxArtifactInspection(weakened),
    `missing ${tool} availability check mutation`,
    "Linux artifact inspection must verify every required tool explicitly"
  );
}
for (const invocation of [
  'file relay-linux-x86_64 > "$diagnostics_dir/file.txt"',
  'readelf -d relay-linux-x86_64 > "$diagnostics_dir/dynamic.txt"',
  'readelf -l relay-linux-x86_64 > "$diagnostics_dir/program-headers.txt"',
  'strings relay-linux-x86_64 > "$diagnostics_dir/strings.txt"'
]) {
  const weakened = workflow.replace(invocation, `${invocation} || true`);
  if (weakened === workflow) throw new Error(`Linux diagnostic mutation fixture not found: ${invocation}`);
  expectFailure(
    () => verifyLinuxArtifactInspection(weakened),
    `hidden ${invocation.split(" ")[0]} failure mutation`,
    "Linux artifact diagnostic tools must run directly and capture output before inspection"
  );
}
const withoutPipefail = workflow.replace("set -euo pipefail", "set -eu");
if (withoutPipefail === workflow) throw new Error("Linux pipefail mutation fixture not found");
expectFailure(
  () => verifyLinuxArtifactInspection(withoutPipefail),
  "missing Linux pipefail mutation",
  "Linux artifact inspection must start in strict pipefail mode"
);
const hiddenGrepFailure = workflow.replace(
  'grep -E "$pattern" "$input" >/dev/null || status=$?',
  'grep -E "$pattern" "$input" >/dev/null || status=1'
);
if (hiddenGrepFailure === workflow) throw new Error("Linux grep failure mutation fixture not found");
expectFailure(
  () => verifyLinuxArtifactInspection(hiddenGrepFailure),
  "hidden Linux grep failure mutation",
  "Linux artifact negative checks must reject matches and grep errors"
);
const productionStatusInvocation = verifyReleaseSmokeGitStatusFixture(workflow, relayMain);
const nonliteralStatusMutations = [
  [
    relayMain.replace('"--untracked-files=normal"', "git_status_mode()"),
    "production git_bytes slice contains a nonliteral argument"
  ],
  [
    relayMain.replace(
      '&["status", "--porcelain=v1", "-z", "--untracked-files=normal"]',
      "git_status_args()"
    ),
    "production git_bytes arguments must use a literal string slice"
  ]
];
for (const [mutatedSource, expectedError] of nonliteralStatusMutations) {
  if (mutatedSource === relayMain) {
    throw new Error("production Git status nonliteral mutation fixture not found");
  }
  try {
    productionGitStatusArgs(mutatedSource);
    throw new Error("nonliteral production Git status argument unexpectedly passed");
  } catch (error) {
    if (error.message === "nonliteral production Git status argument unexpectedly passed") throw error;
    if (error.message !== expectedError) {
      throw new Error(
        `nonliteral production Git status mutation failed for the wrong reason: ${error.message}`
      );
    }
  }
}
const driftedWorkflow = workflow.replace(
  productionStatusInvocation,
  `${productionStatusInvocation} --fixture-drift`
);
if (driftedWorkflow === workflow) {
  throw new Error("release smoke Git status mutation fixture not found");
}
try {
  verifyReleaseSmokeGitStatusFixture(driftedWorkflow, relayMain);
  throw new Error("drifted release smoke Git status fixture unexpectedly passed");
} catch (error) {
  if (error.message === "drifted release smoke Git status fixture unexpectedly passed") throw error;
}
if (!/actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7\.0\.0\n        with:\n          node-version: '24'\n          registry-url: https:\/\/registry\.npmjs\.org\n          package-manager-cache: false\n/.test(workflow)) {
  throw new Error("release workflow must disable setup-node package-manager caching explicitly");
}
if ((workflow.match(/skip-decompress: true\n          digest-mismatch: error/g) ?? []).length !== 2) {
  throw new Error("release workflow must bypass deprecated artifact decompression without weakening digest checks");
}
if ((workflow.match(/test ! -L /g) ?? []).length !== 4) {
  throw new Error("release workflow must reject symlinked artifact payloads after extraction");
}

if (
  !/concurrency:\n  group: release-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: false/.test(
    workflow
  )
) {
  throw new Error("release workflow violates non-cancelling per-ref release concurrency");
}
const authoritativeJobClasses = [
  ["archive", "archive", /shasum -a 256[\s\S]*actions\/upload-artifact@/],
  ["attestation", "archive", /actions\/attest@/],
  ["packaging", "npm-packages", /node scripts\/package-npm\.mjs[\s\S]*actions\/upload-artifact@/],
  ["npm staging", "npm-publish", /node scripts\/stage-npm-packages\.mjs/],
  [
    "npm publish",
    "npm-publish",
    /^  npm-publish:\n    if: github\.event_name == 'push' && github\.ref_type == 'tag' && vars\.PUBLISH_NPM == 'true'$/m
  ]
];
for (const [authorityClass, ownerJob, marker] of authoritativeJobClasses) {
  const owner = jobBlock(workflow, "release", ownerJob);
  if (!marker.test(owner)) {
    throw new Error(`release workflow has no recognized ${authorityClass} authority in ${ownerJob}`);
  }
  if (!transitivelyNeeds(workflow, "release", ownerJob, "release-contract")) {
    throw new Error(`${authorityClass} authority must transitively depend on release-contract`);
  }
}
const jobContracts = [
  [
    "release-contract",
    "early release identity contract",
    /  release-contract:\n    runs-on: ubuntu-22\.04\n    timeout-minutes: 5\n    permissions:\n      contents: read\n    outputs:\n      version: \$\{\{ steps\.verify\.outputs\.version \}\}[\s\S]*node scripts\/verify-release-contract\.mjs[\s\S]*--cargo Cargo\.toml[\s\S]*--event-name "\$RELEASE_EVENT_NAME"[\s\S]*--ref-type "\$RELEASE_REF_TYPE"[\s\S]*--ref-name "\$RELEASE_REF_NAME"[\s\S]*--github-output "\$GITHUB_OUTPUT"/
  ],
  [
    "archive",
    "archive attestation authority",
    /  archive:\n    if: github\.event_name == 'push' && github\.ref_type == 'tag'\n    needs: release-contract\n    timeout-minutes: 35\n    permissions:\n      attestations: write\n      contents: read\n      id-token: write\n/
  ],
  [
    "npm-packages",
    "packaging attestation read authority",
    /  npm-packages:\n    if: github\.event_name == 'push' && github\.ref_type == 'tag'\n    needs: \[release-contract, archive\]\n    runs-on: ubuntu-22\.04\n    timeout-minutes: 20\n    permissions:\n      attestations: read\n      contents: read\n    steps:\n/
  ],
  [
    "npm-publish",
    "publish dependency and timeout",
    /  npm-publish:[\s\S]*needs: \[release-contract, npm-packages\]\n    runs-on: ubuntu-22\.04\n    timeout-minutes: 15[\s\S]*archive="npm-packages\/npm-packages\.zip"/
  ],
  [
    "archive",
    "portable Linux target with stable asset name",
    /- os: ubuntu-22\.04\n            asset: linux-x86_64\n            target: x86_64-unknown-linux-musl[\s\S]*cargo build --release --locked --target "\$\{\{ matrix\.target \}\}"[\s\S]*target\/\$\{\{ matrix\.target \}\}\/release\/relay"[\s\S]*file relay-linux-x86_64[\s\S]*--platform linux\/amd64[\s\S]*--network none[\s\S]*--read-only[\s\S]*--cap-drop ALL/
  ],
  [
    "archive",
    "digest-pinned Ubuntu runtime smoke",
    /ubuntu:22\.04@sha256:0199853f6d6b20b0424f3c5694a72a62764f01e6a771b1eb48a4197848986c7e/
  ],
  [
    "archive",
    "digest-pinned Debian runtime smoke",
    /debian:12-slim@sha256:1def178129dfb5f24db43afbf2fcac04530012e3264ba4ff81c71184e17a9ee4/
  ],
  [
    "archive",
    "isolated read-only amd64 runtime smoke",
    /--platform linux\/amd64[\s\S]*--network none[\s\S]*--read-only[\s\S]*--cap-drop ALL[\s\S]*--security-opt no-new-privileges[\s\S]*--user "\$\(id -u\):\$\(id -g\)"[\s\S]*--env RELAY_STATE_HOME=\/smoke\/state[\s\S]*\/opt\/relay --version; \/opt\/relay --help >\/tmp\/help; \/opt\/relay init >\/tmp\/init; \/opt\/relay status >\/tmp\/status/
  ],
  [
    "archive",
    "read-only release artifact mount with disposable writable state",
    /--read-only[\s\S]*--tmpfs \/tmp:rw,noexec,nosuid,size=16m[\s\S]*--mount "type=bind,src=\$PWD\/relay-linux-x86_64,dst=\/opt\/relay,readonly"[\s\S]*--mount "type=bind,src=\$smoke_root,dst=\/smoke"/
  ],
  [
    "npm-packages",
    "contract-authoritative package version",
    /RELEASE_VERSION: \$\{\{ needs\.release-contract\.outputs\.version \}\}[\s\S]*node scripts\/verify-npm-packages\.mjs/
  ],
  [
    "archive",
    "pinned attestation action",
    /actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4\.2\.2/
  ],
  ["npm-packages", "ephemeral GitHub CLI authentication", /GH_TOKEN: \$\{\{ github\.token \}\}/],
  ["npm-packages", "repository provenance binding", /--repo "\$GITHUB_REPOSITORY"/],
  ["npm-packages", "workflow provenance binding", /--signer-workflow "\$SIGNER_WORKFLOW"/],
  ["npm-packages", "source ref binding", /--source-ref "\$GITHUB_REF"/],
  ["npm-packages", "source commit binding", /--source-digest "\$GITHUB_SHA"/],
  ["npm-packages", "hosted runner policy", /--deny-self-hosted-runners/],
  [
    "npm-packages",
    "native payload verification input",
    /node scripts\/verify-npm-packages\.mjs \\\n            --output dist\/npm \\\n            --artifacts release-assets/
  ],
  [
    "npm-packages",
    "verified native artifact extraction",
    /actual_archives="\$\(find release-assets -mindepth 1 -maxdepth 1 -exec basename \{\} \\; \| LC_ALL=C sort\)"\n          test "\$actual_archives" = "\$expected_archives"[\s\S]*expected="\$\(printf 'relay-%s\\nrelay-%s\.sha256\\n' "\$asset" "\$asset" \| LC_ALL=C sort\)"\n            actual="\$\(unzip -Z1 "\$archive" \| LC_ALL=C sort\)"\n            test "\$actual" = "\$expected"\n            unzip -q "\$archive" -d release-assets/
  ],
  [
    "npm-publish",
    "verified npm artifact extraction",
    /archive="npm-packages\/npm-packages\.zip"\n          actual_archives="\$\(find npm-packages -mindepth 1 -maxdepth 1 -exec basename \{\} \\; \| LC_ALL=C sort\)"\n          test "\$actual_archives" = "npm-packages\.zip"[\s\S]*actual="\$\(unzip -Z1 "\$archive" \| LC_ALL=C sort\)"\n          test "\$actual" = "\$expected"\n          unzip -q "\$archive" -d npm-packages/
  ],
  [
    "npm-publish",
    "contract-authoritative publish version",
    /RELEASE_VERSION: \$\{\{ needs\.release-contract\.outputs\.version \}\}\n        run: \|\n          test -n "\$RELEASE_VERSION"/
  ]
];

const jobBlocks = new Map();
for (const [jobName, name, pattern] of jobContracts) {
  if (!jobBlocks.has(jobName)) jobBlocks.set(jobName, jobBlock(workflow, "release", jobName));
  if (!pattern.test(jobBlocks.get(jobName))) throw new Error(`release workflow violates ${name}`);
}
for (const runner of [
  "ubuntu-latest",
  "'macos-latest'",
  '"windows-latest"',
  "[self-hosted, custom-latest]"
]) {
  try {
    verifyNoFloatingRunnerLabels(`jobs:\n  fixture:\n    runs-on: ${runner}\n`, "fixture");
    throw new Error(`floating runner label unexpectedly passed: ${runner}`);
  } catch (error) {
    if (error.message.startsWith("floating runner label unexpectedly passed")) throw error;
  }
}
if ((workflow.match(/@sha256:[0-9a-f]{64}/g) ?? []).length !== 2) {
  throw new Error("release workflow must use exactly two reviewed runtime image digests");
}
if (/\bNPM_TOKEN\b/.test(workflow)) {
  throw new Error("release workflow must not use a long-lived npm token");
}

const codeqlWorkflowPermissions = mappingEntries(codeqlWorkflow, "codeql", "permissions:");
const codeqlAnalyzePermissions = mappingEntries(
  jobBlock(codeqlWorkflow, "codeql", "analyze"),
  "codeql",
  "    permissions:"
);
if (
  JSON.stringify(codeqlWorkflowPermissions) !== JSON.stringify(["  contents: read"]) ||
  JSON.stringify(codeqlAnalyzePermissions) !==
    JSON.stringify(["      contents: read", "      security-events: write"])
) {
  throw new Error("CodeQL workflow must use explicit least-privilege permissions");
}
for (const language of ["actions", "javascript-typescript", "rust"]) {
  if (!new RegExp(`- language: ${language}\\n            build-mode: none`).test(codeqlWorkflow)) {
    throw new Error(`CodeQL workflow must analyze ${language} without a build`);
  }
}
if (
  !/config-file: \.\/\.github\/codeql\/codeql-config\.yml/.test(codeqlWorkflow) ||
  !/category: \/language:\$\{\{ matrix\.language \}\}/.test(codeqlWorkflow)
) {
  throw new Error("CodeQL workflow must bind the reviewed configuration and stable categories");
}
const codeqlConfigContract = codeqlConfig
  .split(/\r?\n/)
  .filter((line) => line.trim() && !line.trimStart().startsWith("#"));
if (
  JSON.stringify(codeqlConfigContract) !==
  JSON.stringify([
    'name: "Relay CodeQL configuration"',
    "paths-ignore:",
    '  - "tests/**"'
  ])
) {
  throw new Error("CodeQL configuration may exclude only the black-box tests directory");
}

process.stdout.write("Verified release and CodeQL workflow authority and provenance contracts.\n");
