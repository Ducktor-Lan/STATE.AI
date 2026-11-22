---
name: state-ai-arena
description: Use STATE.AI to list arena models, connect an OpenAI Chat Completions compatible model, quote or start a user-authorized match, and check its status, replay or recording. Use for requests to run a baseline or compare models in the local arena.
---

# STATE.AI arena

Interact with the STATE.AI arena service over local loopback (`127.0.0.1`) using Node.js 22 or later. The port defaults to `STATE_AI_PORT` or `4180`, and `--port PORT` overrides it. Run commands from the repository root with `node .agents/skills/state-ai-arena/scripts/arena.mjs`. If the skill is installed elsewhere, use its `scripts/arena.mjs` path.

Run `check` to verify the service and list models. If the local service is offline, use the confirmed port or initialize it with these commands from the project checkout.

```sh
npm ci
npm run engine:prepare
npm run build
npm start -- --port 4180
```

For a remote deployment, use its HTTPS web console with HTTP Basic Auth. The deployment uses a single administrator context with access to all runs, models and recordings.

| Command | What it does |
| --- | --- |
| `check` | Verify the local service and list models. |
| `models` | List model IDs, availability and configured prices. |
| `register --base-url URL --model NAME --input-price USD --output-price USD` | Save an OpenAI Chat Completions compatible profile. |
| `quote --config FILE` | Read the first-round call and USD requirements. |
| `start --config FILE --approved` | Recheck the quote and start one user-authorized match. |
| `status RUN_ID` | Read progress and get the watch and replay links. |
| `state RUN_ID [--tick N]` | Summarize the current state or one committed tick. |
| `replay RUN_ID --from N --limit N` | List up to 40 committed frame ticks and get the replay link. |
| `recording RUN_ID` | Check recording status and get the MP4 link when ready. |
| `recording RUN_ID --request --approved` | Request or retry recording for one completed run. |

## Connect a model

Reuse an available model ID when it matches the user's intended profile. Register models without invoking inference. Confirm the provider endpoint, model name, prices in USD per million tokens, and permission to save the profile. Use HTTPS for public provider endpoints.

- In the local web console at `/?screen=build`, the user can select **接入模型**, enter the key, and choose **保存接入**. Compare the `models` output before and after registration to identify the new ID.
- For CLI registration, have the user supply `STATE_AI_MODEL_API_KEY` through their local process environment or secret manager. Use the model ID from the command output. Keep credentials out of chat, Git, command arguments, run configs and logs.

```sh
node .agents/skills/state-ai-arena/scripts/arena.mjs register --base-url https://api.example.com/v1 --model example-model --input-price 1 --output-price 2
```

Replace the sample endpoint, model and prices with the provider's actual values. Use zero prices for verified free usage. `--base-url` accepts an API base or a full `/chat/completions` endpoint. The server defaults to 1024 output tokens and `max_completion_tokens`. Use `--max-output-tokens N` or `--max-tokens-parameter max_tokens` if the provider requires it. The server stores the key in plaintext in its private data directory. An available registered profile is enabled and has a configured key. Provider access is first exercised during a match.

## Quote and start one match

Write a credential-free JSON config with one model ID per seat. Strategy supports 2–4 seats, diplomacy supports 3–4, and durations are 180, 300 or 480 seconds. Enable `recordVideo` only if the user authorized automatic recording after completion.

**运行基准对战并查看状态。 / Run a baseline match and check its status.**

Save this zero-USD baseline example as `match.json`.

```json
{
  "track": "strategy",
  "seed": 1733,
  "durationSeconds": 180,
  "factionCount": 2,
  "models": ["baseline-normal", "baseline-hard"],
  "disaster": false,
  "budget": { "maxCalls": 1000, "maxCostUsd": 0 },
  "recordVideo": false
}
```

```sh
node .agents/skills/state-ai-arena/scripts/arena.mjs quote --config match.json
```

The quote returns `startBudget.requiredCalls` and `startBudget.requiredCostUsd` without saving a run or calling any provider. It covers the first-round reservation. The USD cap uses configured token prices, and provider HTTP retries are counted separately from actor decision calls.

Use `--approved` only when the user has explicitly authorized one match with the specified service, models and seat order, track, seed, duration, disaster setting, call cap, USD cap and recording setting. Stop and report any unmet budget requirement or changed setting. Use the approved configuration to start.

```sh
node .agents/skills/state-ai-arena/scripts/arena.mjs start --config match.json --approved
```

`start` rechecks the quote with the same configuration and immediately queues a successful request. Save the run ID and viewer links. If the response is lost, check the service's run history before any resubmission.

## Check status, replay and recording

Replace `RUN_ID` with the ID from `start` or one provided by the user.

```sh
node .agents/skills/state-ai-arena/scripts/arena.mjs status RUN_ID
node .agents/skills/state-ai-arena/scripts/arena.mjs state RUN_ID --tick 20
node .agents/skills/state-ai-arena/scripts/arena.mjs replay RUN_ID --from 0 --limit 3
node .agents/skills/state-ai-arena/scripts/arena.mjs recording RUN_ID
```

Poll `status` at reasonable intervals for a bounded period and stop on `completed`, `paused` or `failed`. Report a budget stop or unknown cost and leave the run paused for the operator. Use a recorded tick for `state --tick` or omit it for the latest committed state. `replay` reports frame ticks. Use `replayUrl` for visual playback.

Share summaries and links only with authorized operators. Use links containing run or job IDs in the trusted local interface. Keep full observations, private messages, raw model replies and exported records in the service. Review media separately before publishing it.

`recording` returns `job: null` until a job exists. When the completed job includes an MP4, the command returns its local download URL. Approve manual recording requests separately and use both `--request` and `--approved` on a completed match. Recording requires FFmpeg and Edge or Chromium.
