#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflow = await readFile(resolve(root, ".github/workflows/release.yml"), "utf8");
const ciWorkflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
const codeqlWorkflow = await readFile(resolve(root, ".github/workflows/codeql.yml"), "utf8");
const codeqlConfig = await readFile(resolve(root, ".github/codeql/codeql-config.yml"), "utf8");
const dirtyGitStatusContract = await readFile(
  resolve(root, "tests/fixtures/dirty-git-status-args.txt"),
  "utf8"
);
if (
  !dirtyGitStatusContract.endsWith("\n") ||
  dirtyGitStatusContract.includes("\r") ||
  dirtyGitStatusContract.slice(0, -1).includes("\n")
) {
  throw new Error("dirty Git status argument contract must be one LF-terminated line");
}
const dirtyGitStatusInvocation = dirtyGitStatusContract.slice(0, -1);

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

function verifyPinnedRustToolchain(source, sourceName, name) {
  const job = jobBlock(source, sourceName, name);
  const matches = job.match(
    /- uses: dtolnay\/rust-toolchain@2c7215f132e9ebf062739d9130488b56d53c060c # 1\.97\.1\n        with:\n          toolchain: 1\.97\.1/g
  ) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `${sourceName} workflow ${name} job must select Rust 1.97.1 with the reviewed immutable rust-toolchain pin`
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

function blockScalarIndentation(source) {
  const match = source.match(
    /^( *)(?:- )?(?:[A-Za-z0-9_.-]+|"(?:\\.|[^"\\])*"|'(?:''|[^'])*'): +[|>](?:[+-]|[1-9]|[+-][1-9]|[1-9][+-])? *$/
  );
  return match?.[1].length;
}

const semanticUsesParser = String.raw`
require "json"
require "yaml"

source = STDIN.read
stream = Psych.parse_stream(source)
raise "workflow must contain exactly one YAML document" unless stream.children.length == 1
document = YAML.safe_load(
  source,
  permitted_classes: [],
  permitted_symbols: [],
  aliases: true
)
uses = []
active = {}
walk = nil
walk = lambda do |node|
  case node
  when Hash
    identity = node.object_id
    raise "recursive YAML alias" if active[identity]
    active[identity] = true
    begin
      node.each do |key, value|
        uses << value if key == "uses"
        walk.call(key)
        walk.call(value)
      end
    ensure
      active.delete(identity)
    end
  when Array
    identity = node.object_id
    raise "recursive YAML alias" if active[identity]
    active[identity] = true
    begin
      node.each { |value| walk.call(value) }
    ensure
      active.delete(identity)
    end
  end
end
walk.call(document)
STDOUT.write(JSON.generate(uses))
`;

function semanticWorkflowUses(source, sourceName) {
  if (Buffer.byteLength(source, "utf8") > 1024 * 1024) {
    throw new Error(`${sourceName} workflow exceeds the YAML verification size limit`);
  }
  const result = spawnSync("ruby", ["--disable-gems", "-EUTF-8:UTF-8", "-e", semanticUsesParser], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      RUBYLIB: "",
      RUBYOPT: ""
    },
    input: source,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 5_000,
    windowsHide: true
  });
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`${sourceName} workflow YAML verification timed out`);
  }
  if (result.error?.code === "ENOBUFS") {
    throw new Error(`${sourceName} workflow YAML verification exceeded its output limit`);
  }
  if (result.error || result.status !== 0) {
    throw new Error(`${sourceName} workflow is not safe, single-document YAML`);
  }
  let uses;
  try {
    uses = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${sourceName} workflow YAML verifier returned an invalid response`);
  }
  if (!Array.isArray(uses) || uses.some((value) => typeof value !== "string")) {
    throw new Error(`${sourceName} workflow has a non-string uses value`);
  }
  return uses;
}

function canonicalWorkflowUses(source, sourceName) {
  const entries = [];
  let blockScalarIndentationLevel;
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (blockScalarIndentationLevel !== undefined) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const indentation = line.length - line.trimStart().length;
      if (indentation > blockScalarIndentationLevel) continue;
      blockScalarIndentationLevel = undefined;
    }

    const uses = line.match(
      /^ *(?:- )?uses: ([^#\s][^#]*?)(?:[ \t]+#[ \t]*(.*?))?[ \t]*$/
    );
    if (uses) {
      entries.push({
        value: uses[1].trim(),
        comment: uses[2]?.trim(),
        location: `${sourceName} workflow line ${index + 1}`
      });
    }
    blockScalarIndentationLevel = blockScalarIndentation(line);
  }
  return entries;
}

function verifiedWorkflowUses(source, sourceName) {
  const entries = canonicalWorkflowUses(source, sourceName);
  const semantic = semanticWorkflowUses(source, sourceName);
  if (
    entries.length !== semantic.length ||
    entries.some(({ value }, index) => value !== semantic[index])
  ) {
    throw new Error(`${sourceName} workflow has a non-canonical or indirect uses mapping`);
  }
  for (const { value, location } of entries) verifyRemoteActionPin(value, location);
  return entries;
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

function verifyNoFloatingRunnerLabels(source, sourceName) {
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*runs-on:\s*(.*?)\s*(?:#.*)?$/);
    if (!match) continue;
    if (/(?:^|[\s,[{"'])([A-Za-z0-9._-]+-latest)(?=$|[\s,\]}"'])/.test(match[1])) {
      throw new Error(`${sourceName} workflow line ${index + 1} uses a floating runner label`);
    }
  }
}

function verifyReleaseSmokeGitStatusFixture(workflowSource, expected) {
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
  ["dtolnay/rust-toolchain", { sha: "2c7215f132e9ebf062739d9130488b56d53c060c", version: "1.97.1" }],
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
  for (const { value, comment, location } of verifiedWorkflowUses(source, sourceName)) {
    const action = [...githubActionPins.keys()].find((candidate) => value.startsWith(`${candidate}@`));
    if (!action) continue;

    const approved = githubActionPins.get(action);
    if (value !== `${action}@${approved.sha}` || comment !== approved.version) {
      throw new Error(`${location} uses an unapproved ${action} pin`);
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
verifyPinnedRustToolchain(workflow, "release", "release-contract");
const releaseContractWithoutRustToolchain = mutateJobBlock(
  workflow,
  "release",
  "release-contract",
  (job) =>
    job.replace(
      "      - uses: dtolnay/rust-toolchain@2c7215f132e9ebf062739d9130488b56d53c060c # 1.97.1\n        with:\n          toolchain: 1.97.1\n",
      ""
    )
);
expectFailure(
  () => verifyPinnedRustToolchain(releaseContractWithoutRustToolchain, "release", "release-contract"),
  "missing release-contract Rust toolchain mutation",
  "release workflow release-contract job must select Rust 1.97.1 with the reviewed immutable rust-toolchain pin"
);
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
    () =>
      verifiedWorkflowUses(
        "jobs:\n  fixture:\n    steps:\n      - { uses: example/unsafe@main }\n",
        sourceName
      ),
    `${sourceName} flow-style uses mutation`,
    `${sourceName} workflow has a non-canonical or indirect uses mapping`
  );
}

expectFailure(
  () =>
    verifiedWorkflowUses(
      "jobs:\n  fixture:\n    steps:\n      - uses: example/unsafe@main\n",
      "fixture"
    ),
  "canonical unpinned uses mutation",
  "fixture workflow line 4 must pin every remote action to a full 40-hex commit SHA"
);
for (const [label, source] of [
  [
    "folded block scalar uses value",
    "jobs:\n  fixture:\n    steps:\n      - uses: >-\n          example/unsafe@main\n"
  ],
  [
    "literal block scalar uses value",
    "jobs:\n  fixture:\n    steps:\n      - uses: |\n          example/unsafe@main\n"
  ],
  [
    "anchored uses value",
    "jobs:\n  fixture:\n    steps:\n      - uses: &unsafe example/unsafe@main\n"
  ],
  [
    "tagged uses value",
    "jobs:\n  fixture:\n    steps:\n      - uses: !!str example/unsafe@main\n"
  ],
  [
    "folded block scalar explicit uses key",
    "jobs:\n  fixture:\n    steps:\n      - ? >-\n          uses\n        : example/unsafe@main\n"
  ],
  [
    "aliased uses mapping key",
    "env:\n  ACTION_KEY: &action_key uses\njobs:\n  fixture:\n    steps:\n      - *action_key: example/unsafe@main\n"
  ],
  [
    "block scalar anchored uses mapping key",
    "env:\n  ACTION_KEY: &action_key |-\n    uses\njobs:\n  fixture:\n    steps:\n      - *action_key: example/unsafe@main\n"
  ],
  [
    "flow-style aliased uses mapping key",
    "env:\n  ACTION_KEY: &action_key uses\njobs:\n  fixture:\n    steps:\n      - { *action_key: example/unsafe@main }\n"
  ],
  [
    "aliased uses value",
    "env:\n  ACTION: &action example/unsafe@main\njobs:\n  fixture:\n    steps:\n      - uses: *action\n"
  ],
  [
    "duplicate uses keys",
    `jobs:\n  fixture:\n    steps:\n      - uses: example/unsafe@main\n        uses: example/other@${"a".repeat(40)}\n`
  ]
]) {
  expectFailure(
    () => verifiedWorkflowUses(source, "fixture"),
    `${label} mutation`,
    "fixture workflow has a non-canonical or indirect uses mapping"
  );
}
for (const [label, line] of [
  ["double-quoted key", '      - "uses": example/unsafe@main'],
  ["long-Unicode-escaped key", '      - "\\U00000075ses": example/unsafe@main'],
  ["single-quoted key", "      - 'uses': example/unsafe@main"],
  ["spaced key separator", "      - uses : example/unsafe@main"]
]) {
  expectFailure(
    () => verifiedWorkflowUses(`jobs:\n  fixture:\n    steps:\n${line}\n`, "fixture"),
    `${label} uses mutation`,
    "fixture workflow has a non-canonical or indirect uses mapping"
  );
}
expectFailure(
  () =>
    verifiedWorkflowUses(
      "jobs:\n  fixture:\n    steps:\n      - ? uses\n        : example/unsafe@main\n",
      "fixture"
    ),
  "explicit key uses mutation",
  "fixture workflow has a non-canonical or indirect uses mapping"
);
expectFailure(
  () =>
    verifiedWorkflowUses(
      'jobs:\n  fixture:\n    steps:\n      - "\\cuses": example/unsafe@main\n',
      "fixture"
    ),
  "invalid YAML escape in a quoted mapping key",
  "fixture workflow is not safe, single-document YAML"
);
expectFailure(
  () =>
    verifiedWorkflowUses(
      [
        "jobs:",
        "  fixture:",
        "    steps:",
        `      - ? "u${"\\"}`,
        '          ses"',
        "        : example/unsafe@main",
        ""
      ].join("\n"),
      "fixture"
    ),
  "multiline quoted explicit uses key",
  "fixture workflow has a non-canonical or indirect uses mapping"
);
expectFailure(
  () =>
    verifiedWorkflowUses(
      "jobs:\n  fixture:\n    steps:\n      - ? |-\n          uses\n        : example/unsafe@main\n",
      "fixture"
    ),
  "block scalar explicit uses key",
  "fixture workflow has a non-canonical or indirect uses mapping"
);
expectFailure(
  () =>
    verifiedWorkflowUses(
      "jobs:\n  fixture:\n    steps:\n      - uses:\n          action: example/unsafe@main\n",
      "fixture"
    ),
  "non-string uses value",
  "fixture workflow has a non-string uses value"
);
expectFailure(
  () =>
    verifiedWorkflowUses(
      `jobs:\n  fixture:\n    steps:\n      - uses: example/safe@${"a".repeat(40)}\n---\njobs: {}\n`,
      "fixture"
    ),
  "multiple YAML documents",
  "fixture workflow is not safe, single-document YAML"
);
expectFailure(
  () => verifiedWorkflowUses("fixture: &fixture\n  - *fixture\n", "fixture"),
  "recursive YAML alias",
  "fixture workflow is not safe, single-document YAML"
);
expectFailure(
  () =>
    verifiedWorkflowUses(
      "jobs:\n  fixture:\n    steps:\n      - {\n          uses: example/unsafe@main\n        }\n",
      "fixture"
    ),
  "multiline flow-style uses mutation",
  "fixture workflow line 5 must pin every remote action to a full 40-hex commit SHA"
);
expectFailure(
  () =>
    verifiedWorkflowUses(
      "jobs:\n  fixture:\n    steps:\n      - { name: Don't, uses: example/unsafe@main }\n",
      "fixture"
    ),
  "plain scalar apostrophe before flow-style uses mutation",
  "fixture workflow has a non-canonical or indirect uses mapping"
);
const nonSemanticUses = verifiedWorkflowUses(
  [
    "# - { uses: example/comment@main }",
    "jobs:",
    "  fixture:",
    "    steps:",
    "      # Don't mistake this comment for uses: example/comment@main",
    '      - name: "a benign',
    '          multiline quoted scalar"',
    '      - name: "uses: example/quoted-scalar@main"',
    "        run: |",
    "          echo 'uses: example/literal@main'",
    "          # uses: example/literal-comment@main",
    "          printf '%s\\n' '*action_key: example/literal-alias@main'",
    "          printf '%s\\n' '- { uses: example/literal-flow@main }'",
    '      - "run": >-',
    "          echo 'uses: example/quoted-run-key@main'",
    "      - uses: ./local-action"
  ].join("\n"),
  "fixture"
);
if (nonSemanticUses.length !== 1 || nonSemanticUses[0].value !== "./local-action") {
  throw new Error("workflow uses parser mistook comments or literal run-script contents for keys");
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
const productionStatusInvocation = verifyReleaseSmokeGitStatusFixture(
  workflow,
  dirtyGitStatusInvocation
);
const driftedWorkflow = workflow.replace(
  productionStatusInvocation,
  `${productionStatusInvocation} --fixture-drift`
);
if (driftedWorkflow === workflow) {
  throw new Error("release smoke Git status mutation fixture not found");
}
expectFailure(
  () => verifyReleaseSmokeGitStatusFixture(driftedWorkflow, dirtyGitStatusInvocation),
  "drifted release smoke Git status fixture",
  `release smoke fake Git status fixture must match production exactly: expected ${JSON.stringify(productionStatusInvocation)}, found ${JSON.stringify([`${productionStatusInvocation} --fixture-drift`])}`
);
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
const npmPackageVersionContract = /      - name: Package npm distribution\n        env:\n          RELEASE_VERSION: \$\{\{ needs\.release-contract\.outputs\.version \}\}\n        run: \|\n          test -n "\$RELEASE_VERSION"\n          node scripts\/package-npm\.mjs --artifacts release-assets --output dist\/npm --version "\$RELEASE_VERSION"/;

function verifyNpmPackageVersionContract(source) {
  const npmPackagesJob = jobBlock(source, "release", "npm-packages");
  if (!npmPackageVersionContract.test(npmPackagesJob)) {
    throw new Error("release workflow violates contract-authoritative package version");
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
verifyNpmPackageVersionContract(workflow);
for (const [label, mutate] of [
  [
    "missing package-npm version argument",
    (job) => job.replace(' --version "$RELEASE_VERSION"', "")
  ],
  [
    "detached package version output",
    (job) =>
      job.replace(
        "RELEASE_VERSION: ${{ needs.release-contract.outputs.version }}",
        "RELEASE_VERSION: ${{ github.ref_name }}"
      )
  ],
  [
    "overridden package version",
    (job) =>
      job.replace(
        '          test -n "$RELEASE_VERSION"\n          node scripts/package-npm.mjs',
        '          test -n "$RELEASE_VERSION"\n          RELEASE_VERSION=0.0.0\n          node scripts/package-npm.mjs'
      )
  ]
]) {
  const weakened = mutateJobBlock(workflow, "release", "npm-packages", mutate);
  expectFailure(
    () => verifyNpmPackageVersionContract(weakened),
    `${label} mutation`,
    "release workflow violates contract-authoritative package version"
  );
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
