import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ProviderError, validateProfile } from '@state/providers';
import type { ModelProfile } from '@state/providers';
import { atomicWriteJson } from './atomic-json.js';
import { modelSummaries, type ServerModelProfile } from './config.js';
import { HttpError, isObject } from './security.js';
import type { ModelSummary } from './types.js';

const ID_PREFIX = 'local-openai-';
const LOCAL_ID = /^local-openai-[a-f0-9]{32}$/u;
const INPUT_FIELDS = new Set([
  'baseUrl', 'model', 'apiKey', 'label', 'inputUsdPerMillion', 'outputUsdPerMillion', 'maxOutputTokens', 'maxTokensParameter',
]);
const CHAT_PATH = '/chat/completions';

interface SavedModel {
  id: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  label: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  maxOutputTokens: number;
  maxTokensParameter: 'max_completion_tokens' | 'max_tokens';
}

function keySlot(id: string): string {
  return `STATE_AI_LOCAL_API_KEY_${id.slice(ID_PREFIX.length).toUpperCase()}`;
}

function prepareModel(id: string, value: unknown, normalizeEndpoint: boolean): { saved: SavedModel; profile: ModelProfile } {
  if (!isObject(value) || Object.keys(value).some(field => !INPUT_FIELDS.has(field))) {
    throw new HttpError(400, 'OpenAI model registration must contain only supported fields.');
  }
  const { baseUrl, model, label = model, inputUsdPerMillion, outputUsdPerMillion,
    maxOutputTokens = 1024, maxTokensParameter = 'max_completion_tokens' } = value;
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
  if (!/^[\x21-\x7e]+$/u.test(apiKey)) throw new HttpError(400, 'apiKey must be a nonempty token with valid Bearer header characters.');
  const authority = typeof baseUrl === 'string' ? /^https?:\/\/([^/?#]+)/iu.exec(baseUrl)?.[1] : undefined;
  if (!authority || authority.includes('@')) throw new HttpError(400, 'baseUrl must be an absolute HTTP(S) URL without userinfo.');
  if (typeof model !== 'string' || typeof label !== 'string') throw new HttpError(400, 'model and any supplied label must be strings.');
  if (typeof inputUsdPerMillion !== 'number' || typeof outputUsdPerMillion !== 'number') {
    throw new HttpError(400, 'inputUsdPerMillion and outputUsdPerMillion are required numeric prices.');
  }
  if (typeof maxOutputTokens !== 'number') throw new HttpError(400, 'maxOutputTokens must be an integer.');
  if (maxTokensParameter !== 'max_completion_tokens' && maxTokensParameter !== 'max_tokens') {
    throw new HttpError(400, 'maxTokensParameter must be max_completion_tokens or max_tokens.');
  }
  let profile: ModelProfile;
  try {
    profile = validateProfile({ id, provider: 'openai-compatible', label, model, baseUrl, apiKeyEnv: keySlot(id),
      inputUsdPerMillion, outputUsdPerMillion, maxOutputTokens, requestOptions: { maxTokensParameter } });
  } catch (error) {
    if (error instanceof ProviderError) throw new HttpError(400, error.message);
    throw error;
  }
  let normalizedBaseUrl = profile.baseUrl!;
  if (normalizeEndpoint) {
    const url = new URL(normalizedBaseUrl);
    if (url.pathname.endsWith(CHAT_PATH)) {
      normalizedBaseUrl = url.origin + url.pathname.slice(0, -CHAT_PATH.length).replace(/\/+$/u, '');
    }
  }
  const encodedKey = encodeURIComponent(apiKey);
  if ([model, label, normalizedBaseUrl].some(field => field === apiKey || field === encodedKey
    || (apiKey.length >= 4 && (field.includes(apiKey) || field.includes(encodedKey))))) {
    throw new HttpError(400, 'Only apiKey may contain the supplied credential.');
  }
  profile.baseUrl = normalizedBaseUrl;
  const saved: SavedModel = { id, baseUrl: normalizedBaseUrl, model, apiKey, label, inputUsdPerMillion, outputUsdPerMillion, maxOutputTokens, maxTokensParameter };
  return { profile, saved };
}

async function registryEntries(directory: string) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter(entry => entry.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('Cannot read the local model registry.');
  }
}

async function readRegistration(file: string, id: string): Promise<ReturnType<typeof prepareModel>> {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { throw new Error('Cannot read a local model registration.'); }
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { throw new Error('A local model registration is not valid JSON.'); }
  if (!isObject(value)) throw new Error('A local model registration has an invalid format.');
  const { version, id: savedId, ...input } = value;
  if (version !== 1) throw new Error('A local model registration has an unsupported version.');
  if (savedId !== id || Object.keys(input).length !== INPUT_FIELDS.size) throw new Error('A local model registration has an invalid format or id.');
  // Stored URLs are already base URLs. Removing another suffix would change the profile.
  try { return prepareModel(id, input, false); } catch { throw new Error('A local model registration has invalid fields.'); }
}

export class LocalModels {
  private writes: Promise<void> = Promise.resolve();
  readonly profiles: readonly ServerModelProfile[];

  private constructor(private readonly directory: string, private readonly allProfiles: ServerModelProfile[], private readonly env: NodeJS.ProcessEnv) {
    this.profiles = allProfiles;
  }

  static async open(dataDir: string, profiles: readonly ServerModelProfile[], env: NodeJS.ProcessEnv): Promise<LocalModels> {
    const registry = new LocalModels(join(dataDir, 'local-models'), [...profiles], env);
    for (const entry of await registryEntries(registry.directory)) {
      const id = entry.name.slice(0, -'.json'.length);
      if (!entry.isFile() || !LOCAL_ID.test(id)) throw new Error('The local model registry contains an invalid registration filename.');
      const { saved, profile } = await readRegistration(join(registry.directory, entry.name), id);
      if (registry.conflicts(id)) throw new Error('The local model registry contains a conflicting model id or credential slot.');
      registry.publish(saved, profile);
    }
    return registry;
  }

  private conflicts(id: string): boolean {
    const slot = keySlot(id);
    return Object.hasOwn(this.env, slot) || this.allProfiles.some(profile => profile.id === id || profile.apiKeyEnv === slot);
  }

  private publish(saved: SavedModel, profile: ModelProfile): void {
    this.env[keySlot(saved.id)] = saved.apiKey;
    this.allProfiles.push(profile);
  }

  register(value: unknown): Promise<ModelSummary> {
    const write = this.writes.then(async () => {
      let id: string;
      do { id = ID_PREFIX + randomUUID().replaceAll('-', ''); } while (this.conflicts(id));
      const { saved, profile } = prepareModel(id, value, true);
      const file = join(this.directory, `${id}.json`);
      try { await atomicWriteJson(file, JSON.stringify({ version: 1, ...saved }, null, 2)); }
      catch { throw new HttpError(500, 'Cannot save the local model registry.', 'MODEL_REGISTRY_WRITE_FAILED'); }
      this.publish(saved, profile);
      return modelSummaries([profile], this.env)[0]!;
    });
    // Each caller observes its result, and a failed write leaves the queue usable.
    this.writes = write.then(() => undefined, () => undefined);
    return write;
  }

  flush(): Promise<void> { return this.writes; }
}
