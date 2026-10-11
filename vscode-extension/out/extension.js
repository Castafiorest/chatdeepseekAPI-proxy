const vscode = require('vscode');

const VENDOR = 'freedeepseekapi';
const SECRET_KEY = 'freedeepseekapi.apiKey';
const OUTPUT_NAME = 'FreeDeepseekAPI';

const DEFAULT_BASE_URL = 'http://127.0.0.1:9655/v1';

// Built-in DeepSeek aliases exposed by the FreeDeepseekAPI proxy. Kept in sync
// with MODEL_CONFIGS in server.js so the picker works even if /v1/models is
// briefly unreachable at startup.
const FALLBACK_MODELS = [
    { id: 'deepseek-auto', label: 'deepseek-auto', family: 'deepseek-auto', detail: 'DeepSeek Intelligent Auto-Router (coding -> v4-pro, search -> reasoner-search, general -> chat)' },
    { id: 'deepseek-chat', label: 'deepseek-chat', family: 'deepseek-chat', detail: 'DeepSeek V4 Flash non-thinking (Web "Быстрый" / default)' },
    { id: 'deepseek-reasoner', label: 'deepseek-reasoner', family: 'deepseek-reasoner', detail: 'DeepSeek V4 Flash thinking mode (CoT)' },
    { id: 'deepseek-chat-search', label: 'deepseek-chat-search', family: 'deepseek-chat-search', detail: 'DeepSeek V4 Flash + web search' },
    { id: 'deepseek-reasoner-search', label: 'deepseek-reasoner-search', family: 'deepseek-reasoner-search', detail: 'DeepSeek V4 Flash thinking + web search' },
    { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro', family: 'deepseek-v4-pro', detail: 'DeepSeek Web "Эксперт" + thinking' },
    { id: 'deepseek-expert', label: 'deepseek-expert', family: 'deepseek-expert', detail: 'DeepSeek Web "Эксперт"' },
];

const MAX_INPUT_TOKENS = 64000;
const MAX_OUTPUT_TOKENS = 8192;

/** @type {vscode.OutputChannel} */
let output;
/** @type {Map<string, { id: string; label: string; family: string; detail?: string; maxInputTokens: number; maxOutputTokens: number; capabilities: any }>} */
let modelCache = new Map();
/** @type {Set<(provider: any) => void>} */
const changeListeners = new Set();

function log(...args) {
    if (output) output.appendLine(`[${new Date().toISOString()}] ${args.join(' ')}`);
}

function isDebug() {
    return vscode.workspace.getConfiguration('freedeepseekapi').get('debugLogging', false);
}

function getConfig() {
    const cfg = vscode.workspace.getConfiguration('freedeepseekapi');
    return {
        baseUrl: String(cfg.get('baseUrl', DEFAULT_BASE_URL) || DEFAULT_BASE_URL).replace(/\/+$/, ''),
        apiKey: String(cfg.get('apiKey', '') || ''),
        extraModels: cfg.get('extraModels', []) || [],
        requestTimeoutMs: Number(cfg.get('requestTimeoutMs', 120000)) || 120000,
    };
}

async function resolveApiKey(context) {
    const fromSecret = await context.secrets.get(SECRET_KEY);
    if (fromSecret) return fromSecret;
    // Fall back to the plain-text setting (some users prefer it over SecretStorage).
    return getConfig().apiKey;
}

function buildHeaders(apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    return headers;
}

function notifyModelChange() {
    for (const listener of changeListeners) {
        try { listener(undefined); } catch (e) { /* ignore */ }
    }
}

function referenceModelToInfo(model) {
    return {
        id: model.id,
        name: model.label,
        family: model.family,
        version: '1.0.0',
        detail: model.detail,
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        capabilities: model.capabilities,
    };
}

function buildModelMap(baseUrl, extraModels, remoteIds) {
    const map = new Map();
    const addModel = (id, detail, family) => {
        if (!id || map.has(id)) return;
        map.set(id, {
            id,
            label: id,
            family: family || id,
            detail,
            maxInputTokens: MAX_INPUT_TOKENS,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            capabilities: { imageInput: false, toolCalling: true },
        });
    };

    const known = new Map(FALLBACK_MODELS.map(m => [m.id, m]));
    for (const id of remoteIds) {
        const meta = known.get(id);
        addModel(id, meta ? meta.detail : `Model served by ${baseUrl}`, meta ? meta.family : id);
    }
    for (const m of FALLBACK_MODELS) {
        addModel(m.id, m.detail, m.family);
    }
    for (const id of extraModels) {
        const value = String(id || '').trim();
        if (value) addModel(value, `Extra model configured in FreeDeepseekAPI settings`);
    }
    return map;
}

async function fetchRemoteModelIds(baseUrl, apiKey) {
    const cfg = getConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(cfg.requestTimeoutMs, 10000));
    try {
        const res = await fetch(`${baseUrl}/models`, {
            method: 'GET',
            headers: buildHeaders(apiKey),
            signal: controller.signal,
        });
        if (!res.ok) {
            log(`GET /models -> HTTP ${res.status}`);
            return [];
        }
        const json = await res.json();
        const list = Array.isArray(json?.data) ? json.data : [];
        return list.map(item => String(item?.id || '')).filter(Boolean);
    } catch (error) {
        log(`GET /models failed: ${error.message}`);
        return [];
    } finally {
        clearTimeout(timer);
    }
}

async function refreshModelCache(context) {
    const cfg = getConfig();
    const apiKey = await resolveApiKey(context);
    const remoteIds = await fetchRemoteModelIds(cfg.baseUrl, apiKey);
    modelCache = buildModelMap(cfg.baseUrl, cfg.extraModels, remoteIds);
    log(`Model cache refreshed: ${[...modelCache.keys()].join(', ')}`);
    notifyModelChange();
    return modelCache;
}

function estimateTokens(text) {
    return Math.max(1, Math.ceil(String(text || '').length / 4));
}

// ---------------------------------------------------------------------------
// Message conversion (VS Code chat messages -> OpenAI chat messages)
// ---------------------------------------------------------------------------

function partToText(part) {
    if (!part) return '';
    if (typeof part === 'string') return part;
    if (typeof part.value === 'string') return part.value; // LanguageModelTextPart
    if (part instanceof vscode.LanguageModelTextPart) return part.value;
    return '';
}

function convertMessages(messages) {
    const out = [];
    const Role = vscode.LanguageModelChatMessageRole;

    for (const message of messages) {
        const isAssistant = message.role === Role.Assistant;
        const textParts = [];
        const toolCalls = [];
        const toolResults = [];

        for (const part of message.content || []) {
            if (part instanceof vscode.LanguageModelTextPart) {
                textParts.push(part.value);
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                let args = '{}';
                try { args = JSON.stringify(part.input ?? {}); } catch { args = '{}'; }
                toolCalls.push({ id: part.callId, type: 'function', function: { name: part.name, arguments: args } });
            } else if (part instanceof vscode.LanguageModelToolResultPart) {
                const content = (part.content || []).map(partToText).join('');
                toolResults.push({ tool_call_id: part.callId, content });
            } else if (part && typeof part.value === 'string') {
                textParts.push(part.value);
            }
        }

        if (isAssistant) {
            const msg = { role: 'assistant', content: textParts.join('') || null };
            if (toolCalls.length) msg.tool_calls = toolCalls;
            if (msg.content !== null || toolCalls.length) out.push(msg);
        } else {
            if (textParts.length) out.push({ role: 'user', content: textParts.join('') });
            for (const result of toolResults) {
                out.push({ role: 'tool', tool_call_id: result.tool_call_id, content: result.content });
            }
        }
    }

    return out;
}

function convertTools(options) {
    const tools = options?.tools;
    if (!Array.isArray(tools) || tools.length === 0) return undefined;
    const converted = [];
    for (const tool of tools) {
        if (!tool || !tool.name) continue;
        converted.push({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description || '',
                parameters: tool.inputSchema || { type: 'object', properties: {} },
            },
        });
    }
    return converted.length ? converted : undefined;
}

// ---------------------------------------------------------------------------
// Streaming response handling (OpenAI SSE -> VS Code response parts)
// ---------------------------------------------------------------------------

function makeThinkingPart(text) {
    try {
        if (typeof vscode.LanguageModelThinkingPart === 'function') {
            return new vscode.LanguageModelThinkingPart(text);
        }
        if (typeof vscode.LanguageModelTextPart === 'function' && vscode.LanguageModelThinkingPart === undefined) {
            return undefined; // no thinking support in this VS Code build
        }
    } catch (e) { /* ignore */ }
    return undefined;
}

async function streamChatCompletion(baseUrl, apiKey, payload, progress, token) {
    const cfg = getConfig();
    const controller = new AbortController();
    const onCancel = token.onCancellationRequested(() => controller.abort());
    const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);

    let responseText = '';
    let thinkingText = '';
    let reportedText = '';
    let reportedThinking = 0;
    /** @type {Map<number, { id: string; name: string; arguments: string }>} */
    const toolCalls = new Map();
    let finishReason = null;

    const reportText = () => {
        if (responseText.length > reportedText.length) {
            const delta = responseText.slice(reportedText.length);
            reportedText = responseText;
            if (delta) progress.report(new vscode.LanguageModelTextPart(delta));
        }
    };

    const reportThinking = () => {
        if (thinkingText.length > reportedThinking) {
            const delta = thinkingText.slice(reportedThinking);
            reportedThinking = thinkingText.length;
            const part = makeThinkingPart(delta);
            if (part) progress.report(part);
        }
    };

    try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: buildHeaders(apiKey),
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        if (!res.ok) {
            const bodyText = await res.text().catch(() => '');
            throw new Error(`FreeDeepseekAPI HTTP ${res.status}: ${bodyText.substring(0, 500)}`);
        }

        const contentType = String(res.headers.get('content-type') || '');
        if (!contentType.includes('text/event-stream')) {
            // Non-streaming fallback.
            const json = await res.json();
            const choice = json?.choices?.[0];
            const message = choice?.message || {};
            if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
                const part = makeThinkingPart(message.reasoning_content);
                if (part) progress.report(part);
            }
            if (typeof message.content === 'string' && message.content) {
                progress.report(new vscode.LanguageModelTextPart(message.content));
            }
            for (const call of message.tool_calls || []) {
                let input = {};
                try { input = JSON.parse(call.function?.arguments || '{}'); } catch { input = {}; }
                progress.report(new vscode.LanguageModelToolCallPart(call.id || `call_${Date.now()}`, call.function?.name || 'tool', input));
            }
            return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newlineIndex).trim();
                buffer = buffer.slice(newlineIndex + 1);
                if (!line || !line.startsWith('data:')) continue;
                const data = line.slice(5).trim();
                if (data === '[DONE]') continue;

                let chunk;
                try { chunk = JSON.parse(data); } catch { continue; }

                const choice = chunk?.choices?.[0];
                if (!choice) continue;
                const delta = choice.delta || {};

                if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                    thinkingText += delta.reasoning_content;
                    reportThinking();
                }
                if (typeof delta.content === 'string' && delta.content) {
                    responseText += delta.content;
                    reportText();
                }
                for (const call of delta.tool_calls || []) {
                    const index = typeof call.index === 'number' ? call.index : toolCalls.size;
                    const existing = toolCalls.get(index) || { id: '', name: '', arguments: '' };
                    if (call.id) existing.id = call.id;
                    if (call.function?.name) existing.name = call.function.name;
                    if (call.function?.arguments) existing.arguments += call.function.arguments;
                    toolCalls.set(index, existing);
                }
                if (choice.finish_reason) finishReason = choice.finish_reason;
            }
        }

        // Flush any buffered tail.
        if (buffer.trim().startsWith('data:')) { /* partial line, ignore */ }

        for (const call of toolCalls.values()) {
            if (!call.name) continue;
            let input = {};
            try { input = JSON.parse(call.arguments || '{}'); } catch { input = {}; }
            progress.report(new vscode.LanguageModelToolCallPart(call.id || `call_${Date.now()}`, call.name, input));
        }

        if (isDebug()) {
            log(`completion done: text=${responseText.length} chars, thinking=${thinkingText.length} chars, toolCalls=${toolCalls.size}, finish=${finishReason}`);
        }
        if (!responseText && toolCalls.size === 0 && !thinkingText) {
            log('WARNING: upstream returned an empty completion.');
        }
    } finally {
        clearTimeout(timer);
        onCancel.dispose();
    }
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

class FreeDeepseekProvider {
    constructor(context) {
        this.context = context;
        this.onDidChangeLanguageModelChatInformation = (listener) => {
            changeListeners.add(listener);
            return new vscode.Disposable(() => changeListeners.delete(listener));
        };
    }

    async provideLanguageModelChatInformation(options, token) {
        if (modelCache.size === 0) {
            await refreshModelCache(this.context);
        }
        if (options && options.silent) {
            return [...modelCache.values()].map(referenceModelToInfo);
        }
        return [...modelCache.values()].map(referenceModelToInfo);
    }

    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
        const cfg = getConfig();
        const apiKey = await resolveApiKey(this.context);
        const converted = convertMessages(messages);
        const tools = convertTools(options);

        const payload = {
            model: model.id,
            messages: converted,
            stream: true,
            stream_options: { include_usage: true },
        };
        if (tools) {
            payload.tools = tools;
            payload.tool_choice = 'auto';
        }

        if (isDebug()) {
            log(`POST ${cfg.baseUrl}/chat/completions model=${model.id} messages=${converted.length} tools=${tools ? tools.length : 0}`);
        }

        try {
            await streamChatCompletion(cfg.baseUrl, apiKey, payload, progress, token);
        } catch (error) {
            if (token.isCancellationRequested) return;
            log(`request failed: ${error.message}`);
            const hint = /ECONNREFUSED|fetch failed/i.test(String(error.message))
                ? `\n\nThe FreeDeepseekAPI proxy does not seem to be running at ${cfg.baseUrl}. Start it with "npm start" in the FreeDeepseekAPI project.`
                : '';
            throw new Error(`FreeDeepseekAPI request failed: ${error.message}${hint}`);
        }
    }

    async provideTokenCount(model, text, token) {
        if (typeof text === 'string') return estimateTokens(text);
        try {
            const converted = convertMessages([text]);
            const joined = converted.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
            return estimateTokens(joined);
        } catch (e) {
            return estimateTokens(JSON.stringify(text));
        }
    }
}

function registerProvider(context, provider) {
    const attempts = [];
    const lm = vscode.lm || {};
    const chat = vscode.chat || {};

    const candidates = [
        () => typeof lm.registerChatModelProvider === 'function' && lm.ChatProviderFeatures
            ? lm.registerChatModelProvider(VENDOR, provider, { features: new lm.ChatProviderFeatures() })
            : undefined,
        () => typeof lm.registerChatModelProvider === 'function'
            ? lm.registerChatModelProvider(VENDOR, provider, { features: {} })
            : undefined,
        () => typeof lm.registerLanguageModelChatProvider === 'function'
            ? lm.registerLanguageModelChatProvider(VENDOR, provider)
            : undefined,
        () => typeof chat.registerChatModelProvider === 'function'
            ? chat.registerChatModelProvider(VENDOR, provider)
            : undefined,
    ];

    for (const attempt of candidates) {
        try {
            const disposable = attempt();
            if (disposable) return disposable;
        } catch (error) {
            attempts.push(error);
        }
    }

    const detail = attempts.map(e => e && e.message).filter(Boolean).join(' | ');
    log(`Could not register provider: ${detail || 'no compatible API found'}`);
    return undefined;
}

async function activate(context) {
    output = vscode.window.createOutputChannel(OUTPUT_NAME);
    context.subscriptions.push(output);

    const provider = new FreeDeepseekProvider(context);

    const disposable = registerProvider(context, provider);
    if (disposable) {
        context.subscriptions.push(disposable);
        log('Registered language model chat provider (vendor=freedeepseekapi).');
    } else {
        const choice = await vscode.window.showErrorMessage(
            'FreeDeepseekAPI: could not register the Copilot model provider. This build of VS Code may require the proposed chat provider API.',
            'Show Log'
        );
        if (choice === 'Show Log') output.show();
    }

    // Kick off an initial model discovery (best effort, non-blocking).
    refreshModelCache(context).catch(error => log(`initial refresh failed: ${error.message}`));

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('freedeepseekapi')) {
                refreshModelCache(context).catch(error => log(`refresh after config change failed: ${error.message}`));
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('freedeepseekapi.setApiKey', async () => {
            const value = await vscode.window.showInputBox({
                title: 'FreeDeepseekAPI API Key',
                prompt: 'Only needed if the proxy was started with PROXY_API_KEY. Leave blank to clear.',
                password: true,
                ignoreFocusOut: true,
            });
            if (value === undefined) return;
            if (value) {
                await context.secrets.store(SECRET_KEY, value);
                vscode.window.showInformationMessage('FreeDeepseekAPI: API key saved.');
            } else {
                await context.secrets.delete(SECRET_KEY);
                vscode.window.showInformationMessage('FreeDeepseekAPI: API key cleared.');
            }
            await refreshModelCache(context);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('freedeepseekapi.clearApiKey', async () => {
            await context.secrets.delete(SECRET_KEY);
            vscode.window.showInformationMessage('FreeDeepseekAPI: API key cleared.');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('freedeepseekapi.refreshModels', async () => {
            const map = await refreshModelCache(context);
            vscode.window.showInformationMessage(`FreeDeepseekAPI: ${map.size} model(s) available.`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('freedeepseekapi.testConnection', async () => {
            const cfg = getConfig();
            const apiKey = await resolveApiKey(context);
            try {
                const res = await fetch(`${cfg.baseUrl}/models`, { headers: buildHeaders(apiKey) });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const json = await res.json();
                const count = Array.isArray(json?.data) ? json.data.length : 0;
                vscode.window.showInformationMessage(`FreeDeepseekAPI: connected to ${cfg.baseUrl} (${count} model(s)).`);
            } catch (error) {
                vscode.window.showErrorMessage(`FreeDeepseekAPI: cannot reach ${cfg.baseUrl} — ${error.message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('freedeepseekapi.showOutput', () => output.show())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('freedeepseekapi.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'freedeepseekapi');
        })
    );
}

function deactivate() { }

module.exports = { activate, deactivate };
