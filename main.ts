// Fast drop-in for makefun-site 1.0.0: the harness runs `node /bot/main.ts`
// (node22). It reads every case from /input/cases.json (a JSON array of
// {id, input}), answers each one alone with run() from solve.js, and writes
// /output/answers.json: a JSON array of the answers, one per case and in the
// cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output.
//
// Recovery cycle 1 (2026-11-23): solve.js was re-tuned for CPU time (cached
// inline-construct scan, per-case link cache, CR fast path). The driver is
// unchanged by design: one JSON.parse of the cases, one run() per case, one
// JSON.stringify of the answers, so the timed run measures the build.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its
// work runs under it (the rules: the house baseline runs with
// --no-incremental-marking, and an entry may tune V8's flags too).
// The fast solve.js behind this driver is a clean-room reimplementation of
// makefun-site 1.0.0's exact semantics (see solve.js header).
//
// Recovery cycle 2 (2026-11-24): --no-opt added. The harness runs the entry
// in a fresh process over 3 cases, so the timed run is cold: TurboFan's
// optimisation compiles cost more CPU than the optimised code saves in so
// short a run. Measured locally (whole-process CPU, practice set, 3 runs
// each, interleaved): default 745 ms vs --no-opt 512 ms (-31%); warm run()
// median 195 ms vs 183 ms (-6%). The flag is set here, before solve.js is
// imported, so every part of the entry runs under it.
setFlagsFromString('--no-incremental-marking --no-opt');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
