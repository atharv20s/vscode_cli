import { registerTool } from "./index.js";
import { config } from "../config/env.js";

function normalizeUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw new Error("A valid preview URL is required."); }
  if (!["http:","https:"].includes(url.protocol)) throw new Error("Only HTTP(S) preview URLs are supported.");
  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!local && !/^(?:[a-z0-9-]+\.)*(?:preview|previews|localhost)$/i.test(host)) {
    throw new Error("Browser verification is restricted to localhost or the configured preview hostname.");
  }
  return url;
}

export function isPreviewVerificationUrl(value) {
  try { normalizeUrl(value); return { ok:true }; } catch (error) { return { ok:false, error:error.message }; }
}

export function registerBrowserVerificationTool() {
  registerTool({
    type: "function",
    function: {
      name: "browser_verify",
      description: "Open the running application with Playwright, inspect page errors and console errors, capture a screenshot, and optionally test a small set of visible interactions. Requires Playwright and a running localhost or preview-host application.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Local or authenticated preview URL" },
          actions: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              properties: {
                role: { type: "string", enum: ["button","link","textbox"] },
                name: { type: "string", maxLength: 120 },
                value: { type: "string", maxLength: 500 },
              },
              required: ["role","name"],
            },
          },
          timeout_ms: { type: "integer", minimum: 1000, maximum: 30000 },
        },
        required: ["url"],
      },
    },
  }, async (args, ctx = {}) => {
    let url;
    try { url = normalizeUrl(args.url); } catch (error) { return { success:false, verified:false, error:error.message }; }
    if (ctx.signal?.aborted) return { success:false, verified:false, error:"Browser verification cancelled." };
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      return {
        success:false, verified:false, unavailable:true,
        error:"Playwright is not installed in this execution environment. Install the approved Playwright package and Chromium browser on the worker before using browser verification.",
      };
    }
    let browser;
    try {
      browser = await chromium.launch({ headless:true, args:["--no-sandbox","--disable-dev-shm-usage"] });
      const page = await browser.newPage({ viewport:{width:1440,height:900} });
      const consoleErrors = [];
      const pageErrors = [];
      page.on("console", message => { if (message.type()==="error") consoleErrors.push(message.text().slice(0,1000)); });
      page.on("pageerror", error => pageErrors.push(String(error.message || error).slice(0,1000)));
      const response = await page.goto(url.toString(), { waitUntil:"domcontentloaded", timeout:args.timeout_ms || 15000 });
      await page.waitForTimeout(500);
      const title = await page.title();
      const actions = [];
      for (const action of (args.actions || [])) {
        if (ctx.signal?.aborted) throw new Error("Browser verification cancelled.");
        const locator = page.getByRole(action.role, { name:action.name, exact:true }).first();
        const count = await locator.count();
        if (!count) {
          actions.push({ ...action, success:false, error:"Accessible element not found." });
          continue;
        }
        if (action.role==="textbox" && action.value !== undefined) await locator.fill(action.value);
        else if (action.role!=="textbox") await locator.click({ timeout:5000 });
        actions.push({ ...action, success:true });
      }
      const screenshot = await page.screenshot({ type:"png", fullPage:true });
      const result = {
        success:Boolean(response && response.status()<400) && pageErrors.length===0 && actions.every(item=>item.success),
        verified:true,
        status:response?.status() ?? null,
        title,
        finalUrl:page.url(),
        consoleErrors:consoleErrors.slice(0,30),
        pageErrors:pageErrors.slice(0,30),
        actions,
        screenshotBase64:screenshot.toString("base64"),
      };
      result.success = result.success && consoleErrors.length===0;
      return result;
    } catch (error) {
      return { success:false, verified:false, error:String(error.message || error) };
    } finally {
      await browser?.close().catch(()=>{});
    }
  });
}
