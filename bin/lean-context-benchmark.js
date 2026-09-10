#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { doctor, runBenchmark, compareResults, toMarkdown, loadJson } from '../lib/index.js';

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find(x => x.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function usage() {
  console.log(`lean-context-benchmark\n\nCommands:\n  doctor  [--config=benchmark.config.json]\n  run     --provider=codex|claude --task=tasks/task.json [--runs=3] [--config=benchmark.config.json] [--out=results]\n  compare [--results=results] [--out=results/report.md]\n`);
}

const cmd = process.argv[2];
if (!cmd || ['-h', '--help', 'help'].includes(cmd)) { usage(); process.exit(0); }

const configPath = path.resolve(arg('config', 'benchmark.config.json'));

if (cmd === 'doctor') {
  const config = loadJson(configPath);
  const rows = await doctor(config);
  for (const [name, ok] of rows) console.log(`${ok ? '✓' : '✗'} ${name}`);
  const models = Object.entries(config.providers || {}).filter(([,p]) => !p.model).map(([name]) => name);
  if (models.length) console.log(`! Pin exact model IDs before publishing benchmark claims: ${models.join(', ')}`);
  process.exit(rows.every(([,ok]) => ok) ? 0 : 1);
}

if (cmd === 'run') {
  const provider = arg('provider');
  const task = arg('task');
  if (!provider || !task) { usage(); process.exit(2); }
  const out = path.resolve(arg('out', 'results'));
  await runBenchmark({
    configPath,
    taskPath: path.resolve(task),
    provider,
    runs: Number(arg('runs', '0')) || null,
    outputDir: out
  });
  console.log(`Saved raw run records to ${out}`);
  process.exit(0);
}

if (cmd === 'compare') {
  const resultsDir = path.resolve(arg('results', 'results'));
  const files = fs.existsSync(resultsDir) ? fs.readdirSync(resultsDir).filter(x => x.endsWith('.json')).map(x => path.join(resultsDir, x)) : [];
  if (!files.length) throw new Error(`No JSON result files found in ${resultsDir}`);
  const summary = compareResults(files);
  const md = toMarkdown(summary);
  const out = path.resolve(arg('out', path.join(resultsDir, 'report.md')));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, md);
  fs.writeFileSync(out.replace(/\.md$/i, '.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(md);
  console.log(`Saved ${out}`);
  process.exit(0);
}

usage();
process.exit(2);
