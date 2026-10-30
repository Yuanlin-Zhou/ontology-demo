/** Optional provider wrapper. Credentials are read only from the process environment. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Request { model: string; prompt: string; seed: number; temperature: number; maxOutputTokens: number; apiBase?: string; apiKeyEnv?: string; sendSeed?: boolean }

export function chatEndpoint(base: string): URL {
  let endpoint: URL;
  try { endpoint = new URL(base); } catch { throw new Error('EVAL_API_BASE is not a valid URL. Value omitted.'); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('API endpoint must not contain credentials, query parameters or fragments.');
  if (endpoint.protocol !== 'https:') throw new Error('EVAL_API_BASE must use HTTPS.');
  if (endpoint.pathname === '/' || endpoint.pathname === '') endpoint.pathname = '/chat/completions';
  else if (endpoint.pathname.replace(/\/$/, '') === '/v1') endpoint.pathname = '/v1/chat/completions';
  return endpoint;
}

export function providerParameters(endpoint: URL, request: Request): Record<string, unknown> {
  // DeepSeek's chat API does not expose a seed parameter. Do not claim it was applied.
  return { model: request.model, messages: [{ role: 'user', content: request.prompt }],
    temperature: request.temperature, max_tokens: request.maxOutputTokens,
    ...(endpoint.hostname === 'api.deepseek.com' ? { thinking: { type: 'disabled' } } : request.sendSeed === false ? {} : { seed: request.seed }) };
}

export async function completeRequest(request: Request) {
  const base = request.apiBase ?? process.env['EVAL_API_BASE'];
  const keyEnv = request.apiKeyEnv ?? 'EVAL_API_KEY';
  if (typeof keyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(keyEnv)) throw new Error('Invalid API key environment variable name.');
  const key = process.env[keyEnv];
  if (!base) throw new Error('Configure EVAL_API_BASE or the explicit apiBase setting.');
  if (!key) throw new Error(`Configure ${keyEnv} securely in environment settings.`);
  const endpoint = chatEndpoint(base);
  const parameters = providerParameters(endpoint, request);
  const response = await fetch(endpoint, {
    method: 'POST', signal: AbortSignal.timeout(110000), redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(parameters),
  });
  if (!response.ok) throw new Error(`Model request failed with HTTP ${response.status}; check access and provider configuration.`);
  const result = await response.json() as { model?: string; choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: unknown };
  if (JSON.stringify(result).includes(key)) throw new Error('Provider response contained a runtime credential; response omitted.');
  return { model: result.model, code: result.choices?.[0]?.message?.content ?? '', usage: result.usage,
    finish_reason: result.choices?.[0]?.finish_reason ?? 'missing',
    raw_response: result,
    applied_parameters: { temperature: request.temperature, max_tokens: request.maxOutputTokens, seed: parameters['seed'] ?? null,
      thinking: parameters['thinking'] ?? null, endpoint: endpoint.href, api_key_env: keyEnv } };
}

async function main(): Promise<void> {
  const request = JSON.parse(readFileSync(0, 'utf8')) as Request;
  process.stdout.write(JSON.stringify(await completeRequest(request)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
