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

// Windows npm-installed CLIs (npx, claude, codex) resolve to .cmd shims that
// Node's spawn() cannot execute with shell:false (ENOENT). Resolve the shim's
// real Node entry point once and invoke it directly instead.
const windowsCliEntryCache = new Map();

function resolveWindowsCliEntry(command) {
  if (process.platform !== 'win32') return null;
  if (windowsCliEntryCache.has(command)) return windowsCliEntryCache.get(command);
  let resolved = null;
  // npx's Windows shim is not a reliable batch file to parse: on some installs
  // it is a bash script for git-bash/WSL even under the .cmd name. Its real
  // entry point is always node_modules/npm/bin/npx-cli.js next to node.exe.
  if (command === 'npx') {
    const npxCliJs = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
    if (fs.existsSync(npxCliJs)) {
      resolved = { exe: process.execPath, prefixArgs: [npxCliJs] };
      windowsCliEntryCache.set(command, resolved);
      return resolved;
    }
  }
  try {
    const where = spawnSync('where', [command], { encoding: 'utf8' });
    const candidates = (where.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    // `where` also lists an extensionless match (e.g. a POSIX shim for git-bash/WSL)
    // before .cmd/.exe variants; that extensionless file cannot be launched by
    // Windows CreateProcess directly, so prefer a real executable/shim extension.
    const shimPath = candidates.find(p => /\.(exe|cmd|bat)$/i.test(p)) || candidates[0];
    if (shimPath) {
      if (/\.exe$/i.test(shimPath)) {
        resolved = { exe: shimPath, prefixArgs: [] };
      } else if (/\.cmd$/i.test(shimPath) || /\.bat$/i.test(shimPath)) {
        const content = fs.readFileSync(shimPath, 'utf8');
        // npm-generated shims reference an entry file relative to the shim's own
        // directory via %~dp0 (sometimes copied into a %dp0% variable first).
        const dp0Ref = /(?:%~dp0%?|%dp0%)\\?/i;
        const exeMatch = content.match(new RegExp(`"${dp0Ref.source}([^"]+\\.exe)"`, 'i'));
        const jsMatch = content.match(new RegExp(`"${dp0Ref.source}([^"]+\\.(?:m|c)?js)"`, 'i')) ||
          content.match(/node(?:\.exe)?\s+"([^"]+\.(?:m|c)?js)"/i);
        if (exeMatch) {
          const entry = path.resolve(path.dirname(shimPath), exeMatch[1]);
          if (fs.existsSync(entry)) resolved = { exe: entry, prefixArgs: [] };
        }
        if (!resolved && jsMatch) {
          const entry = path.resolve(path.dirname(shimPath), jsMatch[1]);
          if (fs.existsSync(entry)) resolved = { exe: process.execPath, prefixArgs: [entry] };
        }
        if (!resolved) resolved = { exe: shimPath, prefixArgs: [], viaShell: true };
      } else {
        resolved = { exe: shimPath, prefixArgs: [] };
      }
    }
  } catch {
    resolved = null;
  }
  windowsCliEntryCache.set(command, resolved);
  return resolved;
}

function spawnCli(command, args, opts = {}) {
  const resolved = resolveWindowsCliEntry(command);
  if (resolved && !resolved.viaShell) {
    return runProcess(resolved.exe, [...resolved.prefixArgs, ...args], opts);
  }
  if (resolved && resolved.viaShell) {
    return runProcess(resolved.exe, args, { ...opts, shell: true });
  }
  return runProcess(command, args, opts);
}

function runProcess(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      shell: opts.shell || false,
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

// A fresh `git worktree add` never has node_modules (it's gitignored). Without
// it, any verification step the agent runs (tsc, next build, npm test) has npx
// cold-fetch fresh packages from the registry — slow and wildly variable, and
// that variance pollutes both variants' measured token/time cost equally,
// masking the real lean-context effect. Link the target repo's already-installed
// node_modules in instead so verification is fast and consistent for both sides.
function linkNodeModules(targetRepo, workdir) {
  const source = path.resolve(targetRepo, 'node_modules');
  const dest = path.join(workdir, 'node_modules');
  if (!fs.existsSync(source) || fs.existsSync(dest)) return;
  try {
    fs.symlinkSync(source, dest, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    console.warn(`Warning: could not link node_modules into ${workdir}: ${error.message}`);
  }
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

async function installLeanContext(workdir, source, timeoutMs) {
  const r = await spawnCli('npx', ['--yes', source, 'init', '.', '--chat'], {
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
    const raw = await spawnCli(providerConfig.command || 'codex', args, { cwd: workdir, timeoutMs });
    let parsed = null;
    try { parsed = parseCodex(raw.stdout); } catch {}
    return { raw, parsed, requestedModel: providerConfig.model || null };
  }

  if (provider === 'claude') {
    // bypassPermissions is safe here: every run executes inside a disposable git
    // worktree that is removed immediately after (see runBenchmark's finally block).
    // acceptEdits only auto-approves file edits, not shell commands, and a headless
    // piped session has no one to answer a Bash approval prompt, so it stalls.
    const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'bypassPermissions'];
    if (providerConfig.model) args.push('--model', providerConfig.model);
    args.push(...(providerConfig.extraArgs || []));
    const raw = await spawnCli(providerConfig.command || 'claude', args, { cwd: workdir, timeoutMs });
    let parsed = null;
    try { parsed = parseClaude(raw.stdout); } catch {}
    return { raw, parsed, requestedModel: providerConfig.model || null };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

// Task authors write verifyCommand as `node -e "<code>"` with the code's own
// double quotes backslash-escaped for a POSIX shell (e.g. `\"use client\"`).
// Undo that sh-style escaping to recover the real source text.
function unescapeShDoubleQuoted(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\' && (raw[i + 1] === '"' || raw[i + 1] === '\\')) {
      out += raw[i + 1];
      i++;
    } else {
      out += raw[i];
    }
  }
  return out;
}

function extractNodeEval(command) {
  const match = command.trim().match(/^node\s+-e\s+"([\s\S]*)"$/);
  return match ? unescapeShDoubleQuoted(match[1]) : null;
}

async function shellCommand(command, cwd, timeoutMs) {
  if (!command) return { code: 0, stdout: '', stderr: '', durationMs: 0 };

  // Both cmd.exe (batch-file quote parsing has no backslash-escape concept)
  // and, to a lesser extent, POSIX shells can mangle a verifyCommand whose
  // inline code contains escaped quotes (e.g. a regex character class like
  // /["']use client["']/). Route the common `node -e "..."` shape straight to
  // node with a real argv, bypassing shell quoting entirely.
  const nodeEval = extractNodeEval(command);
  if (nodeEval !== null) {
    return runProcess(process.execPath, ['-e', nodeEval], { cwd, timeoutMs });
  }

  if (process.platform !== 'win32') {
    return runProcess('/bin/sh', ['-lc', command], { cwd, timeoutMs });
  }
  const scriptPath = path.join(cwd, `.lc-verify-${crypto.randomBytes(4).toString('hex')}.cmd`);
  fs.writeFileSync(scriptPath, `@echo off\r\n${command}\r\n`);
  try {
    // windowsVerbatimArguments means Node adds no quoting of its own, so any
    // path containing spaces (e.g. under a spaced temp dir) must be quoted here.
    return await runProcess(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${scriptPath}"`], {
      cwd,
      timeoutMs,
      windowsVerbatimArguments: true
    });
  } finally {
    try { fs.rmSync(scriptPath, { force: true }); } catch {}
  }
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
  // A verifyCommand that shells out to its own script file (recommended over
  // inline `node -e "..."` for anything non-trivial - see shellCommand above)
  // can reference it portably with <TASK_DIR>, resolved here to the task
  // file's own directory rather than baked in as a machine-specific path.
  if (task.verifyCommand) {
    task.verifyCommand = task.verifyCommand.split('<TASK_DIR>').join(path.dirname(path.resolve(taskPath)));
  }
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
      linkNodeModules(targetRepo, workdir);
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
          statusPorcelain: status,
          stderrTail: agent.raw.stderr.slice(-4000),
          verifyStderrTail: (verify.stderr || '').slice(-2000),
          verifyStdoutTail: (verify.stdout || '').slice(-2000)
        };
        results.push(result);
        saveJson(path.join(outputDir, `${id}.json`), result);
        console.log(`${variant.padEnd(8)} run ${i + 1}/${totalRuns}: ${result.success ? 'PASS' : 'FAIL'} | input=${result.usage?.inputTokens ?? 'n/a'} cached=${result.usage?.cachedInputTokens ?? 'n/a'} output=${result.usage?.outputTokens ?? 'n/a'} | ${Math.round(result.agentDurationMs / 1000)}s`);
      } finally {
        // Best-effort cleanup: a freshly npm-installed worktree can still have
        // files transiently locked (AV scan, file-index) right after the agent
        // exits. Do not let a cleanup failure abort the whole benchmark run.
        try {
          execChecked('git', ['worktree', 'remove', '--force', workdir], targetRepo);
        } catch {
          try {
            fs.rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
          } catch (cleanupError) {
            console.warn(`Warning: could not remove worktree ${workdir}: ${cleanupError.message}`);
          }
        }
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
