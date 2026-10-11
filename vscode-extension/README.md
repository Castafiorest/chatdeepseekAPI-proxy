# FreeDeepseekAPI for GitHub Copilot Chat

A tiny BYOK **language-model provider** that connects GitHub Copilot Chat to your
local **FreeDeepseekAPI** proxy (the OpenAI-compatible bridge to DeepSeek Web Chat).

It has its **own vendor id** (`freedeepseekapi`) and its **own settings**, so it never
collides with:

- the official **DeepSeek** provider (`vizards.deepseek-v4-for-copilot`, vendor `deepseek`), and
- the generic **9Router** BYOK bridge (`hotrungnhan.9router-for-github-copilot`, vendor `9router-github-copilot`).

## Requirements

1. The FreeDeepseekAPI proxy must be running:

   ```powershell
   cd "D:\- Archive\Medi nitip\Project-Medi\FreeDeepseekAPI-EN"
   npm start
   ```

   It listens on `http://127.0.0.1:9655` by default.

2. GitHub Copilot Chat installed and signed in (BYOK providers appear in the model picker).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `freedeepseekapi.baseUrl` | `http://127.0.0.1:9655/v1` | Base URL of the local proxy. |
| `freedeepseekapi.apiKey` | *(empty)* | Plain-text bearer token (optional). |
| `freedeepseekapi.extraModels` | `[]` | Extra model ids to expose. |
| `freedeepseekapi.requestTimeoutMs` | `120000` | Per-request timeout. |
| `freedeepseekapi.debugLogging` | `false` | Verbose logging to the output channel. |

API key can also be stored securely with the command **FreeDeepseekAPI: Set API Key**
(recommended; takes precedence over the plain-text setting). Only needed when the proxy
was started with `PROXY_API_KEY`.

## Commands

- **FreeDeepseekAPI: Set API Key / Clear API Key**
- **FreeDeepseekAPI: Test Connection**
- **FreeDeepseekAPI: Refresh Models**
- **FreeDeepseekAPI: Show Output Log**
- **FreeDeepseekAPI: Open Settings**

## Build / install

```powershell
cd vscode-extension
npm run package
code --install-extension freedeepseekapi-copilot-0.1.0.vsix
```

Then reload VS Code and pick a `deepseek-*` model from the **FreeDeepseekAPI** provider
in the Copilot Chat model picker.
