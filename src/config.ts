import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  runtime: 'claude' | 'codex' | 'auto';
  enabledChannels: string[];
  defaultWorkDir: string;
  defaultModel?: string;
  defaultMode: string;
  // Telegram
  tgBotToken?: string;
  tgChatId?: string;
  tgAllowedUsers?: string[];
  // Feishu
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuDomain?: string;
  feishuAllowedUsers?: string[];
  // Discord
  discordBotToken?: string;
  discordAllowedUsers?: string[];
  discordAllowedChannels?: string[];
  discordAllowedGuilds?: string[];
  // QQ
  qqAppId?: string;
  qqAppSecret?: string;
  qqAllowedUsers?: string[];
  qqImageEnabled?: boolean;
  qqMaxImageSize?: number;
  // Auto-approve all tool permission requests without user confirmation
  autoApprove?: boolean;
}

export const CTI_HOME = process.env.CTI_HOME || path.join(os.homedir(), ".claude-to-im");

// ── Multi-instance support ──

const INSTANCE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Validate an instance name (alphanumeric, hyphens, underscores only). */
export function validateInstanceName(name: string): boolean {
  if (!name || name === "default") return false;
  return INSTANCE_NAME_RE.test(name);
}

/** Resolve the home directory for a named instance (or the default). */
export function resolveInstanceHome(instanceName?: string): string {
  if (!instanceName || instanceName === "default") return CTI_HOME;
  return path.join(CTI_HOME, "instances", instanceName);
}

/** List all known instances by scanning the instances/ directory. */
export function listInstances(): string[] {
  const instances: string[] = [];
  // Check if the default instance has a config
  if (fs.existsSync(path.join(CTI_HOME, "config.env"))) {
    instances.push("default");
  }
  const instancesDir = path.join(CTI_HOME, "instances");
  if (fs.existsSync(instancesDir)) {
    for (const entry of fs.readdirSync(instancesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(instancesDir, entry.name, "config.env"))) {
        instances.push(entry.name);
      }
    }
  }
  return instances;
}

/** The active instance name (from CTI_INSTANCE env var). */
export const CTI_INSTANCE = process.env.CTI_INSTANCE || "";

/** The resolved home directory for the active instance. */
export const INSTANCE_HOME = resolveInstanceHome(CTI_INSTANCE || undefined);

export const CONFIG_PATH = path.join(INSTANCE_HOME, "config.env");

function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Load config from an explicit instance home directory. */
export function loadConfigFrom(instanceHome: string): Config {
  const configPath = path.join(instanceHome, "config.env");
  let env = new Map<string, string>();
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    env = parseEnvFile(content);
  } catch {
    // Config file doesn't exist yet — use defaults
  }

  const rawRuntime = env.get("CTI_RUNTIME") || "claude";
  const runtime = (["claude", "codex", "auto"].includes(rawRuntime) ? rawRuntime : "claude") as Config["runtime"];

  return {
    runtime,
    enabledChannels: splitCsv(env.get("CTI_ENABLED_CHANNELS")) ?? [],
    defaultWorkDir: env.get("CTI_DEFAULT_WORKDIR") || process.cwd(),
    defaultModel: env.get("CTI_DEFAULT_MODEL") || undefined,
    defaultMode: env.get("CTI_DEFAULT_MODE") || "code",
    tgBotToken: env.get("CTI_TG_BOT_TOKEN") || undefined,
    tgChatId: env.get("CTI_TG_CHAT_ID") || undefined,
    tgAllowedUsers: splitCsv(env.get("CTI_TG_ALLOWED_USERS")),
    feishuAppId: env.get("CTI_FEISHU_APP_ID") || undefined,
    feishuAppSecret: env.get("CTI_FEISHU_APP_SECRET") || undefined,
    feishuDomain: env.get("CTI_FEISHU_DOMAIN") || undefined,
    feishuAllowedUsers: splitCsv(env.get("CTI_FEISHU_ALLOWED_USERS")),
    discordBotToken: env.get("CTI_DISCORD_BOT_TOKEN") || undefined,
    discordAllowedUsers: splitCsv(env.get("CTI_DISCORD_ALLOWED_USERS")),
    discordAllowedChannels: splitCsv(
      env.get("CTI_DISCORD_ALLOWED_CHANNELS")
    ),
    discordAllowedGuilds: splitCsv(env.get("CTI_DISCORD_ALLOWED_GUILDS")),
    qqAppId: env.get("CTI_QQ_APP_ID") || undefined,
    qqAppSecret: env.get("CTI_QQ_APP_SECRET") || undefined,
    qqAllowedUsers: splitCsv(env.get("CTI_QQ_ALLOWED_USERS")),
    qqImageEnabled: env.has("CTI_QQ_IMAGE_ENABLED")
      ? env.get("CTI_QQ_IMAGE_ENABLED") === "true"
      : undefined,
    qqMaxImageSize: env.get("CTI_QQ_MAX_IMAGE_SIZE")
      ? Number(env.get("CTI_QQ_MAX_IMAGE_SIZE"))
      : undefined,
    autoApprove: env.get("CTI_AUTO_APPROVE") === "true",
  };
}

export function loadConfig(): Config {
  return loadConfigFrom(INSTANCE_HOME);
}

function formatEnvLine(key: string, value: string | undefined): string {
  if (value === undefined || value === "") return "";
  // Quote values to handle spaces and special characters
  return `${key}="${value}"\n`;
}

/** Save config to an explicit instance home directory. */
export function saveConfigTo(config: Config, instanceHome: string): void {
  let out = "";
  out += formatEnvLine("CTI_RUNTIME", config.runtime);
  out += formatEnvLine(
    "CTI_ENABLED_CHANNELS",
    config.enabledChannels.join(",")
  );
  out += formatEnvLine("CTI_DEFAULT_WORKDIR", config.defaultWorkDir);
  if (config.defaultModel) out += formatEnvLine("CTI_DEFAULT_MODEL", config.defaultModel);
  out += formatEnvLine("CTI_DEFAULT_MODE", config.defaultMode);
  out += formatEnvLine("CTI_TG_BOT_TOKEN", config.tgBotToken);
  out += formatEnvLine("CTI_TG_CHAT_ID", config.tgChatId);
  out += formatEnvLine(
    "CTI_TG_ALLOWED_USERS",
    config.tgAllowedUsers?.join(",")
  );
  out += formatEnvLine("CTI_FEISHU_APP_ID", config.feishuAppId);
  out += formatEnvLine("CTI_FEISHU_APP_SECRET", config.feishuAppSecret);
  out += formatEnvLine("CTI_FEISHU_DOMAIN", config.feishuDomain);
  out += formatEnvLine(
    "CTI_FEISHU_ALLOWED_USERS",
    config.feishuAllowedUsers?.join(",")
  );
  out += formatEnvLine("CTI_DISCORD_BOT_TOKEN", config.discordBotToken);
  out += formatEnvLine(
    "CTI_DISCORD_ALLOWED_USERS",
    config.discordAllowedUsers?.join(",")
  );
  out += formatEnvLine(
    "CTI_DISCORD_ALLOWED_CHANNELS",
    config.discordAllowedChannels?.join(",")
  );
  out += formatEnvLine(
    "CTI_DISCORD_ALLOWED_GUILDS",
    config.discordAllowedGuilds?.join(",")
  );
  out += formatEnvLine("CTI_QQ_APP_ID", config.qqAppId);
  out += formatEnvLine("CTI_QQ_APP_SECRET", config.qqAppSecret);
  out += formatEnvLine(
    "CTI_QQ_ALLOWED_USERS",
    config.qqAllowedUsers?.join(",")
  );
  if (config.qqImageEnabled !== undefined)
    out += formatEnvLine("CTI_QQ_IMAGE_ENABLED", String(config.qqImageEnabled));
  if (config.qqMaxImageSize !== undefined)
    out += formatEnvLine("CTI_QQ_MAX_IMAGE_SIZE", String(config.qqMaxImageSize));

  const configPath = path.join(instanceHome, "config.env");
  fs.mkdirSync(instanceHome, { recursive: true });
  const tmpPath = configPath + ".tmp";
  fs.writeFileSync(tmpPath, out, { mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
}

export function saveConfig(config: Config): void {
  saveConfigTo(config, INSTANCE_HOME);
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  return "*".repeat(value.length - 4) + value.slice(-4);
}

export function configToSettings(config: Config): Map<string, string> {
  const m = new Map<string, string>();
  m.set("remote_bridge_enabled", "true");

  // ── Telegram ──
  // Upstream keys: telegram_bot_token, bridge_telegram_enabled,
  //   telegram_bridge_allowed_users, telegram_chat_id
  m.set(
    "bridge_telegram_enabled",
    config.enabledChannels.includes("telegram") ? "true" : "false"
  );
  if (config.tgBotToken) m.set("telegram_bot_token", config.tgBotToken);
  if (config.tgAllowedUsers)
    m.set("telegram_bridge_allowed_users", config.tgAllowedUsers.join(","));
  if (config.tgChatId) m.set("telegram_chat_id", config.tgChatId);

  // ── Discord ──
  // Upstream keys: bridge_discord_bot_token, bridge_discord_enabled,
  //   bridge_discord_allowed_users, bridge_discord_allowed_channels,
  //   bridge_discord_allowed_guilds
  m.set(
    "bridge_discord_enabled",
    config.enabledChannels.includes("discord") ? "true" : "false"
  );
  if (config.discordBotToken)
    m.set("bridge_discord_bot_token", config.discordBotToken);
  if (config.discordAllowedUsers)
    m.set("bridge_discord_allowed_users", config.discordAllowedUsers.join(","));
  if (config.discordAllowedChannels)
    m.set(
      "bridge_discord_allowed_channels",
      config.discordAllowedChannels.join(",")
    );
  if (config.discordAllowedGuilds)
    m.set(
      "bridge_discord_allowed_guilds",
      config.discordAllowedGuilds.join(",")
    );

  // ── Feishu ──
  // Upstream keys: bridge_feishu_app_id, bridge_feishu_app_secret,
  //   bridge_feishu_domain, bridge_feishu_enabled, bridge_feishu_allowed_users
  m.set(
    "bridge_feishu_enabled",
    config.enabledChannels.includes("feishu") ? "true" : "false"
  );
  if (config.feishuAppId) m.set("bridge_feishu_app_id", config.feishuAppId);
  if (config.feishuAppSecret)
    m.set("bridge_feishu_app_secret", config.feishuAppSecret);
  if (config.feishuDomain) m.set("bridge_feishu_domain", config.feishuDomain);
  if (config.feishuAllowedUsers)
    m.set("bridge_feishu_allowed_users", config.feishuAllowedUsers.join(","));

  // ── QQ ──
  // Upstream keys: bridge_qq_enabled, bridge_qq_app_id, bridge_qq_app_secret,
  //   bridge_qq_allowed_users, bridge_qq_image_enabled, bridge_qq_max_image_size
  m.set(
    "bridge_qq_enabled",
    config.enabledChannels.includes("qq") ? "true" : "false"
  );
  if (config.qqAppId) m.set("bridge_qq_app_id", config.qqAppId);
  if (config.qqAppSecret) m.set("bridge_qq_app_secret", config.qqAppSecret);
  if (config.qqAllowedUsers)
    m.set("bridge_qq_allowed_users", config.qqAllowedUsers.join(","));
  if (config.qqImageEnabled !== undefined)
    m.set("bridge_qq_image_enabled", String(config.qqImageEnabled));
  if (config.qqMaxImageSize !== undefined)
    m.set("bridge_qq_max_image_size", String(config.qqMaxImageSize));

  // ── Defaults ──
  // Upstream keys: bridge_default_work_dir, bridge_default_model, default_model
  m.set("bridge_default_work_dir", config.defaultWorkDir);
  if (config.defaultModel) {
    m.set("bridge_default_model", config.defaultModel);
    m.set("default_model", config.defaultModel);
  }
  m.set("bridge_default_mode", config.defaultMode);

  return m;
}
