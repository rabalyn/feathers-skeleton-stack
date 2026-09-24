# 0066: Defer distributed tracing (OpenTelemetry, Grafana Tempo)

- Status: Proposed
- Date: 2026-09-14
- Scope: Deferred
- Source: [Technical architecture › Observability policy](../technical-architecture.md#observability-policy)
- Related: [0061](0061-structured-logging.md), [0064](0064-observability-stack.md)

## Context

The initial system is one API process with a small number of dependencies. Tracing would add instrumentation, storage, and resource use.

## Decision

Add OpenTelemetry and Grafana Tempo tracing when cross-service debugging becomes necessary. Tracing isn't part of the first implementation.

## Consequences

- Request correlation relies on request IDs in logs (ADR 0061).
- There is no latency breakdown across dependencies until tracing is added.

## ToDos

- ToDo: [Clarify] Measurable trigger for introducing tracing.
- ToDo: [Clarify] Choose a request-ID format now that can later map onto W3C `traceparent`, so correlation survives the move to tracing.
