# ppos-preflight-worker

Canonical Asynchronous Execution Layer for PrintPrice OS.

## Overview
The preflight-worker is responsible for executing long-running or resource-intensive preflight tasks that are not suitable for synchronous HTTP execution. It uses a queue-driven architecture (BullMQ/Redis) to process jobs such as PDF analysis and high-volume fixes.

## Key Features
- **Queue-Driven**: Consumes from `preflight_async_queue`.
- **Fault Tolerant**: Implements exponential backoff retries.
- **Resilient**: Integrated **V1.9.0 Circuit Breaker** to prevent toxic loops and quarantine failing assets.
- **Deterministic**: Delegates all computation to `@ppos/preflight-engine`.

## Operations
- `ANALYZE`: Runs the engine's preflight analysis.
- `AUTOFIX`: Orchestrates technical fixes on PDFs.

## Architecture
- `queue/QueueManager.js`: Job consumption logic.
- `processors/`: Domain-specific job handlers.
- `resilience/CircuitBreaker.js`: Logic to trip and quarantine problematic jobs.