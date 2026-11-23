[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Vins1206/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Vins1206/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)

# site-generator-speed-01 — fast drop-in for makefun-site 1.0.0

A faster reimplementation of make.fun's own static site generator,
makefun-site 1.0.0, that returns byte-for-byte the same output tree for
every generated site — and does it in about a third of the house
baseline's CPU time.

## What it does

`solve.js` exports `run(input)`, which builds one site
`{ site, templates, files }` exactly as makefun-site does: front matter,
permalinks and slugs, its own Markdown subset, its own template dialect,
collections and tags, index/tag pages, static files, and
`build-report.txt`. `main.ts` is the harness driver: it reads every case
from `/input/cases.json`, answers each one alone with `run`, and writes
`/output/answers.json`.

## How it is faster

- A fused Markdown lexer/renderer: blocks are rendered in one pass, and
  inline constructs are found with native `indexOf` jumps instead of a
  per-character walk.
- Templates are compiled to plain JS functions (lazy, per case), with
  scope lookups inlined by path length, and output built in one array
  per render.
- Templates that only read `site`/`tags`/`recent` are rendered once per
  case and cached; templates of one free variable (a post's card) are
  memoised by that value.
- Slugs are cached per case, with an ASCII fast path around NFKD; HTML
  escaping uses a single regex scan; word counting uses a fast branch
  for ASCII text.
- Inline constructs are found by caching each opener's next position
  and re-scanning only the type the cursor passes; repeated relative
  links are resolved once per (directory, target); sources without a
  carriage return skip the CR normalisation pass.
- Nothing is cached from one case to the next: every per-case cache is
  created fresh inside `run()`.

## Results on the practice set

- Exactness: **3/3 cases pass** the kit scorer (`passed: 1`), and the
  same on 9/9 freshly generated cases drawn from other seeds.
- CPU time (practice set, 3 cases, median of 10 runs in one process):
  **~192 ms vs ~614 ms for the house baseline — about 3.2× faster**.
  (First version: ~209 ms vs ~649 ms, 3.1×; recovery cycle 1, 2026-11-23.)
- Two runs of `main.ts` produce byte-identical `answers.json`.

## How to run

```sh
node main.ts   # with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR set outside a container
```

Node 22, no dependencies, no install step, no WebAssembly or native code.
