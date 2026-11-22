import { test } from "node:test";
import assert from "node:assert/strict";
import { ObservabilityAuditService } from "./observabilityAuditService.js";

test("manages span lifecycle with timing and error attributes", () => {
  const service = new ObservabilityAuditService();
  const span = service.startSpan("tool.execute", { "tool.name": "verify_workspace" });

  assert.ok(span.spanId);
  assert.ok(span.traceId);
  assert.equal(span.name, "tool.execute");
  assert.equal(span.status, "UNSET");

  const completed = service.endSpan(span.spanId, "OK");
  assert.equal(completed.status, "OK");
  assert.ok(typeof completed.durationMs === "number");
  assert.equal(service.activeSpans.size, 0);
  assert.equal(service.completedSpans.length, 1);
});

test("calculates token consumption and model dollar costs accurately", () => {
  const service = new ObservabilityAuditService();

  const usage = service.recordTokenUsage({
    model: "coding",
    promptTokens: 1000,
    completionTokens: 500,
  });

  // Rates for coding: input $0.30/M ($0.0003), output $1.20/M ($0.0006) => Total $0.0009
  assert.equal(usage.totalTokens, 1500);
  assert.equal(usage.estimatedCostUsd, 0.0009);

  const summary = service.getMetricsSummary();
  assert.equal(summary.tokenUsage.promptTokens, 1000);
  assert.equal(summary.tokenUsage.completionTokens, 500);
});

test("records immutable audit log events with decisions and metadata", () => {
  const service = new ObservabilityAuditService();

  const event = service.recordAuditEvent({
    actor: "agent",
    action: "file.write",
    resource: "src/server.js",
    decision: "ALLOW",
    metadata: { bytes: 1024 },
    redacted: true,
  });

  assert.ok(event.id);
  assert.equal(event.decision, "ALLOW");
  assert.equal(event.redacted, true);
  assert.equal(service.auditEvents.length, 1);
});
