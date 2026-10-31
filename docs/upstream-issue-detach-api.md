# DRAFT upstream issue (not posted): an official way to detach a running tool call into a background job

Target repository: `deepseek-ai/deepseek-harness`. Draft for review by the maintainer of `@anweat/dsh-background`; do not post without approval.

## Title

`@deepseek-ai/dsh-tools`: let a `tools/execute` wrapper detach a running call (hand its result to someone else) and release the step early

## Summary

A plugin can already run a tool in the background by calling `ctx.tools.execute` itself with its own `AbortController` (`background_run`). What it cannot do cleanly is take a call that is **already running in the foreground** and move it to the background, for example when the user sends a steering message while a slow tool runs, or presses a "move to background" button. We have a working prototype (`@anweat/dsh-background`, branch `proto/transfer`) that does it from a `tools/execute` wrapper, verified end to end on 0.2.1-rc.5 with a scripted local model endpoint: the step ends within about 20 ms of the steering message, the next model request carries the steering text, the real result is delivered by the job. But it depends on three host internals that are not API. We would like an official, small surface instead.

## What the prototype does today, and the three internals it relies on

The wrapper calls `next()` (which starts the body), keeps the promise, and when the user asks for a transfer it registers a `ctx.jobs` job whose `done` awaits that promise, then returns an `isError` placeholder so the step can finish.

1. **The abandoned `next()` rejects (R1).** `ToolRuntime.dispatchToolBody` ends with `finally { exec.signal = wrapperSignal }`. After the wrapper returns early, `notifyResult` has already frozen `exec`, so the assignment throws `TypeError: Cannot assign to read only property 'signal'` and the promise the wrapper kept rejects. The real result is lost. We work around it by redefining `exec.signal` as an accessor property before returning (`Object.defineProperty(exec, 'signal', { get, set, configurable: false })`), because `Object.freeze` leaves accessors callable. That is a hack on a host-owned object.
2. **The caller signal is always fused into the body (R3).** `fuseToolSignals(callerSignal, wrapperSignal)` runs for every body, so a user "stop" in the same turn still aborts a call that was moved to the background (we verified: job ends `killed`). That is arguably right for "stop the turn" but wrong for "this tool now belongs to a background job".
3. **A placeholder can only be an error (R2).** A wrapper-authored success result is re-validated against the tool's output schema and re-rendered by the tool's own `render` (the wrapper's `content` is discarded), so there is no generic "this was moved" success value; we return `isError: true` with text that says it is not a failure. The client shows it with error styling.

## Proposal

Any one of these would remove the hack; (A) is the smallest.

**(A) `ToolDispatchExecution.detach(): Promise<ToolExecutionResult>`** available to `tools/execute` wrappers.
- Calling it tells the registry: "I take over the outcome of this body". It returns the promise of the body's normalized result (after `createSuccessResult`), and the registry stops reassigning `exec.signal` / stops depending on the wrapper's frame for that body.
- The wrapper then returns its own result for the step (placeholder), exactly as today.
- The body's signal becomes `detachedSignal` supplied by the wrapper (default: unfused from the caller signal), so "stop the turn" does not kill a detached call unless the detaching party decides.

**(B)** Document and test the current behaviour as a contract: "a wrapper may return before `next()` settles; the registry keeps the execution mutable (or tolerates assignment) until the body settles; `next()` then resolves with the normalized result." This is the minimal fix for R1 (do not assign to a frozen exec in `dispatchToolBody`, or freeze a copy for observers).

**(C)** Allow a wrapper placeholder to be a non-error result with wrapper-supplied content (`ToolExecutionSuccess` with `content` honoured and `value` unvalidated, or a dedicated `detached` marker the loop renders), so clients can show it as "moved to background" rather than as a failed call.

## Why this belongs in the host

- Correct cancellation semantics need the registry: only it knows the caller signal fusion and the body's quiescence.
- Post-execute policies and `tools/result` observers currently never see the real result of a detached call; a host-level detach can decide whether to run them when the body settles (for output truncation, file-state tracking and similar policies).
- Several plugins want this (dock buttons for "run in background", auto-background after a timeout, steering policies). Each would otherwise repeat the accessor hack.

## Evidence

- Prototype: `plugins/dsh-background` branch `proto/transfer`, `src/transfer.ts`; unit tests use the real `ToolRuntime`; real-host record in `docs/validation/<date>-transfer-proto.md`.
- The failing baseline without the accessor: the phase-2 experiment log `phase2-rc5.json` (kept outside this repository) (every early-return run shows the `TypeError` on the kept `next()`).
- Versions: dispatch code in `packages/core/tools/src/index.ts` is identical across 0.2.1-rc.2 to rc.5 (git diff empty); exercised on 0.2.1-rc.5 and 0.2.0-rc.2.

## Non-goals

No new UI, no change to how `ctx.jobs` works, no change to approval flow. The prototype already reuses `ctx.jobs.start` and `dsh-tool-jobs` for the completion notice.
