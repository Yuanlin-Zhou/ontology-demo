import { readFileSync } from 'node:fs';
import { runAgentExperiment, type AgentConfig } from './agent.ts';
const path = process.argv[2];
if (!path) { console.error('Usage: npm run eval:agent -- <config.json>'); process.exitCode = 1; }
else {
  try {
    const config = JSON.parse(readFileSync(path, 'utf8')) as AgentConfig;
    if (!process.env['EVAL_API_KEY'] || !(config.baseUrl ?? process.env['EVAL_API_BASE'])) throw new Error('Configure EVAL_API_BASE and EVAL_API_KEY before running the experiment');
    await runAgentExperiment(config);
  }
  catch (error) { console.error(error instanceof Error ? error.message : 'Experiment failed'); process.exitCode = 1; }
}
