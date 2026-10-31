---
name: dsh-background
description: Use when a tool call is slow and you do not need its result yet, so the user can keep talking to you: run it with background_run and collect the result from the completion notice. 工具调用耗时较长、暂时不需要结果时使用。
---

# dsh-background

`background_run(tool, arguments, description)` starts one other tool call as a background job and returns a job id at once. Your turn is not blocked, and the user can interrupt or give new instructions while it runs. When the tool finishes, the host sends a completion notice (it does not carry the result); read the result with `job_output`.

```json
{"tool":"web_fetch","arguments":{"url":"https://example.com/big-report"},"description":"Fetch the big report"}
```

`arguments` follow the target tool's own schema, exactly as if you called it directly. A wrong name or a bad argument is refused at once with the reason and no job is created.

## When to use it

- A call that takes a long time and whose result you do not need for the next step.
- Several independent slow calls: start each, keep working, read the results as the notices arrive.
- Do not use it for a quick call, or when your very next step needs the result: call the tool directly.

## After starting

- Do not wait or poll. Continue with other work or tell the user it is running.
- The notice names the job. Read the result with `job_output`; `job_output` with `wait: true` blocks only when you truly need the result now.
- `job_list` shows your jobs, `job_kill` stops one. A killed job's tool call is aborted.
- The result is stored as text; long results are cut. Images are replaced by `[image]`.

## What not to put in the background

- Tools that write the same files or state as another tool you are running now (edits, writes, shell commands in the same directory). Background and foreground calls really run at the same time.
- Tools that need the user's answer (ask-user tools); the question would come with no turn to show it.
- `bash`, `pwsh`, `workflow`: they have their own `run_in_background: true`. `subagent` and `terminal_open` already return at once. `background_run` refuses all of them and the job tools.

## Approval

A tool that asks the user for approval still asks, when it runs in the background. Where nobody can answer (a headless run) the call is denied and the job ends as `failed` with the reason.
