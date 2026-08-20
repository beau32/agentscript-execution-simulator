/*
 * Copyright (c) 2026, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 * For full license text, see the LICENSE file in the repo root or https://www.apache.org/licenses/LICENSE-2.0
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import {
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Settings2,
  Terminal,
} from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Textarea } from '~/components/ui/textarea';
import { cn } from '~/lib/utils';
import { useAppStore } from '~/store';
import {
  defaultLlmBackendConfig,
  providerDetails,
  safeBackendConfig,
  validateLlmBackendConfig,
  type LlmBackendConfig,
  type LlmProvider,
} from '~/lib/llm-backends';
import {
  compileTemplates,
  parseSimulationContext,
  type SimulationResult,
} from '~/lib/simulator';

interface SimulationLog {
  id: number;
  parentId?: number;
  createdAt: Date;
  context: string;
  result: SimulationResult;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  modelResponse?: {
    content: string;
    toolCalls: unknown[];
    usage: unknown;
  };
}

function buildApiPayload(
  log: SimulationLog,
  backendConfig: LlmBackendConfig
): string {
  return JSON.stringify(
    {
      backend: safeBackendConfig(backendConfig),
      messages: [
        {
          role: 'system',
          content: log.result.prompt,
        },
        ...(log.messages ?? []),
      ],
      context: JSON.parse(log.context),
      executionChain: log.result.executionChain,
      tools: [],
    },
    null,
    2
  );
}

const DEFAULT_CONTEXT = JSON.stringify(
  {
    variables: {
      order_number: 'A-104',
      order_status: 'Out for delivery',
      verified: false,
    },
    context: {
      session_id: 'demo-session',
    },
  },
  null,
  2
);

const LLM_SETTINGS_STORAGE_KEY = 'agentscript-simulator-llm-settings';

function loadPersistedBackendConfig(): LlmBackendConfig {
  const fallback = defaultLlmBackendConfig();
  try {
    const stored = localStorage.getItem(LLM_SETTINGS_STORAGE_KEY);
    if (!stored) return fallback;
    const value = JSON.parse(stored) as Partial<LlmBackendConfig>;
    if (
      value.provider !== 'openai' &&
      value.provider !== 'anthropic' &&
      value.provider !== 'ollama'
    ) {
      return fallback;
    }
    return {
      provider: value.provider,
      model: typeof value.model === 'string' ? value.model : fallback.model,
      apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
      baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
    };
  } catch {
    return fallback;
  }
}

interface SimulatorSession {
  contextInput: string;
  userRequest: string;
  conversation: Array<{ id: number; role: 'user' | 'assistant'; content: string }>;
  result: SimulationResult | null;
  logs: SimulationLog[];
  activeRenderLogId: number | null;
  collapsedLogIds: Set<number>;
  backendConfig: LlmBackendConfig;
}

// Kept in memory so simulation state survives tab navigation. LLM settings are
// additionally saved to this browser's localStorage so they survive reloads.
const simulatorSessions = new Map<string, SimulatorSession>();

export function Simulate() {
  const { agentId } = useParams();
  const sessionKey = agentId ?? 'standalone';
  const initialSession = simulatorSessions.get(sessionKey);
  const source = useAppStore(state => state.source.agentscript);
  const [contextInput, setContextInput] = useState(
    () => initialSession?.contextInput ?? DEFAULT_CONTEXT
  );
  const [userRequest, setUserRequest] = useState(
    () => initialSession?.userRequest ?? ''
  );
  const [conversation, setConversation] = useState<
    Array<{ id: number; role: 'user' | 'assistant'; content: string }>
  >(() => initialSession?.conversation ?? []);
  const [result, setResult] = useState<SimulationResult | null>(
    () => initialSession?.result ?? null
  );
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<SimulationLog[]>(
    () => initialSession?.logs ?? []
  );
  const [activeRenderLogId, setActiveRenderLogId] = useState<number | null>(
    () => initialSession?.activeRenderLogId ?? null
  );
  const [collapsedLogIds, setCollapsedLogIds] = useState<Set<number>>(
    () => initialSession?.collapsedLogIds ?? new Set()
  );
  const [selectedLog, setSelectedLog] = useState<SimulationLog | null>(null);
  const [backendConfig, setBackendConfig] = useState(
    () => initialSession?.backendConfig ?? loadPersistedBackendConfig()
  );
  const [backendDialogOpen, setBackendDialogOpen] = useState(false);
  const [invoking, setInvoking] = useState(false);

  useEffect(() => {
    simulatorSessions.set(sessionKey, {
      contextInput,
      userRequest,
      conversation,
      result,
      logs,
      activeRenderLogId,
      collapsedLogIds,
      backendConfig,
    });
  }, [
    activeRenderLogId,
    backendConfig,
    collapsedLogIds,
    contextInput,
    conversation,
    logs,
    result,
    sessionKey,
    userRequest,
  ]);

  useEffect(() => {
    localStorage.setItem(LLM_SETTINGS_STORAGE_KEY, JSON.stringify(backendConfig));
  }, [backendConfig]);

  const runSimulation = (): { result: SimulationResult; logId: number } | null => {
    try {
      const context = parseSimulationContext(contextInput);
      const nextResult = compileTemplates(source, context);
      const logId = Date.now();
      setResult(nextResult);
      setError(null);
      setActiveRenderLogId(logId);
      setLogs(current => [
        {
          id: logId,
          createdAt: new Date(),
          context: contextInput,
          result: nextResult,
        },
        ...current,
      ]);
      return { result: nextResult, logId };
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    }
  };

  const updateProvider = (provider: LlmProvider) => {
    const details = providerDetails[provider];
    setBackendConfig(current => ({
      ...current,
      provider,
      model: details.defaultModel,
      baseUrl: details.defaultBaseUrl,
      apiKey: provider === 'ollama' ? '' : current.apiKey,
    }));
  };

  const invokeLlm = async () => {
    if (!userRequest.trim()) return;
    const rendered = result ? null : runSimulation();
    const activeResult = rendered?.result ?? result;
    const parentId = rendered?.logId ?? activeRenderLogId ?? undefined;
    if (!activeResult) return;
    const configurationError = validateLlmBackendConfig(backendConfig);
    if (configurationError) {
      setError(configurationError);
      setBackendDialogOpen(true);
      return;
    }

    setInvoking(true);
    setError(null);
    const nextConversation = [
      ...conversation,
      { id: Date.now(), role: 'user' as const, content: userRequest.trim() },
    ];
    setConversation(nextConversation);
    setUserRequest('');
    try {
      const response = await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            ...backendConfig,
            apiKey: backendConfig.apiKey.trim(),
            baseUrl: backendConfig.baseUrl.trim(),
            model: backendConfig.model.trim(),
          },
          messages: [
            { role: 'system', content: activeResult.prompt },
            ...nextConversation.map(({ role, content }) => ({ role, content })),
          ],
        }),
      });
      const rawBody = await response.text();
      let body: unknown = null;
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          throw new Error(
            `The LLM endpoint returned an invalid response (${response.status}).`
          );
        }
      }
      if (!response.ok || !body || typeof body !== 'object') {
        const message =
          body && typeof body === 'object' && 'error' in body
            ? String(body.error)
            : `The LLM request failed (${response.status}).`;
        throw new Error(message);
      }

      const responseBody = body as {
        content?: unknown;
        toolCalls?: unknown;
        usage?: unknown;
      };
      const entry: SimulationLog = {
        id: Date.now(),
        parentId,
        createdAt: new Date(),
        context: contextInput,
        result: activeResult,
        messages: nextConversation.map(({ role, content }) => ({
          role,
          content,
        })),
        modelResponse: {
          content: String(responseBody.content ?? ''),
          toolCalls: Array.isArray(responseBody.toolCalls)
            ? responseBody.toolCalls
            : [],
          usage: responseBody.usage ?? null,
        },
      };
      setLogs(current => [entry, ...current]);
      setConversation(current => [
        ...current,
        {
          id: Date.now() + 1,
          role: 'assistant',
          content: entry.modelResponse?.content ?? '',
        },
      ]);
      setSelectedLog(entry);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setInvoking(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-5 lg:flex-row">
      <section className="flex min-w-0 flex-1 flex-col gap-4">
        <header>
          <h1 className="text-xl font-semibold">Agent conversation</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Send a multi-turn conversation with AgentScript compiled internally
            as the system message.
          </p>
        </header>

        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <label htmlFor="simulation-context" className="text-sm font-medium">
            Runtime context (JSON)
          </label>
          <p className="text-muted-foreground mb-3 text-xs">
            Use namespaces such as <code>variables</code>, <code>context</code>,
            and <code>request</code>.
          </p>
          <Textarea
            id="simulation-context"
            value={contextInput}
            onChange={event => setContextInput(event.target.value)}
            spellCheck={false}
            className="min-h-56 resize-y font-mono text-xs leading-5"
          />
          <div className="mt-3 flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setContextInput(DEFAULT_CONTEXT);
                setConversation([]);
                setResult(null);
                setActiveRenderLogId(null);
              }}
            >
              <RotateCcw /> New conversation
            </Button>
            <Button variant="ghost" onClick={() => setBackendDialogOpen(true)}>
              <Settings2 /> Configure LLM
            </Button>
          </div>
          {!source.trim() && (
            <p className="text-muted-foreground mt-3 text-sm">
              Add AgentScript in the Script tab before running a simulation.
            </p>
          )}
          {error && <p className="text-destructive mt-3 text-sm">{error}</p>}
          <p className="text-muted-foreground mt-3 text-xs">
            Backend: {providerDetails[backendConfig.provider].label} ·{' '}
            {backendConfig.model || 'model not configured'}
          </p>
        </div>

        <div className="flex min-h-96 flex-1 flex-col rounded-lg border bg-card shadow-xs">
          <div className="border-b px-4 py-3">
            <h2 className="text-sm font-medium">Conversation</h2>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
            {conversation.length === 0 ? (
              <p className="text-muted-foreground py-8 text-center text-sm">
                Start the conversation with a customer request.
              </p>
            ) : (
              conversation.map(message => (
                <div
                  key={message.id}
                  className={cn(
                    'max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm leading-6',
                    message.role === 'user'
                      ? 'bg-primary text-primary-foreground ml-auto'
                      : 'bg-muted'
                  )}
                >
                  {message.content}
                </div>
              ))
            )}
          </div>
          <div className="border-t p-4">
            <Textarea
              id="user-request"
              value={userRequest}
              onChange={event => setUserRequest(event.target.value)}
              placeholder="Type the user's next message…"
              className="min-h-24 resize-y text-sm leading-5"
              onKeyDown={event => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void invokeLlm();
                }
              }}
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-muted-foreground text-xs">
                AgentScript is compiled internally as the system message.
              </p>
              <Button
                onClick={invokeLlm}
                disabled={!source.trim() || invoking || !userRequest.trim()}
              >
                <Terminal /> {invoking ? 'Sending…' : 'Send'}
              </Button>
            </div>
          </div>
        </div>
      </section>

      <aside className="flex min-h-0 w-full flex-col rounded-lg border bg-card shadow-xs lg:w-96">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <Terminal className="size-4" />
            <h2 className="text-sm font-medium">Request log</h2>
          </div>
          {logs.length > 0 && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setLogs([]);
                setActiveRenderLogId(null);
                setCollapsedLogIds(new Set());
              }}
            >
              Clear
            </Button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {logs.length === 0 ? (
            <p className="text-muted-foreground p-3 text-sm">
              No simulated requests yet.
            </p>
          ) : (
            logs
              .filter(log => !log.parentId)
              .map(log => {
                const children = logs.filter(child => child.parentId === log.id);
                const isCollapsed = collapsedLogIds.has(log.id);
                return (
                  <div key={log.id} className="mb-1">
                    <div className="flex items-center rounded-md hover:bg-muted">
                      {children.length > 0 ? (
                        <button
                          type="button"
                          aria-label={
                            isCollapsed
                              ? 'Expand related requests'
                              : 'Collapse related requests'
                          }
                          onClick={() =>
                            setCollapsedLogIds(current => {
                              const next = new Set(current);
                              if (next.has(log.id)) next.delete(log.id);
                              else next.add(log.id);
                              return next;
                            })
                          }
                          className="ml-1 flex size-7 shrink-0 items-center justify-center rounded hover:bg-accent"
                        >
                          {isCollapsed ? (
                            <ChevronRight className="size-4" />
                          ) : (
                            <ChevronDown className="size-4" />
                          )}
                        </button>
                      ) : (
                        <span className="ml-1 size-7 shrink-0" />
                      )}
                      <button
                        type="button"
                        onClick={() => setSelectedLog(log)}
                        className="flex min-w-0 flex-1 items-center gap-2 px-1 py-3 text-left text-sm"
                      >
                        <span className="font-medium">Rendered request</span>
                        {children.length > 0 && (
                          <span className="text-muted-foreground text-xs">
                            {children.length} related
                          </span>
                        )}
                        <span className="text-muted-foreground ml-auto text-xs">
                          {log.createdAt.toLocaleTimeString()}
                        </span>
                      </button>
                    </div>
                    {!isCollapsed &&
                      children.map(child => (
                        <button
                          key={child.id}
                          type="button"
                          onClick={() => setSelectedLog(child)}
                          className="text-muted-foreground ml-9 flex w-[calc(100%-2.25rem)] items-center gap-2 rounded-md px-2 py-2.5 text-left text-sm hover:bg-muted"
                        >
                          <ChevronRight className="size-3.5" />
                          <span className="font-medium text-foreground">
                            LLM request
                          </span>
                          <span className="ml-auto text-xs">
                            {child.createdAt.toLocaleTimeString()}
                          </span>
                        </button>
                      ))}
                  </div>
                );
              })
          )}
        </div>
      </aside>

      <Dialog
        open={selectedLog !== null}
        onOpenChange={open => !open && setSelectedLog(null)}
      >
        {selectedLog && (
          <DialogContent className="max-h-[85vh] max-w-5xl overflow-hidden p-0">
            <DialogHeader className="border-b px-6 py-5 pr-12">
              <DialogTitle>Request details</DialogTitle>
              <DialogDescription>
                API payload preview. Provider credentials are intentionally
                redacted.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[calc(85vh-110px)] overflow-auto p-6">
              <section className="min-w-0">
                <h3 className="mb-2 text-sm font-medium">
                  API payload preview
                </h3>
                <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs leading-5">
                  {buildApiPayload(selectedLog, backendConfig)}
                </pre>
              </section>
              {selectedLog.modelResponse && (
                <section className="mt-4 min-w-0">
                  <h3 className="mb-2 text-sm font-medium">LLM response</h3>
                  <pre className="max-h-[35vh] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs leading-5">
                    {selectedLog.modelResponse.content}
                  </pre>
                </section>
              )}
            </div>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={backendDialogOpen} onOpenChange={setBackendDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>LLM backend configuration</DialogTitle>
            <DialogDescription>
              Settings are saved locally in this browser and sent only to the
              same-origin LangChain endpoint. Credentials are never included in
              the request log.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <label className="block space-y-1.5 text-sm font-medium">
              Provider
              <select
                value={backendConfig.provider}
                onChange={event =>
                  updateProvider(event.target.value as LlmProvider)
                }
                className="border-input bg-background flex h-9 w-full rounded-md border px-3 text-sm shadow-xs"
              >
                {(Object.keys(providerDetails) as LlmProvider[]).map(
                  provider => (
                    <option key={provider} value={provider}>
                      {providerDetails[provider].label}
                    </option>
                  )
                )}
              </select>
            </label>
            <label className="block space-y-1.5 text-sm font-medium">
              Model
              <Input
                value={backendConfig.model}
                onChange={event =>
                  setBackendConfig(current => ({
                    ...current,
                    model: event.target.value,
                  }))
                }
                placeholder={
                  providerDetails[backendConfig.provider].defaultModel
                }
              />
            </label>
            {providerDetails[backendConfig.provider].needsApiKey && (
              <label className="block space-y-1.5 text-sm font-medium">
                API key
                <Input
                  type="password"
                  value={backendConfig.apiKey}
                  onChange={event =>
                    setBackendConfig(current => ({
                      ...current,
                      apiKey: event.target.value,
                    }))
                  }
                  autoComplete="off"
                  placeholder="Paste API key"
                />
              </label>
            )}
            {(backendConfig.provider === 'ollama' ||
              backendConfig.provider === 'openai') && (
              <label className="block space-y-1.5 text-sm font-medium">
                {backendConfig.provider === 'ollama'
                  ? 'Local base URL'
                  : 'Custom base URL (optional)'}
                <Input
                  value={backendConfig.baseUrl}
                  onChange={event =>
                    setBackendConfig(current => ({
                      ...current,
                      baseUrl: event.target.value,
                    }))
                  }
                  placeholder={
                    providerDetails[backendConfig.provider].defaultBaseUrl
                  }
                />
              </label>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                localStorage.removeItem(LLM_SETTINGS_STORAGE_KEY);
                setBackendConfig(defaultLlmBackendConfig());
              }}
            >
              Reset saved LLM settings
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
