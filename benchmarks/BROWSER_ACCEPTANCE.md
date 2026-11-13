# Browser acceptance and visual regression

The browser acceptance runner uses the Playwright dependency in `server/` and a
provisioned Chromium binary. On the AWS Lightsail worker, run this as the same
service account that starts the repository-agent worker:

```bash
cd /opt/ath-ide/server
npm ci
npm run browser:install
```

For a deterministic local fixture:

```bash
python3 -m http.server 4173 --directory benchmarks/fixtures/browser-acceptance
APP_URL=http://127.0.0.1:4173 node benchmarks/browser-acceptance.mjs
```

- The fixture fixes its layout, viewport assumptions, font stack and transitions.
- Reviewed baselines live in `benchmarks/visual-baselines/<name>.png`.
- A normal run compares against the committed baseline. If no reviewed baseline
  exists yet, it reports visual comparison as skipped (not passed) and still
  runs the HTTP, selector, title and browser-error checks.
- To generate a candidate, set `UPDATE_VISUAL_BASELINES=1`. CI exposes this only
  through an explicit `workflow_dispatch` input and uploads the candidate as an
  artifact. Review the artifact and commit the approved PNG; do not auto-accept
  baselines on every push.
- Set `VISUAL_BASELINE_REQUIRED=1` to fail if a reviewed baseline is absent.
- Set `REQUIRED_SELECTORS='main,[data-testid=browser-acceptance]' ` to enforce
  key page landmarks.
- Set `VISUAL_DIFF_THRESHOLD=0.01` to allow at most 1% changed pixels (a pixel
  changes when the maximum RGB channel delta exceeds 16).
- Set `VISUAL_BASELINE_NAME` to keep separate baselines per page/viewport.

The runner captures a screenshot at `VISUAL_ACTUAL_PATH` when configured. CI
uploads browser evidence for review. Automatic repository-agent browser checks
use the task preview URL and report unavailable browser/preview infrastructure
as a blocker rather than silently claiming success.
