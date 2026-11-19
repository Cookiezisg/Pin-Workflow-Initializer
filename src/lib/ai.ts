/**
 * AI features: smart grouping and workspace summaries.
 *
 * Providers:
 *  - builtin   — Chrome's on-device model (Prompt API). Nothing leaves the machine.
 *  - anthropic — Claude via the official SDK, with the user's own API key.
 *  - deepseek  — DeepSeek's API (OpenAI-compatible, JSON-object mode only).
 *  - openai    — any OpenAI-compatible endpoint (OpenAI, Ollama, LM Studio, …).
 *
 * Runs in extension pages (side panel), not the service worker: the Prompt API needs a window.
 * Only tab titles and URLs are sent (query strings stripped by default).
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { unwrapUrl } from '../core/match';
import { t } from './i18n';
import { GROUP_COLORS, type AiSettings, type GroupColor, type Secrets } from '../core/types';

export interface AiTab {
  id: number;
  title: string;
  url: string;
}

export interface SuggestedGroup {
  title: string;
  color: GroupColor;
  tabIds: number[];
}

const GroupingSchema = z.object({
  groups: z.array(
    z.object({
      title: z.string().describe('1–3 word group name'),
      color: z.enum(GROUP_COLORS),
      tabs: z.array(z.number().int()).describe('Indexes of the tabs in this group'),
    }),
  ),
});

const SummarySchema = z.object({
  summary: z.string().describe('2–3 sentences: what the user is working on in this window'),
  threads: z.array(z.string()).describe('Distinct tasks or topics in progress, most important first, max 5'),
  nextStep: z.string().describe('The single most useful next action, one sentence'),
});
export type WorkspaceSummary = z.infer<typeof SummarySchema>;

const GROUP_SYSTEM = `You organise browser tabs into Chrome tab groups.
Group tabs by the task or topic they serve, not merely by website. Prefer 2–7 groups.
Every group needs at least 2 tabs; leave one-off tabs out entirely rather than forcing them into a group.
Titles are 1–3 words in the same language as most tab titles. Pick distinct colors.
Refer to tabs only by their [index].`;

const SUMMARY_SYSTEM = `You look at someone's open browser tabs and tell them, briefly and concretely, what they were doing so they can pick it back up.
Write in the same language as most tab titles. Do not list the tabs back; synthesise.`;

function describeTabs(tabs: AiTab[], stripQuery: boolean): string {
  return tabs
    .map((t, i) => {
      let url = unwrapUrl(t.url);
      if (stripQuery) {
        try {
          const u = new URL(url);
          url = u.origin + u.pathname;
        } catch {
          /* keep as is */
        }
      }
      return `[${i}] ${t.title.slice(0, 120)} — ${url.slice(0, 200)}`;
    })
    .join('\n');
}

export class AiError extends Error {}

// Models that accept server-side refusal fallbacks (fallbacks: "default").
const FALLBACK_MODELS = ['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];

async function viaAnthropic<T>(schema: z.ZodType<T>, system: string, user: string, settings: AiSettings, secrets: Secrets): Promise<T> {
  if (!secrets.anthropicKey) throw new AiError(t('Add your Anthropic API key in Settings → AI'));
  const client = new Anthropic({ apiKey: secrets.anthropicKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
  const model = settings.anthropicModel;
  try {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort: 'low', format: betaZodOutputFormat(schema) },
      ...(FALLBACK_MODELS.includes(model) && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
    });
    if (response.stop_reason === 'refusal') throw new AiError(t('The model declined this request'));
    if (response.stop_reason === 'max_tokens') throw new AiError(t('The response was cut off; try with fewer tabs'));
    if (!response.parsed_output) throw new AiError(t('The model returned an unexpected format'));
    return response.parsed_output as T;
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new AiError(t('Anthropic rejected the API key'));
    if (e instanceof Anthropic.PermissionDeniedError) throw new AiError(t('This API key cannot use that model'));
    if (e instanceof Anthropic.NotFoundError) throw new AiError(t('Unknown model “{0}”', model));
    if (e instanceof Anthropic.RateLimitError) throw new AiError(t('Rate limited by Anthropic — try again shortly'));
    if (e instanceof Anthropic.APIConnectionError) throw new AiError(t('Could not reach api.anthropic.com'));
    if (e instanceof Anthropic.APIError) throw new AiError(t('Anthropic API error {0}: {1}', e.status ?? '', e.message));
    throw e;
  }
}

export const DEEPSEEK_BASE = 'https://api.deepseek.com';

/**
 * OpenAI-style chat completion. `schema` mode uses strict JSON-schema output; `object` mode (DeepSeek,
 * older servers) asks for a JSON object and spells the schema out in the system prompt instead.
 */
async function viaChatCompletions<T>(
  schema: z.ZodType<T>, system: string, user: string,
  endpoint: { base: string; model: string; key?: string; mode: 'schema' | 'object' },
): Promise<T> {
  const base = endpoint.base.replace(/\/+$/, '');
  const jsonSchema = z.toJSONSchema(schema);
  const send = (mode: 'schema' | 'object') =>
    fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(endpoint.key && { authorization: `Bearer ${endpoint.key}` }) },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [
          {
            role: 'system',
            content: mode === 'schema' ? system : `${system}\n\nReply with one json object only, matching this JSON Schema:\n${JSON.stringify(jsonSchema)}`,
          },
          { role: 'user', content: user },
        ],
        response_format: mode === 'schema' ? { type: 'json_schema', json_schema: { name: 'result', schema: jsonSchema, strict: true } } : { type: 'json_object' },
      }),
    }).catch(() => {
      throw new AiError(t('Could not reach {0}', base));
    });
  let res = await send(endpoint.mode);
  // Many OpenAI-compatible servers reject json_schema; fall back to JSON-object mode once.
  if (res.status === 400 && endpoint.mode === 'schema') res = await send('object');
  if (res.status === 401) throw new AiError(t('{0} rejected the API key', base));
  if (!res.ok) throw new AiError(t('{0} answered {1}: {2}', base, res.status, (await res.text()).slice(0, 200)));
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return parseJson(schema, data.choices?.[0]?.message?.content);
}

// Minimal typing for Chrome's Prompt API.
interface LanguageModelSession {
  prompt(input: string, opts?: { responseConstraint?: unknown; signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}
interface LanguageModelStatic {
  availability(opts?: unknown): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>;
  create(opts?: { initialPrompts?: { role: 'system' | 'user' | 'assistant'; content: string }[] }): Promise<LanguageModelSession>;
}
const languageModel = (): LanguageModelStatic | undefined => (globalThis as { LanguageModel?: LanguageModelStatic }).LanguageModel;

export async function builtinAvailability(): Promise<'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available'> {
  const lm = languageModel();
  if (!lm) return 'unsupported';
  try {
    return await lm.availability();
  } catch {
    return 'unavailable';
  }
}

async function viaBuiltin<T>(schema: z.ZodType<T>, system: string, user: string): Promise<T> {
  const lm = languageModel();
  if (!lm) throw new AiError(t('This Chrome has no built-in AI (Prompt API). Use Claude or an OpenAI-compatible endpoint instead.'));
  const status = await lm.availability();
  if (status === 'unavailable') throw new AiError(t('Chrome’s on-device model is not available on this device'));
  const session = await lm.create({ initialPrompts: [{ role: 'system', content: system }] });
  try {
    return parseJson(schema, await session.prompt(user, { responseConstraint: z.toJSONSchema(schema) }));
  } finally {
    session.destroy();
  }
}

function parseJson<T>(schema: z.ZodType<T>, text: string | undefined): T {
  if (!text) throw new AiError(t('Empty response from the model'));
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new AiError(t('The model did not return JSON'));
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new AiError(t('The model returned an unexpected format'));
  return parsed.data;
}

function ask<T>(schema: z.ZodType<T>, system: string, user: string, settings: AiSettings, secrets: Secrets): Promise<T> {
  switch (settings.provider) {
    case 'anthropic':
      return viaAnthropic(schema, system, user, settings, secrets);
    case 'deepseek':
      if (!secrets.deepseekKey) throw new AiError(t('Add your DeepSeek API key in Settings → AI'));
      return viaChatCompletions(schema, system, user, { base: DEEPSEEK_BASE, model: settings.deepseekModel, key: secrets.deepseekKey, mode: 'object' });
    case 'openai':
      return viaChatCompletions(schema, system, user, { base: settings.openaiBaseUrl, model: settings.openaiModel, key: secrets.openaiKey, mode: 'schema' });
    case 'builtin':
      return viaBuiltin(schema, system, user);
    default:
      throw new AiError(t('AI is turned off. Pick a provider in Settings → AI.'));
  }
}

export async function suggestGroups(tabs: AiTab[], settings: AiSettings, secrets: Secrets): Promise<SuggestedGroup[]> {
  if (tabs.length < 2) throw new AiError(t('Need at least two ungrouped tabs'));
  const capped = tabs.slice(0, 150);
  const out = await ask(GroupingSchema, GROUP_SYSTEM, `Tabs:\n${describeTabs(capped, settings.stripQuery)}`, settings, secrets);
  const used = new Set<number>();
  return out.groups
    .map((g) => ({
      title: g.title.trim().slice(0, 40),
      color: g.color,
      // Map indexes back to tab ids; drop invalid or repeated ones.
      tabIds: g.tabs.filter((i) => i >= 0 && i < capped.length && !used.has(i) && used.add(i)).map((i) => capped[i]!.id),
    }))
    .filter((g) => g.title && g.tabIds.length >= 2);
}

export async function summarize(tabs: AiTab[], workspaceName: string, settings: AiSettings, secrets: Secrets): Promise<WorkspaceSummary> {
  if (tabs.length === 0) throw new AiError(t('No tabs to summarise'));
  return ask(SummarySchema, SUMMARY_SYSTEM, `Workspace: ${workspaceName}\nTabs:\n${describeTabs(tabs.slice(0, 150), settings.stripQuery)}`, settings, secrets);
}

/** Origins the extension must be granted before calling the provider from an extension page. */
export function requiredOrigins(settings: AiSettings): string[] {
  if (settings.provider === 'anthropic') return ['https://api.anthropic.com/*'];
  if (settings.provider === 'deepseek') return [`${DEEPSEEK_BASE}/*`];
  if (settings.provider === 'openai') {
    try {
      const u = new URL(settings.openaiBaseUrl);
      return [`${u.protocol}//${u.hostname}/*`];
    } catch {
      return [];
    }
  }
  return [];
}
