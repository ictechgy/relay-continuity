# Relay

Relay is a local, evidence-first continuity tool for AI-assisted software work.
It records Git snapshots and explicit check outcomes locally, then renders a small
resume card. It does not store source bodies, raw diffs, chats, telemetry, or
raw command output.

> v0.2.0-rc.11 is a prerelease. It is not a transcript recovery tool and
> cannot universally observe an AI tool's quota, internal reasoning, or UI.
> Its Linux binary is statically linked with musl and is verified on Ubuntu
> 22.04 and Debian 12 before publication.

## Trust model

- `FRESH`: the recorded Git snapshot equals the current worktree snapshot.
- `STALE`: a prior assertion is no longer proven against the current snapshot.
- `BROKEN`: the most recent recorded check failed.
- `UNKNOWN`: Relay has no evidence for the claim.

## Quick start

Relay currently supports macOS and Linux. The easiest installation route is a
prebuilt binary selected for your platform by npm:

```sh
npm install --global @ictechgy/relay@next
```

Homebrew users can install the same verified release binary from the official
tap:

```sh
brew install ictechgy/tap/relay
```

Release binaries are currently prereleases without Apple or other platform code
signing. Tagged workflows issue GitHub build-provenance attestations; verify an
asset's attestation and SHA-256 before bypassing any platform warning. For
development or a source install, use Rust 1.97.1 with `rustup`:

```sh
git clone https://github.com/ictechgy/relay-continuity.git
cd relay-continuity
cargo build --release --locked
mkdir -p "$HOME/.local/bin"
install -m 755 target/release/relay "$HOME/.local/bin/relay"
```

Ensure `$HOME/.local/bin` is on your `PATH`, then initialize the current Git
repository you want Relay to observe and inspect the first card:

```sh
relay --version
cd /path/to/your/project
relay init
relay doctor
relay status
relay resume
```

`relay doctor` is a read-only, privacy-bounded setup check. `relay doctor
--json` emits the same fixed diagnostic states as schema version 1 for issue
triage. It does not create, migrate, repair, quarantine, compact, or enable
anything, and it omits repository names, paths, branch names, annotations, and
raw errors.

To enable automatic capture, preview and install the template for your platform
with the commands in [Local capture service](#local-capture-service), then
enable that exact template with your user service manager. To inject the bounded
card automatically in Codex, install and explicitly trust the repository hook:

```sh
relay integration codex plan
relay integration codex install --apply
relay integration codex trust --apply
relay integration status
```

These steps are repository-scoped and reversible. They do not read a chat,
detect a quota limit, start another AI, or upload data. Before using a GitHub
Release binary directly, verify its SHA-256 checksum against the checksum
artifact published for the same tag. npm and Homebrew package only these same
platform-specific release binaries.

## Development

`cargo test` runs the local test suite. The project is local-only by design.
A tag-triggered release runs only when the tag is exactly `v` plus the Cargo
package SemVer. It builds macOS binaries and a statically linked
`x86_64-unknown-linux-musl` binary, plus a SHA-256 checksum and GitHub artifact
attestation for each platform. The Linux artifact is rejected if it retains a
dynamic ELF dependency or GLIBC symbol contract and is executed in pinned
Ubuntu 22.04 and Debian 12 containers before packaging. Before publishing a
public release, verify the workflow artifacts, attestations, and checksums
against the tagged commit.
The checked-in `rust-toolchain.toml` pins release and CI builds to Rust 1.97.1
so a tag is rebuilt with the same compiler version.

`relay init` creates local ignored state. `relay daemon start` watches only the
repository root, debounces bursts for 750 ms, and reconciles Git once per second
so nested changes are captured without recursively registering ignored build
trees. Watcher registration failure falls back to polling. Transient Git or
invalid `.relayignore` state pauses capture and reports a fixed privacy-safe
degradation reason instead of terminating the daemon; capture resumes after
the repository control state is valid again. `relay daemon stop` and
`relay daemon status` manage and inspect that process. Stop is an instance-ID-checked
local request; Relay never sends a signal to a PID from its state file. `relay
status` always says whether generic capture is active and keeps semantic
context explicitly `unknown` without an adapter.

Evidence SQLite is deliberately stored outside the worktree: under
`$XDG_STATE_HOME/relay/<worktree-hash>/` on Linux and
`~/Library/Application Support/relay/<worktree-hash>/` on macOS. This prevents
a hostile repository from redirecting SQLite or its WAL/SHM sidecars by
swapping `.relay`. `.relay` remains the repository-local location for the
bounded resume card, daemon coordination, and opt-in integration state.
`RELAY_STATE_HOME` may select another **absolute**, user-controlled state base.
Existing `.relay/evidence.sqlite*` files are left untouched and are not read or
deleted automatically.

## Platform support

Relay's managed local state is supported on macOS and Linux. Those platforms
use descriptor-relative, no-follow filesystem operations for managed paths.
Windows is intentionally unsupported: Relay fails closed rather than using an
unsafe path-based fallback for evidence, daemon, or provider-integration state.

`relay check <command>` records only a safe command identity and exit code, and
`relay note <text>` writes an explicitly unverified, hashed annotation. The
legacy `relay watch 60` command remains a foreground polling diagnostic, not
the normal automatic-capture path.

For terminal checks, run `relay shell zsh`, `relay shell bash`, or `relay shell
fish` once and add its emitted hook to the matching shell configuration. The
hook pipes command text to `relay record-check-stdin` after commands, avoiding
raw command text in Relay's process arguments and hashing it before it reaches
SQLite. It is opt-in because shell history itself can be sensitive; Relay does
not modify shell profiles automatically.

Core hash/status evidence remains append-only. Path names are more sensitive
and are retained only as bounded recent detail: at most 128 per event and 4096
rows overall. `relay compact` atomically appends a privacy-safe aggregate epoch
and reduces path detail to the most recent 512 rows. `relay explain` shows only
the epoch's event/check counts and summary hash; it never reconstructs source,
diffs, outputs, paths, or annotations. Compaction reuses database pages but does
not promise an immediate reduction in the SQLite file's allocated size.

## Provider capability matrix

| Capability | Relay v0.2 |
| --- | --- |
| Git/filesystem/check evidence | Supported without a provider adapter |
| Codex, Claude, Grok, or other AI chat state | Not captured |
| GUI context injection or quota-end detection | Unsupported |
| Provider adapters | Codex session-start hook only after explicit project trust; Claude/Grok remain capability-gated and generic core remains available |

`relay adapter <provider> <metadata-type>` accepts only a short ASCII metadata
type from `codex`, `claude`, or `grok`, then stores a hash rather than the value.
Malformed or unsupported input is rejected before it can enter the core
database, and adapter metadata cannot write cards or prove an assertion.

Relay carries observable work evidence, not a complete AI thought process.

## Feedback and security reports

Use the GitHub bug and feature-request forms for public feedback about Relay.
Please do not include source code, diffs, terminal output, paths,
chat transcripts, tokens, credentials, customer data, or any other sensitive
work artifact. GitHub Discussions can be enabled later by the repository owner
if a less structured public channel is useful.

Potential vulnerabilities must use [private vulnerability reporting](SECURITY.md#reporting-a-vulnerability), never a public issue.

## Automatic session-start integration (v0.2)

Relay has two separate opt-ins. They are one-time setup operations, not skills
that an agent must remember to invoke on every session:

1. A repository-scoped user service keeps local Git evidence current.
2. A trusted provider hook asks Relay for one bounded resume card at a main
   session start or resume.

Both operations are previewable, use an explicit `--apply`, and are
deliberately scoped to the current Git root. Relay never starts another AI,
reads a chat transcript, detects quotas, opens a browser, uploads evidence, or
changes account settings.

### Local capture service

On macOS, preview then install the root-specific `launchd` template:

```sh
relay integration service plan launchd
relay integration service install launchd --apply
```

On Linux, use `systemd --user` instead:

```sh
relay integration service plan systemd
relay integration service install systemd --apply
```

Installation writes only a new Relay-owned template under the invoking user's
service directory. Enable that template once with the platform's service
manager; Relay intentionally does not enable a background process without that
separate user action. `relay integration service status <manager>` detects a
missing or modified template, and `uninstall <manager> --apply` removes only a
byte-identical Relay template. `relay daemon stop` is an instance-ID-checked controlled
stop; the templates restart only after unsuccessful exits.

### Codex

The Codex adapter is the supported automatic injection path. It installs a
fully Relay-owned project `.codex/hooks.json` only when that file does not
already exist:

```sh
relay integration codex plan
relay integration codex install --apply
# In Codex, review and trust the exact project hook with /hooks.
relay integration codex trust --apply
```

The hook is `SessionStart` only and matches `startup` and `resume`,
and caps model-visible added context at 320 whitespace-delimited words and
4096 UTF-8 bytes. It never registers a
`SubagentStart` hook. Hook stdin is bounded and validated in memory; no session
id, prompt, transcript path, or hook payload is retained. If `.codex/hooks.json`
is present but not byte-identical to Relay's dedicated file, Relay refuses to
alter it. If its owned file later drifts, status becomes `drifted` and uninstall
refuses to remove it.

### Claude and Grok

Relay probes model-visible provider contracts before enabling them. No
authenticated, repository-scoped Claude hook contract has yet been proven to
deliver Relay's bounded output to the model, and Grok's passive `SessionStart`
hook does not make stdout model-visible. Relay therefore keeps both adapters
`unavailable` instead of equating local hook execution with successful context
injection. Provider login state alone does not change this contract. The
generic evidence core and `relay resume` continue to work without either
adapter.

Use `relay integration status` to inspect `disabled`, `awaiting_trust`,
`ready`, `unavailable`, `drifted`, or `broken`. These states are local,
hash-based control records; they are not a claim that Relay can transfer a
provider's hidden session or take over after a quota limit.
