export type LlmProvider = 'openai' | 'anthropic' | 'ollama';

export interface LlmBackendConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  baseUrl: string;
}

export const providerDetails: Record<
  LlmProvider,
  {
    label: string;
    defaultModel: string;
    defaultBaseUrl: string;
    needsApiKey: boolean;
  }
> = {
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-5.4',
    defaultBaseUrl: '',
    needsApiKey: true,
  },
  anthropic: {
    label: 'Anthropic',
    defaultModel: 'claude-sonnet-4-6',
    defaultBaseUrl: '',
    needsApiKey: true,
  },
  ollama: {
    label: 'Ollama (local)',
    defaultModel: 'llama3.1',
    defaultBaseUrl: 'http://127.0.0.1:11434',
    needsApiKey: false,
  },
};

export function defaultLlmBackendConfig(): LlmBackendConfig {
  const provider: LlmProvider = 'openai';
  const details = providerDetails[provider];
  return {
    provider,
    model: details.defaultModel,
    apiKey: '',
    baseUrl: details.defaultBaseUrl,
  };
}

export function safeBackendConfig(config: LlmBackendConfig) {
  return {
    provider: config.provider,
    model: config.model,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  };
}

export function validateLlmBackendConfig(
  config: LlmBackendConfig
): string | null {
  if (!config.model.trim()) return 'A model name is required.';
  if (providerDetails[config.provider].needsApiKey && !config.apiKey.trim()) {
    return `An API key is required for ${providerDetails[config.provider].label}.`;
  }
  if (config.provider === 'ollama' && !config.baseUrl.trim()) {
    return 'A local Ollama base URL is required.';
  }
  return null;
}
