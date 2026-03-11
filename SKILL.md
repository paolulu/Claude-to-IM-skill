---
name: claude-to-im
description: |
  This skill bridges Claude Code to IM platforms (Telegram, Discord, Feishu/Lark, QQ).
  It should be used when the user wants to start a background daemon that forwards
  IM messages to Claude Code sessions, or manage that daemon's lifecycle.
  Trigger on: "claude-to-im", "start bridge", "stop bridge", "bridge status",
  "查看日志", "启动桥接", "停止桥接", or any mention of IM bridge management.
  Subcommands: setup, start, stop, status, logs, reconfigure, doctor.
  Supports named instances for running multiple bridges simultaneously.
argument-hint: "setup [instance] | start [instance] | stop [instance] | status | logs [instance] [N] | start-all | stop-all | reconfigure [instance] | doctor [instance]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
  - Grep
  - Glob
---

# Claude-to-IM Bridge Skill

You are managing the Claude-to-IM bridge.
User data is stored at `~/.claude-to-im/`.

First, locate the skill directory by finding this SKILL.md file:
- Use Glob with pattern `**/skills/**/claude-to-im/SKILL.md` to find its path, then derive the skill root directory from it.
- Store that path mentally as SKILL_DIR for all subsequent file references.

## Command parsing

Parse the user's intent from `$ARGUMENTS` into one of these subcommands.
Commands may include an optional **instance name** for multi-instance operation.

| User says (examples) | Subcommand | Instance |
|---|---|---|
| `setup`, `configure`, `配置` | setup | default |
| `setup project-a`, `配置 project-a` | setup | project-a |
| `start`, `start bridge`, `启动` | start | default |
| `start project-a`, `启动 project-a` | start | project-a |
| `stop`, `stop bridge`, `停止` | stop | default |
| `stop project-a` | stop | project-a |
| `status`, `bridge status`, `状态` | status-all | (all) |
| `status project-a` | status | project-a |
| `logs`, `logs 200`, `查看日志` | logs | default |
| `logs project-a`, `logs project-a 200` | logs | project-a |
| `start-all`, `启动全部` | start-all | (all) |
| `stop-all`, `停止全部` | stop-all | (all) |
| `reconfigure`, `修改配置` | reconfigure | default |
| `reconfigure project-a` | reconfigure | project-a |
| `doctor`, `diagnose`, `诊断` | doctor | default |
| `doctor project-a` | doctor | project-a |
| `admin`, `管理面板`, `web ui` | admin | (N/A) |

Extract optional numeric argument for `logs` (default 50).

**Instance name rules:** Only `[a-zA-Z0-9_-]` characters are allowed. "default" refers to the top-level config at `~/.claude-to-im/config.env`. Named instances are stored under `~/.claude-to-im/instances/<name>/`.

**IMPORTANT:** Before asking users for any platform credentials, first read `SKILL_DIR/references/setup-guides.md` to get the detailed step-by-step guidance for that platform. Present the relevant guide text to the user via AskUserQuestion so they know exactly what to do.

## Runtime detection

Before executing any subcommand, detect which environment you are running in:

1. **Claude Code** — `AskUserQuestion` tool is available. Use it for interactive setup wizards.
2. **Codex / other** — `AskUserQuestion` is NOT available. Fall back to non-interactive guidance: explain the steps, show `SKILL_DIR/config.env.example`, and ask the user to create `~/.claude-to-im/config.env` manually.

You can test this by checking if AskUserQuestion is in your available tools list.

## Config check (applies to `start`, `stop`, `status`, `logs`, `reconfigure`, `doctor`)

Before running any subcommand other than `setup`, determine the config path based on the instance:
- **default instance**: `~/.claude-to-im/config.env`
- **named instance**: `~/.claude-to-im/instances/<name>/config.env`

Check if the config file exists:

- **If it does NOT exist:**
  - In Claude Code: tell the user "No configuration found for instance <name>" and automatically start the `setup` wizard using AskUserQuestion.
  - In Codex: tell the user "No configuration found. Please create the config.env based on the example:" then show the contents of `SKILL_DIR/config.env.example` and stop. Do NOT attempt to start the daemon.
- **If it exists:** proceed with the requested subcommand.

## Subcommands

### `setup`

Run an interactive setup wizard. This subcommand requires `AskUserQuestion`. If it is not available (Codex environment), instead show the contents of `SKILL_DIR/config.env.example` with field-by-field explanations and instruct the user to create the config file manually.

When AskUserQuestion IS available, collect input **one field at a time**. After each answer, confirm the value back to the user (masking secrets to last 4 chars only) before moving to the next question.

**Step 0 — Instance name (if provided)**

If the user specified an instance name (e.g., `setup project-a`), use it. The config will be stored at `~/.claude-to-im/instances/<name>/config.env`. If no instance name is given, use the default instance (`~/.claude-to-im/config.env`).

Validate the instance name: only `[a-zA-Z0-9_-]` allowed. Reject "default" as an explicit name (it's implicit).

**Step 1 — Choose channels**

Ask which channels to enable (telegram, discord, feishu, qq). Accept comma-separated input. Briefly describe each:
- **telegram** — Best for personal use. Streaming preview, inline permission buttons.
- **discord** — Good for team use. Server/channel/user-level access control.
- **feishu** (Lark) — For Feishu/Lark teams. Event-based messaging.
- **qq** — QQ C2C private chat only. No inline permission buttons, no streaming preview. Permissions use text `/perm ...` commands.

**Step 2 — Collect tokens per channel**

For each enabled channel, read `SKILL_DIR/references/setup-guides.md` and present the relevant platform guide to the user. Collect one credential at a time:

- **Telegram**: Bot Token → confirm (masked) → Chat ID (see guide for how to get it) → confirm → Allowed User IDs (optional). **Important:** At least one of Chat ID or Allowed User IDs must be set, otherwise the bot will reject all messages.
- **Discord**: Bot Token → confirm (masked) → Allowed User IDs → Allowed Channel IDs (optional) → Allowed Guild IDs (optional). **Important:** At least one of Allowed User IDs or Allowed Channel IDs must be set, otherwise the bot will reject all messages (default-deny).
- **Feishu**: App ID → confirm → App Secret → confirm (masked) → Domain (optional) → Allowed User IDs (optional). Guide through all 4 steps (A: batch permissions, B: enable bot, C: events & callbacks with long connection, D: publish version).
- **QQ**: Collect two required fields, then optional ones:
  1. QQ App ID (required) → confirm
  2. QQ App Secret (required) → confirm (masked)
  - Tell the user: these two values can be found at https://q.qq.com/qqbot/openclaw
  3. Allowed User OpenIDs (optional, press Enter to skip) — note: this is `user_openid`, NOT QQ number. If the user doesn't have openid yet, they can leave it empty.
  4. Image Enabled (optional, default true, press Enter to skip) — if the underlying provider doesn't support image input, set to false
  5. Max Image Size MB (optional, default 20, press Enter to skip)
  - Remind user: QQ first version only supports C2C private chat sandbox access. No group/channel support, no inline buttons, no streaming preview.

**Step 3 — General settings**

Ask for runtime, default working directory, model, and mode:
- **Runtime**: `claude` (default), `codex`, `auto`
  - `claude` — uses Claude Code CLI + Claude Agent SDK (requires `claude` CLI installed)
  - `codex` — uses OpenAI Codex SDK (requires `codex` CLI; auth via `codex auth login` or `OPENAI_API_KEY`)
  - `auto` — tries Claude first, falls back to Codex if Claude CLI not found
- **Working Directory**: default `$CWD`
- **Model** (optional): Leave blank to inherit the runtime's own default model. If the user wants to override, ask them to enter a model name. Do NOT hardcode or suggest specific model names — the available models change over time.
- **Mode**: `code` (default), `plan`, `ask`

**Step 4 — Write config and validate**

1. Show a final summary table with all settings (secrets masked to last 4 chars). Include instance name if not default.
2. Ask user to confirm before writing
3. Use Bash to create directory structure: `mkdir -p <INSTANCE_HOME>/{data,logs,runtime,data/messages}` where INSTANCE_HOME is `~/.claude-to-im` for default or `~/.claude-to-im/instances/<name>` for named instances
4. Use Write to create `<INSTANCE_HOME>/config.env` with all settings in KEY=VALUE format
5. Use Bash to set permissions: `chmod 600 <INSTANCE_HOME>/config.env`
6. Validate tokens:
   - Telegram: `curl -s "https://api.telegram.org/bot${TOKEN}/getMe"` — check for `"ok":true`
   - Feishu: `curl -s -X POST "${DOMAIN}/open-apis/auth/v3/tenant_access_token/internal" -H "Content-Type: application/json" -d '{"app_id":"...","app_secret":"..."}'` — check for `"code":0`
   - Discord: verify token matches format `[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`
   - QQ: `POST https://bots.qq.com/app/getAppAccessToken` with `{"appId":"...","clientSecret":"..."}` — check for access_token in response; then `GET https://api.sgroup.qq.com/gateway` with `Authorization: QQBot <token>` — check for gateway URL
7. Report results with a summary table. If any validation fails, explain what might be wrong and how to fix it.
8. On success, tell the user: "Setup complete! Run `/claude-to-im start`" (or `/claude-to-im start <instance>` for named instances) "to start the bridge."

### `start`

**Pre-check:** Verify config.env exists for the target instance (see "Config check" above). Do NOT proceed without it.

Run: `bash "SKILL_DIR/scripts/daemon.sh" --instance <INSTANCE> start`

(Omit `--instance` flag for the default instance.)

Show the output to the user. If it fails, tell the user:
- Run `doctor` to diagnose: `/claude-to-im doctor <instance>`
- Check recent logs: `/claude-to-im logs <instance>`

### `stop`

Run: `bash "SKILL_DIR/scripts/daemon.sh" --instance <INSTANCE> stop`

### `status`

- **With instance name:** `bash "SKILL_DIR/scripts/daemon.sh" --instance <INSTANCE> status`
- **Without instance name:** `bash "SKILL_DIR/scripts/daemon.sh" status-all` (shows all instances)

### `start-all`

Run: `bash "SKILL_DIR/scripts/daemon.sh" start-all`

### `stop-all`

Run: `bash "SKILL_DIR/scripts/daemon.sh" stop-all`

### `logs`

Extract optional line count N from arguments (default 50).
Run: `bash "SKILL_DIR/scripts/daemon.sh" --instance <INSTANCE> logs N`

### `reconfigure`

1. Read current config from the target instance's config.env
2. Show current settings in a clear table format, with all secrets masked (only last 4 chars visible)
3. Use AskUserQuestion to ask what the user wants to change
4. When collecting new values, read `SKILL_DIR/references/setup-guides.md` and present the relevant guide for that field
5. Update the config file atomically (write to tmp, rename)
6. Re-validate any changed tokens
7. Remind user: "Run `/claude-to-im stop <instance>` then `/claude-to-im start <instance>` to apply the changes."

### `doctor`

Run: `bash "SKILL_DIR/scripts/doctor.sh" --instance <INSTANCE>`

(Omit `--instance` flag for the default instance.)

Show results and suggest fixes for any failures. Common fixes:
- SDK cli.js missing → `cd SKILL_DIR && npm install`
- dist/daemon.mjs stale → `cd SKILL_DIR && npm run build`
- Config missing → run `setup`

### `admin`

启动本地 Web 管理面板，在浏览器中管理所有桥接实例：

1. 构建：`cd SKILL_DIR && npm run build`
2. 运行：`node SKILL_DIR/dist/admin.mjs`
3. 面板自动在浏览器打开 `http://localhost:3247`

管理面板提供可视化界面，支持：新建/删除实例、编辑配置、启动/停止桥接、查看日志。

## Multi-instance architecture

Multiple bridge instances can run simultaneously, each with its own config, data, logs, and runtime:

```
~/.claude-to-im/                     # Default instance
  config.env
  data/ logs/ runtime/
  instances/                          # Named instances
    project-a/
      config.env
      data/ logs/ runtime/
    project-b/
      config.env
      data/ logs/ runtime/
```

Each named instance is an independent bridge with its own IM bot credentials and working directory. This allows connecting different Feishu/Telegram/Discord bots to different project directories.

## Notes

- Always mask secrets in output (show only last 4 characters)
- **Never start the daemon without a valid config.env** — always check first, redirect to setup or show config example
- The daemon runs as a background Node.js process managed by platform supervisor (launchd on macOS, setsid on Linux, WinSW/NSSM on Windows)
- Default instance config persists at `~/.claude-to-im/config.env`; named instances at `~/.claude-to-im/instances/<name>/config.env`
