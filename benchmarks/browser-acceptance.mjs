#!/usr/bin/env node
/**
 * Browser acceptance + visual regression runner.
 * Requires Playwright and its Chromium browser on the worker.
 * Usage: APP_URL=http://127.0.0.1:5173 node benchmarks/browser-acceptance.mjs
 * Set UPDATE_VISUAL_BASELINES=1 only when intentionally accepting a new UI.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(new URL("../server/package.json", import.meta.url));

const appUrl = process.env.APP_URL;
if (!appUrl) throw new Error("APP_URL is required.");
const parsed = new URL(appUrl);
if (!["http:","https:"].includes(parsed.protocol)) throw new Error("APP_URL must use HTTP(S).");
const allowed = ["localhost","127.0.0.1","::1"];
const configuredPreview = process.env.PREVIEW_PUBLIC_URL ? new URL(process.env.PREVIEW_PUBLIC_URL) : null;
const matchesConfiguredPreview = configuredPreview && configuredPreview.host.toLowerCase() === parsed.host.toLowerCase();
if (!allowed.includes(parsed.hostname) && !matchesConfiguredPreview) {
  throw new Error("APP_URL must target localhost, an approved .preview host, or the exact PREVIEW_PUBLIC_URL host.");
}
if (parsed.username || parsed.password) throw new Error("APP_URL must not embed credentials.");
const baselineDir = path.resolve(process.env.VISUAL_BASELINE_DIR || "benchmarks/visual-baselines");
const baselineName = process.env.VISUAL_BASELINE_NAME || "default";
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(baselineName)) throw new Error("VISUAL_BASELINE_NAME must be a simple filename.");
const baselinePath = path.join(baselineDir, baselineName + ".png");
const updateBaseline = process.env.UPDATE_VISUAL_BASELINES === "1";
const threshold = Math.max(0, Math.min(1, Number(process.env.VISUAL_DIFF_THRESHOLD || 0.01)));
const { chromium } = require("playwright");
const browser = await chromium.launch({headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});
const page = await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
const errors = [];
await page.route("**/*", route => {
  let target;
  try { target = new URL(route.request().url()); } catch { return route.abort(); }
  if (target.origin !== parsed.origin && !["data:","blob:"].includes(target.protocol)) return route.abort();
  return route.continue();
});
page.on("pageerror", error => errors.push(String(error.message || error)));
page.on("console", message => { if (message.type()==="error") errors.push(message.text()); });
let failed = false;
try {
  const response = await page.goto(parsed.toString(),{waitUntil:"domcontentloaded",timeout:30000});
  if (!response || response.status() >= 400) throw new Error("Application returned HTTP " + (response?.status() ?? "no response"));
  if (new URL(page.url()).origin !== parsed.origin) throw new Error("Application redirected outside the approved origin.");
  await page.waitForTimeout(500);\n  const title = await page.title();
  if (!title.trim()) throw new Error("Application title is empty.");
  for (const selector of (process.env.REQUIRED_SELECTORS || "").split(",").map(x=>x.trim()).filter(Boolean)) {
    if (!await page.locator(selector).count()) throw new Error("Required selector not found: " + selector);
  }
  const screenshot = await page.screenshot({type:"png",fullPage:true});
  await fs.mkdir(baselineDir,{recursive:true});
  if (updateBaseline) {
    await fs.writeFile(baselinePath,screenshot);
    console.log(JSON.stringify({type:"baseline",path:baselinePath,updated:updateBaseline}));
  } else {
    const baseline = await fs.readFile(baselinePath);
    const diff = await page.evaluate(async ({current,baseline}) => {
      const decode = async value => {
        const image = new Image();
        image.src = "data:image/png;base64," + value;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width=image.naturalWidth; canvas.height=image.naturalHeight;
        const context=canvas.getContext("2d",{willReadFrequently:true});
        context.drawImage(image,0,0);
        return {width:canvas.width,height:canvas.height,data:context.getImageData(0,0,canvas.width,canvas.height).data};
      };
      const [a,b]=await Promise.all([decode(current),decode(baseline)]);
      if (a.width!==b.width || a.height!==b.height) return {different:1,total:1,ratio:1,dimensionsChanged:true};
      let different=0, total=a.width*a.height;
      for(let i=0;i<a.data.length;i+=4) {
        const delta=Math.max(Math.abs(a.data[i]-b.data[i]),Math.abs(a.data[i+1]-b.data[i+1]),Math.abs(a.data[i+2]-b.data[i+2]));
        if(delta>16) different++;
      }
      return {different,total,ratio:total?different/total:0,dimensionsChanged:false};
    },{current:screenshot.toString("base64"),baseline:baseline.toString("base64")});
    console.log(JSON.stringify({type:"visual-diff",...diff,threshold}));
    if(diff.ratio>threshold) failed=true;
  }
  if(errors.length) { failed=true; console.error(JSON.stringify({type:"browser-errors",errors:errors.slice(0,30)})); }
  console.log(JSON.stringify({type:"acceptance",url:parsed.origin,title,consoleOrPageErrors:errors.length,success:!failed}));
} finally {
  await browser.close();
}
if(failed) process.exitCode=1;
