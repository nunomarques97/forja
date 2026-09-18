---
name: forja-performance
description: Performance method for Forja's Devs and Reviewer — measure against the budget in the product profile first, profile the real path, fix the top item only, re-measure, and never trade correctness or the design contract for speed. Loaded by backend-dev, frontend-dev and reviewer.
---

# Forja performance — measure, then fix the top item

- **Budget first**: `docs/forja/PRODUCT-PROFILE.md` names the priorities (e.g. "first render < 1 s on a phone", "re-render < 50 ms", "CLI under 200 ms"). No budget written → propose one in the report (`Decisões por omissão`) and measure against it; do not optimise without a number.
- **Measure the real path** with the real data size: `performance.now()` around the critical section, `node --cpu-prof` or the browser profiler, a timed run of the command, a screenshot-derived timing for UI. Record the numbers before and after in the report.
- **Fix the top item only**, the one the measurement shows; re-measure; stop when within budget. Premature micro-optimisation is a defect, not a virtue.
- **Never** trade away correctness, tests, the design contract (`DESIGN.md`), accessibility or the $0 rule (no CDN-paid tiers, no metered services) for speed.
- Web basics that usually matter: no layout thrash in loops, batch DOM writes (string templates + one `innerHTML` per section), avoid re-parsing big JSON on every tick, cap lists (virtualise or paginate over ~500 items), images sized and lazy, fonts with `display=swap`.
- Node basics: stream instead of reading whole files when they grow; avoid synchronous I/O on hot paths; cache derived state and invalidate on change.
