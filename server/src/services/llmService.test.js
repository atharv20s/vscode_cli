import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_PRESETS, getAvailableModels } from "./llmService.js";

test("coding and reasoning presets do not silently target a free model", () => {
  for (const preset of Object.values(MODEL_PRESETS)) {
    assert.equal(typeof preset.tier,"string");
    assert.equal("openrouterId" in preset,false);
  }
  assert.equal(getAvailableModels().every(model => model.free === false),true);
});

test("model presets expose separate fast, coding and reasoning tiers", () => {
  assert.equal(MODEL_PRESETS["devstral-low"].tier,"fast");
  assert.equal(MODEL_PRESETS.devstral.tier,"coding");
  assert.equal(MODEL_PRESETS["devstral-high"].tier,"reasoning");
});
