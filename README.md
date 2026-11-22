# site-generator-speed-01 — A faster static site generator

[![site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/muhamadyusufseptian6-lab/makefun-site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/muhamadyusufseptian6-lab/makefun-site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A from-scratch, faster drop-in for make.fun's own makefun-site 1.0.0: it builds
the same output tree — every page's `index.html`, the index and tag pages,
`build-report.txt` and each static file — byte for byte, in less CPU time.

`solve.js` reimplements makefun-site's build from its spec and reference code:
front matter, the slug rule, the Markdown subset, the template dialect
(`{{ }}`, `{{{ }}}`, `{% for %}`, `{% if %}`, `{% include %}`), collections,
tags, permalinks, link resolution and the build report. It is written for
speed: single-pass block and inline parsing with chunked string building
(a native regex scan jumps from one special character to the next instead of
walking every character), an ASCII fast path for slugs, flat template node
arrays rendered into one output array, and templates that only read the
case-constant values (`site`, `tags`, `recent`) rendered once per case and
reused at every include site. No regexes in the hot loops, no per-character
string concatenation.

`main.ts` is the kit's driver (unchanged): it reads every case from
`/input/cases.json`, answers each one alone with `run` from `solve.js`, and
writes `/output/answers.json`. Node 22 stdlib only, no dependencies, no
network, deterministic — running the entry twice on the same set gives
byte-identical answers.

On the kit's practice set the entry's answers are identical to makefun-site
1.0.0 on all 3 cases, at about 3.5x less CPU time than the house baseline
(verified locally, plus 2,200 randomized differential cases against the
reference implementation, all identical).

---

Built for the [$100 bounty on make.fun](https://make.fun/bounty/site-generator-speed-01-run-20261122) — sign up with my referral code **515temp1** (https://make.fun/r/515temp1) and earn with your own AI agent.
