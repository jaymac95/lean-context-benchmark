import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

export function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function commandExists(command) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [command], { stdio: 'ignore' }).status === 0;
}

function runProcess(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      shell: false,
      windowsVerbatimArguments: opts.windowsVerbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = opts.timeoutMs ? setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2500).unref();
    }, opts.timeoutMs) : null;

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: code ?? 1,
        signal,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - started)
      });
    });
  });
}

function execChecked(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function removeManagedBlock(text) {
  const start = '<!-- lean-context:start -->';
  const end = '<!-- lean-context:end -->';
  let out = text;
  while (true) {
    const a = out.indexOf(start);
    if (a < 0) break;
    const b = out.indexOf(end, a);
    if (b < 0) break;
    const before = out.slice(0, a).replace(/[ \t]+$/gm, '');
    const after = out.slice(b + end.length).replace(/^\s*\n/, '');
    out = `${before}${before.endsWith('\n') || before.length === 0 ? '' : '\n'}${after}`;
  }
  return out.replace(/^\s+|\s+$/g, '') + (out.trim() ? '\n' : '');
}

function stripLeanContext(workdir) {
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const p = path.join(workdir, file);
    if (!fs.existsSync(p)) continue;
    const original = fs.readFileSync(p, 'utf8');
    const next = removeManagedBlock(original);
    if (next.trim()) fs.writeFileSync(p, next);
    else fs.rmSync(p, { force: true });
  }
  for (const rel of [
    '.ai-context',
    path.join('.agents', 'skills', 'lean-context'),
    path.join('.claude', 'skills', 'lean-context')
  ]) {
    fs.rmSync(path.join(workdir, rel), { recursive: true, force: true });
  }
}

function resolveNpx() {
  // On Windows, `npx` on PATH resolves to npx.cmd, which spawn() can't
  // execute directly with shell:false. Run the real JS entry point
  // (shipped alongside node.exe) through node.exe instead.
  if (process.platform !== 'win32') return { command: 'npx', prefixArgs: [] };
  const cliJs = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  return { command: process.execPath, prefixArgs: [cliJs] };
}

async function installLeanContext(workdir, source, timeoutMs) {
  const { command, prefixArgs } = resolveNpx();
  const r = await runProcess(command, [...prefixArgs, '--yes', source, 'init', '.', '--chat'], {
    cwd: workdir,
    timeoutMs
  });
  if (r.code !== 0) throw new Error(`Lean Context init failed:\n${r.stderr || r.stdout}`);
  return r;
}

function parseCodex(stdout) {
  const events = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const completed = events.filter(e => e.type === 'turn.completed' && e.usage);
  const usage = completed.reduce((a, e) => {
    const u = e.usage || {};
    a.inputTokens += Number(u.input_tokens || 0);
    a.cachedInputTokens += Number(u.cached_input_tokens || 0);
    a.outputTokens += Number(u.output_tokens || 0);
    a.reasoningOutputTokens += Number(u.reasoning_output_tokens || 0);
    return a;
  }, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  return { usage, events };
}

function parseClaude(stdout) {
  const payload = JSON.parse(stdout.trim());
  const candidates = [payload.usage, payload.modelUsage, payload.model_usage].filter(Boolean);
  const usage = { inputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };

  const consume = (u) => {
    if (!u || typeof u !== 'object') return;
    usage.inputTokens += Number(u.input_tokens ?? u.inputTokens ?? 0);
    usage.cachedInputTokens += Number(u.cache_read_input_tokens ?? u.cached_input_tokens ?? u.cachedInputTokens ?? 0);
    usage.cacheCreationInputTokens += Number(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0);
    usage.outputTokens += Number(u.output_tokens ?? u.outputTokens ?? 0);
  };

  for (const c of candidates) {
    if (Array.isArray(c)) c.forEach(consume);
    else if (c && typeof c === 'object' && !('input_tokens' in c) && !('inputTokens' in c)) Object.values(c).forEach(consume);
    else consume(c);
  }
  usage.totalTokens = usage.inputTokens + usage.cacheCreationInputTokens + usage.cachedInputTokens + usage.outputTokens;
  const costUsd = Number(payload.total_cost_usd ?? payload.totalCostUsd ?? 0) || null;
  return { usage, payload, costUsd };
}

async function runProvider(provider, providerConfig, workdir, prompt, timeoutMs) {
  if (provider === 'codex') {
    const args = ['exec', '--json', '--ephemeral', '-C', workdir, '--sandbox', 'workspace-write'];
    if (providerConfig.model) args.push('--model', providerConfig.model);
    args.push(...(providerConfig.extraArgs || []), prompt);
    const raw = await runProcess(providerConfig.command || 'codex', args, { cwd: workdir, timeoutMs });
    let parsed = null;
    try { parsed = parseCodex(raw.stdout); } catch {}
    return { raw, parsed, requestedModel: providerConfig.model || null };
  }

  if (provider === 'claude') {
    // bypassPermissions: each run executes inside a disposable, isolated git
    // worktree that is deleted immediately after. acceptEdits only
    // auto-approves file edits, not Bash; a headless -p session can never
    // answer a Bash approval prompt, so the agent stalls and gives up as
    // soon as it reaches for a shell command.
    const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'bypassPermissions'];
    if (providerConfig.model) args.push('--model', providerConfig.model);
    args.push(...(providerConfig.extraArgs || []));
    const raw = await runProcess(providerConfig.command || 'claude', args, { cwd: workdir, timeoutMs });
    let parsed = null;
    try { parsed = parseClaude(raw.stdout); } catch {}
    return { raw, parsed, requestedModel: providerConfig.model || null };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

function shellCommand(command, cwd, timeoutMs) {
  if (!command) return Promise.resolve({ code: 0, stdout: '', stderr: '', durationMs: 0 });
  if (process.platform === 'win32') {
    // Node's default Windows argument escaping (CreateProcess/CRT-style,
    // backslash-escaped quotes) and cmd.exe's own quote parser (no escaping,
    // just a per-" toggle) disagree, corrupting any verifyCommand with
    // nested quotes. windowsVerbatimArguments plus a single outer-quoted
    // command string (the documented /S contract) avoids the double parse.
    const shell = process.env.ComSpec || 'cmd.exe';
    return runProcess(shell, ['/d', '/s', '/c', command], { cwd, timeoutMs, windowsVerbatimArguments: true });
  }
  return runProcess('/bin/sh', ['-lc', command], { cwd, timeoutMs });
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a,b) => a-b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(values) {
  return values.length ? values.reduce((a,b) => a+b, 0) / values.length : null;
}

function pctSaved(base, lean) {
  return base && lean != null ? ((base - lean) / base) * 100 : null;
}

export async function doctor(config) {
  const rows = [];
  rows.push(['git', commandExists('git')]);
  rows.push(['npx', commandExists('npx')]);
  for (const [provider, p] of Object.entries(config.providers || {})) {
    rows.push([`${provider}:${p.command || provider}`, commandExists(p.command || provider)]);
  }
  return rows;
}

export async function runBenchmark({ configPath, taskPath, provider, runs, outputDir }) {
  const config = loadJson(configPath);
  const task = loadJson(taskPath);
  const targetRepo = path.resolve(path.dirname(configPath), config.targetRepo);
  const providerConfig = config.providers?.[provider];
  if (!providerConfig) throw new Error(`Provider ${provider} is not configured.`);
  if (!fs.existsSync(path.join(targetRepo, '.git'))) throw new Error(`targetRepo must be a Git repository: ${targetRepo}`);

  const commit = execChecked('git', ['rev-parse', 'HEAD'], targetRepo);
  const totalRuns = Number(runs || config.runs || 3);
  const results = [];

  // Alternate order each repetition to reduce warm-cache/order bias.
  for (let i = 0; i < totalRuns; i++) {
    const variants = i % 2 === 0 ? ['baseline', 'lean'] : ['lean', 'baseline'];
    for (const variant of variants) {
      const id = `${task.id}-${provider}-${variant}-${i + 1}-${crypto.randomBytes(3).toString('hex')}`;
      const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-bench-'));
      fs.rmSync(workdir, { recursive: true, force: true });
      execChecked('git', ['worktree', 'add', '--detach', workdir, commit], targetRepo);
      const startedAt = new Date().toISOString();
      try {
        if (variant === 'baseline') stripLeanContext(workdir);
        else await installLeanContext(workdir, config.leanContextSource || 'github:jaymac95/lean-context', task.timeoutMs || 900000);

        // Commit benchmark setup so verification/diff only reflects agent changes.
        execChecked('git', ['add', '-A'], workdir);
        const hasSetupChanges = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: workdir }).status !== 0;
        if (hasSetupChanges) {
          spawnSync('git', ['-c', 'user.name=LC Benchmark', '-c', 'user.email=benchmark@localhost', 'commit', '-m', `benchmark setup: ${variant}`], { cwd: workdir, stdio: 'ignore' });
        }

        const agent = await runProvider(provider, providerConfig, workdir, task.prompt, task.timeoutMs || 900000);
        const verify = await shellCommand(task.verifyCommand, workdir, task.timeoutMs || 900000);
        const diffStat = spawnSync('git', ['diff', '--stat'], { cwd: workdir, encoding: 'utf8' }).stdout.trim();
        const status = spawnSync('git', ['status', '--porcelain'], { cwd: workdir, encoding: 'utf8' }).stdout.trim();

        const result = {
          schemaVersion: 1,
          id,
          startedAt,
          provider,
          requestedModel: agent.requestedModel,
          taskId: task.id,
          variant,
          repetition: i + 1,
          targetCommit: commit,
          agentExitCode: agent.raw.code,
          agentDurationMs: agent.raw.durationMs,
          verifyExitCode: verify.code,
          verifyDurationMs: verify.durationMs,
          success: agent.raw.code === 0 && verify.code === 0,
          usage: agent.parsed?.usage || null,
          costUsd: agent.parsed?.costUsd || null,
          diffStat,
          changedFiles: status ? status.split(/\r?\n/).length : 0,
          stderrTail: agent.raw.stderr.slice(-4000)
        };
        results.push(result);
        saveJson(path.join(outputDir, `${id}.json`), result);
        console.log(`${variant.padEnd(8)} run ${i + 1}/${totalRuns}: ${result.success ? 'PASS' : 'FAIL'} | input=${result.usage?.inputTokens ?? 'n/a'} cached=${result.usage?.cachedInputTokens ?? 'n/a'} output=${result.usage?.outputTokens ?? 'n/a'} | ${Math.round(result.agentDurationMs / 1000)}s`);
      } finally {
        try { execChecked('git', ['worktree', 'remove', '--force', workdir], targetRepo); } catch { fs.rmSync(workdir, { recursive: true, force: true }); }
      }
    }
  }
  return results;
}

export function compareResults(resultFiles) {
  const rows = resultFiles.map(loadJson).filter(r => r.usage);
  const byVariant = Object.fromEntries(['baseline', 'lean'].map(variant => {
    const x = rows.filter(r => r.variant === variant);
    const successful = x.filter(r => r.success);
    const values = (key) => x.map(r => Number(r.usage?.[key] || 0));
    return [variant, {
      runs: x.length,
      passRate: x.length ? successful.length / x.length : null,
      inputTokensMean: mean(values('inputTokens')),
      inputTokensMedian: median(values('inputTokens')),
      cachedInputTokensMean: mean(values('cachedInputTokens')),
      outputTokensMean: mean(values('outputTokens')),
      totalTokensMean: mean(values('totalTokens')),
      durationMsMean: mean(x.map(r => r.agentDurationMs)),
      costUsdMean: mean(x.map(r => r.costUsd).filter(v => v != null))
    }];
  }));
  return {
    baseline: byVariant.baseline,
    lean: byVariant.lean,
    savings: {
      inputTokensPct: pctSaved(byVariant.baseline.inputTokensMean, byVariant.lean.inputTokensMean),
      totalTokensPct: pctSaved(byVariant.baseline.totalTokensMean, byVariant.lean.totalTokensMean),
      durationPct: pctSaved(byVariant.baseline.durationMsMean, byVariant.lean.durationMsMean),
      costPct: pctSaved(byVariant.baseline.costUsdMean, byVariant.lean.costUsdMean)
    }
  };
}

export function toMarkdown(summary) {
  const f = (v, digits = 0) => v == null ? 'n/a' : Number(v).toFixed(digits);
  const p = (v) => v == null ? 'n/a' : `${v >= 0 ? '' : '-'}${Math.abs(v).toFixed(1)}%`;
  return `# Lean Context benchmark report\n\n| Metric | Baseline | Lean Context | Savings |\n|---|---:|---:|---:|\n| Mean input tokens | ${f(summary.baseline.inputTokensMean)} | ${f(summary.lean.inputTokensMean)} | ${p(summary.savings.inputTokensPct)} |\n| Mean cached input tokens | ${f(summary.baseline.cachedInputTokensMean)} | ${f(summary.lean.cachedInputTokensMean)} | — |\n| Mean output tokens | ${f(summary.baseline.outputTokensMean)} | ${f(summary.lean.outputTokensMean)} | — |\n| Mean total tokens | ${f(summary.baseline.totalTokensMean)} | ${f(summary.lean.totalTokensMean)} | ${p(summary.savings.totalTokensPct)} |\n| Mean agent time (ms) | ${f(summary.baseline.durationMsMean)} | ${f(summary.lean.durationMsMean)} | ${p(summary.savings.durationPct)} |\n| Mean cost (USD) | ${f(summary.baseline.costUsdMean, 4)} | ${f(summary.lean.costUsdMean, 4)} | ${p(summary.savings.costPct)} |\n| Pass rate | ${f((summary.baseline.passRate ?? 0) * 100, 1)}% | ${f((summary.lean.passRate ?? 0) * 100, 1)}% | — |\n\n> Token savings are only meaningful when task success remains comparable. Run multiple repetitions and pin the same model for both variants.\n`;
}
