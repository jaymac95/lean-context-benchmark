# lean-context-benchmark

Independent A/B benchmark harness for [`jaymac95/lean-context`](https://github.com/jaymac95/lean-context).

The benchmark answers one question:

> When the same coding agent performs the same task on the same repository snapshot, does Lean Context reduce real token usage without reducing task success?

## What it measures

Each benchmark runs two isolated variants:

- **baseline** — Lean Context's managed block and generated Lean Context files are removed from a temporary Git worktree.
- **lean** — Lean Context is initialized in another temporary worktree with `--chat`.

For every run it records:

- provider and pinned model
- input tokens
- cached input tokens
- output tokens
- total tokens
- provider-reported cost when available
- agent wall-clock time
- verification/test result
- changed-file count and diff stat

Runs alternate baseline/lean order to reduce order and warm-cache bias.

## Why this is separate from `lean-context report`

`lean-context report` is useful for describing the local context footprint and attaching provider usage to a run. This repository is an experimental harness: it creates matched control/treatment environments, repeats tasks, captures real provider output, verifies task success, and aggregates the result.

## Requirements

- Node.js 20+
- Git
- `npx`
- at least one supported coding-agent CLI:
  - Codex CLI (`codex`)
  - Claude Code CLI (`claude`)
- the provider must already be authenticated locally

No API keys are stored by this project.

## Setup

```bash
git clone https://github.com/jaymac95/lean-context-benchmark.git
cd lean-context-benchmark
```

Edit `benchmark.config.json`:

```json
{
  "targetRepo": "../your-real-project",
  "leanContextSource": "github:jaymac95/lean-context",
  "runs": 5,
  "providers": {
    "codex": {
      "command": "codex",
      "model": "PIN_EXACT_MODEL_ID_HERE",
      "extraArgs": []
    },
    "claude": {
      "command": "claude",
      "model": "PIN_EXACT_MODEL_ID_HERE",
      "extraArgs": []
    }
  }
}
```

Then check your machine:

```bash
node ./bin/lean-context-benchmark.js doctor
```

## Create benchmark tasks

Each task is a JSON file:

```json
{
  "id": "fix-auth-regression",
  "description": "Representative bug-fix task",
  "prompt": "Fix the failing auth behavior described in issue X. Make the smallest correct change and run the relevant tests.",
  "verifyCommand": "npm test -- auth",
  "timeoutMs": 900000
}
```

Use tasks that require repository navigation. Lean Context is designed to reduce unnecessary context discovery, so a benchmark made entirely of trivial one-file prompts will not measure its intended effect well.

## Run Codex benchmark

```bash
node ./bin/lean-context-benchmark.js run \
  --provider=codex \
  --task=tasks/fix-auth-regression.json \
  --runs=5
```

The harness executes Codex non-interactively with JSONL output and extracts usage from `turn.completed` events.

## Run Claude benchmark

```bash
node ./bin/lean-context-benchmark.js run \
  --provider=claude \
  --task=tasks/fix-auth-regression.json \
  --runs=5
```

The harness executes Claude Code in print mode with JSON output and extracts its returned usage/cost metadata.

## Compare

```bash
node ./bin/lean-context-benchmark.js compare
```

Example report shape:

```text
Metric                 Baseline      Lean Context      Savings
Mean input tokens      31,420        18,930            39.8%
Mean total tokens      34,002        21,104            37.9%
Pass rate              100%          100%              —
```

Do not publish a token-saving percentage if the Lean Context variant has a materially lower pass rate.

## Recommended benchmark protocol

1. Pin an exact target-repository commit.
2. Pin an exact provider/model version where the CLI allows it.
3. Use the exact same prompt and verification command in both variants.
4. Use fresh Git worktrees and fresh agent sessions.
5. Run at least 5 repetitions per task; 10 is better for noisy tasks.
6. Alternate treatment order; this harness does that automatically.
7. Include at least 5 task types: codebase question/navigation, targeted edit, bug fix, cross-file change, and test-driven fix.
8. Report both token savings **and pass rate**.
9. Keep cached tokens separate from uncached input tokens.
10. Preserve raw JSON run records so results are auditable.

## IDE / extension benchmarking

The first automated adapter targets the underlying Claude Code and Codex CLIs because they provide scriptable structured output. This gives a controlled benchmark and avoids manually reading UI counters.

A later adapter can import token counters from VS Code/Antigravity sessions if those hosts expose stable machine-readable usage. Do not silently treat local `chars / 4` estimates as provider-billed tokens.

## Caveats

- Model behavior is stochastic; repeat runs.
- Prompt caching can change token accounting. Report cached input separately.
- User-level agent configuration, plugins, MCP servers, and provider updates can add noise. Keep the environment as constant as possible.
- The benchmark removes only Lean Context's managed block and Lean Context-owned generated folders in the baseline; unrelated project instructions remain intact.
- Provider JSON schemas can evolve. Keep raw outputs available when adding new adapters.

## License

MIT
