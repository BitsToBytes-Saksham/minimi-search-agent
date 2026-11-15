import { runAgent as runOpenAI } from './agent.js';
import { runGemini } from './gemini.js';

export function providerConfig(env = process.env) {
  const provider = env.AI_PROVIDER || (env.GEMINI_API_KEY ? 'gemini' : 'openai');
  if (!['gemini', 'openai'].includes(provider)) throw new Error('AI_PROVIDER must be gemini or openai');
  const keyName = provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
  return { provider, keyName, configured: Boolean(env[keyName]),
    model: provider === 'gemini' ? env.GEMINI_MODEL || 'gemini-3.5-flash-lite' : env.OPENAI_MODEL || 'gpt-5-mini' };
}

export function runAgent(...args) {
  return providerConfig().provider === 'gemini' ? runGemini(...args) : runOpenAI(...args);
}
