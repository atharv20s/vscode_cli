# Browser acceptance and visual regression

Requires Playwright plus a provisioned Chromium browser in the execution worker.

```bash
APP_URL=http://127.0.0.1:5173 node benchmarks/browser-acceptance.mjs
```

- First run creates `benchmarks/visual-baselines/default.png`.
- Set `UPDATE_VISUAL_BASELINES=1` only when deliberately accepting a UI change.
- Set `REQUIRED_SELECTORS='main,[data-testid=dashboard]' ` to enforce key page landmarks.
- Set `VISUAL_DIFF_THRESHOLD=0.01` to allow at most 1% changed pixels (pixels are considered changed when the maximum RGB channel delta exceeds 16).
- Set `VISUAL_BASELINE_NAME` to keep separate baselines per page/viewport.

The runner checks HTTP status, a non-empty document title, required selectors,
browser console/page errors, and a pixel-level screenshot difference. It is
intentionally separate from CI's unit tests: CI must provision the browser and
a deterministic app fixture before treating these checks as a required gate.
