# Simulator LangChain runtime

The UI simulator sends configured requests to `POST /api/simulate`. The root
`server.mjs` handles that endpoint and uses `llm-runtime.mjs` to instantiate a
LangChain chat model.

Install these server-only integrations before starting the production server:

```bash
pnpm --dir server install
```

Supported backends are OpenAI, Anthropic, and local Ollama. The browser UI saves
its configuration locally in the browser; the request log deliberately omits
credentials.
