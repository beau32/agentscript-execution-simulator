/**
 * Server-only LangChain backend selection for the UI simulator.
 * API keys are used for one request and are never persisted or logged.
 */

function textContent(content) {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function requireApiKey(config) {
  const apiKey =
    typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  if (!apiKey) {
    throw new Error(`An API key is required for ${config.provider}.`);
  }
  const environmentAssignment = /^(OPENAI|ANTHROPIC)_API_KEY\s*=/i;
  if (environmentAssignment.test(apiKey)) {
    throw new Error(
      'Paste only the API key value, not the OPENAI_API_KEY= or ANTHROPIC_API_KEY= assignment.'
    );
  }
  return apiKey;
}

function localOllamaUrl(baseUrl) {
  const url = new URL(baseUrl || 'http://127.0.0.1:11434');
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('Ollama must use a localhost base URL.');
  }
  return url.toString().replace(/\/$/, '');
}

async function createModel(config) {
  const model = config.model?.trim();
  if (!model) throw new Error('A model name is required.');

  switch (config.provider) {
    case 'openai': {
      const apiKey = requireApiKey(config);
      const { ChatOpenAI } = await import('@langchain/openai');
      return new ChatOpenAI({
        model,
        apiKey,
        ...(config.baseUrl
          ? { configuration: { baseURL: config.baseUrl } }
          : {}),
      });
    }
    case 'anthropic': {
      const apiKey = requireApiKey(config);
      const { ChatAnthropic } = await import('@langchain/anthropic');
      return new ChatAnthropic({ model, apiKey });
    }
    case 'ollama': {
      const { ChatOllama } = await import('@langchain/ollama');
      return new ChatOllama({ model, baseUrl: localOllamaUrl(config.baseUrl) });
    }
    default:
      throw new Error(`Unsupported LLM provider: ${String(config.provider)}`);
  }
}

export async function invokeWithLangChain({ config, messages }) {
  const model = await createModel(config);
  const response = await model.invoke(messages);
  return {
    content: textContent(response.content),
    toolCalls: response.tool_calls ?? [],
    usage: response.usage_metadata ?? null,
  };
}
