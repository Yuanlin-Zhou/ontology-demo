# Ruoli OpenAI-compatible provider profile

Profile: `eval/ruoli.example.json`.

- Endpoint: `https://ruoli.dev/v1/chat/completions`
- Requested model: `deepseek-v4.1-flash`
- Credential selector: `RUOLI_API_KEY` (runtime environment only)
- Business contract v2, nine cases, three strategies, at most 27 calls
- `sendSeed: false`: do not assume this provider exposes seed control

`apiBase`, `apiKeyEnv` and `sendSeed` are recorded in experiment configuration and forwarded to both generation and Repair. Old configurations preserve their existing environment-based behavior. The new profile does not fall back to the old DeepSeek credential if RUOLI_API_KEY is missing. Endpoint URLs cannot contain userinfo, query strings or fragments; redirects are disabled. The runtime key is not included in prompts or normalized results; provider error bodies are omitted, and successful responses echoing the runtime key are rejected before persistence.

## Current connectivity limitation

On 2026-10-30 the cloud environment's enforced host policy did not include `ruoli.dev` or `docs.ruoli.dev`. Requests without credentials to both hosts failed during proxy CONNECT with HTTP 403. No API authentication header, code payload or model request was sent to Ruoli. The documentation could not be read through that environment either. Local compatibility tests use a mocked standard JSON Chat Completions response and do not prove the live endpoint/model is available or free.

The active connector exposes status/diagnostics reads, but no operation for changing that environment's network allowlist. Domain configuration must be changed through the environment configuration UI. An error opening Edit Environment needs its actual error text/code for diagnosis; runtime readiness alone does not establish editing service health. Do not edit the container policy snapshot or bypass its proxy.

## Usage after network access is configured

Allow `ruoli.dev` and `docs.ruoli.dev` through the supported cloud configuration flow. Supply the runtime `RUOLI_API_KEY` through the environment's secret configuration or an ephemeral local process environment. Never add a credential to this JSON file, source control or report. The API key supplied in chat was not written into any repository file.

Prepare without issuing requests:

```bash
node eval/experiment.ts eval/ruoli.example.json .eval-cache/ruoli-prepared --prepare
```

Execute only when connectivity and the runtime credential are ready, using a fresh output directory:

```bash
node eval/experiment.ts eval/ruoli.example.json .eval-cache/ruoli-run
```

The provider's live documentation/response must still be checked after access works. No automatic model aliases, retries or parameter guesses are used to conceal failures. Parameter metadata records the exact endpoint, credential variable name, temperature, output cap, seed and thinking values actually sent. No secret value is recorded.
