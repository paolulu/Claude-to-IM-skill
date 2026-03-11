import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { URL } from "node:url";
import os from "node:os";

import {
  loadConfigFrom,
  saveConfigTo,
  maskSecret,
  validateInstanceName,
  resolveInstanceHome,
  listInstances,
  CTI_HOME,
  type Config,
} from "./config.js";

// ── Path constants ──

const SKILL_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const HTML_PATH = path.join(SKILL_DIR, "src", "admin-ui.html");
const DAEMON_SH = path.join(SKILL_DIR, "scripts", "daemon.sh");

// ── Secret fields that must be masked in API responses ──

const SECRET_FIELDS: (keyof Config)[] = [
  "tgBotToken",
  "feishuAppSecret",
  "discordBotToken",
  "qqAppSecret",
];

// ── Helpers ──

interface InstanceStatus {
  status: "running" | "stopped";
  pid?: number;
  startedAt?: string;
}

function getInstanceStatus(instanceHome: string): InstanceStatus {
  const statusPath = path.join(instanceHome, "runtime", "status.json");
  const pidPath = path.join(instanceHome, "runtime", "bridge.pid");

  let statusData: Record<string, unknown> = {};
  try {
    statusData = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
  } catch {
    // no status file
  }

  let pid: number | undefined;
  try {
    pid = Number(fs.readFileSync(pidPath, "utf-8").trim());
  } catch {
    // no pid file
  }

  // Check if process is actually alive
  let alive = false;
  if (pid) {
    try {
      process.kill(pid, 0); // signal 0 = existence check
      alive = true;
    } catch {
      alive = false;
    }
  }

  return {
    status: alive ? "running" : "stopped",
    pid: alive ? pid : undefined,
    startedAt: alive ? (statusData.startedAt as string | undefined) : undefined,
  };
}

function maskConfig(config: Config): Config {
  const masked = { ...config };
  for (const field of SECRET_FIELDS) {
    const val = masked[field];
    if (typeof val === "string" && val) {
      (masked as Record<string, unknown>)[field] = maskSecret(val);
    }
  }
  return masked;
}

// ── UI ↔ Config format conversion ──
// The frontend sends nested format; the backend uses flat Config.

interface UIPayload {
  name?: string;
  channels?: string[];
  runtime?: string;
  workDir?: string;
  model?: string;
  mode?: string;
  telegram?: { botToken?: string; chatId?: string; allowedUsers?: string[] };
  discord?: { botToken?: string; allowedUsers?: string[]; allowedChannels?: string[]; allowedGuilds?: string[] };
  feishu?: { appId?: string; appSecret?: string; domain?: string; allowedUsers?: string[] };
  qq?: { appId?: string; appSecret?: string; allowedUsers?: string[]; imageEnabled?: boolean; maxImageSize?: number };
}

/** Convert frontend nested payload → flat Config fields. */
function uiToConfig(ui: UIPayload): Partial<Config> {
  const cfg: Partial<Config> = {};
  if (ui.channels) cfg.enabledChannels = ui.channels;
  if (ui.runtime) cfg.runtime = ui.runtime as Config["runtime"];
  if (ui.workDir) cfg.defaultWorkDir = ui.workDir;
  if (ui.model !== undefined) cfg.defaultModel = ui.model || undefined;
  if (ui.mode) cfg.defaultMode = ui.mode;

  if (ui.telegram) {
    if (ui.telegram.botToken) cfg.tgBotToken = ui.telegram.botToken;
    if (ui.telegram.chatId) cfg.tgChatId = ui.telegram.chatId;
    if (ui.telegram.allowedUsers) cfg.tgAllowedUsers = ui.telegram.allowedUsers;
  }
  if (ui.discord) {
    if (ui.discord.botToken) cfg.discordBotToken = ui.discord.botToken;
    if (ui.discord.allowedUsers) cfg.discordAllowedUsers = ui.discord.allowedUsers;
    if (ui.discord.allowedChannels) cfg.discordAllowedChannels = ui.discord.allowedChannels;
    if (ui.discord.allowedGuilds) cfg.discordAllowedGuilds = ui.discord.allowedGuilds;
  }
  if (ui.feishu) {
    if (ui.feishu.appId) cfg.feishuAppId = ui.feishu.appId;
    if (ui.feishu.appSecret) cfg.feishuAppSecret = ui.feishu.appSecret;
    if (ui.feishu.domain) cfg.feishuDomain = ui.feishu.domain;
    if (ui.feishu.allowedUsers) cfg.feishuAllowedUsers = ui.feishu.allowedUsers;
  }
  if (ui.qq) {
    if (ui.qq.appId) cfg.qqAppId = ui.qq.appId;
    if (ui.qq.appSecret) cfg.qqAppSecret = ui.qq.appSecret;
    if (ui.qq.allowedUsers) cfg.qqAllowedUsers = ui.qq.allowedUsers;
    if (ui.qq.imageEnabled !== undefined) cfg.qqImageEnabled = ui.qq.imageEnabled;
    if (ui.qq.maxImageSize !== undefined) cfg.qqMaxImageSize = ui.qq.maxImageSize;
  }
  return cfg;
}

/** Convert flat Config → frontend nested format for API responses. */
function configToUI(config: Config): Record<string, unknown> {
  const ui: Record<string, unknown> = {
    channels: config.enabledChannels,
    runtime: config.runtime,
    workDir: config.defaultWorkDir,
    model: config.defaultModel || "",
    mode: config.defaultMode,
  };
  if (config.enabledChannels.includes("telegram") || config.tgBotToken) {
    ui.telegram = {
      botToken: config.tgBotToken || "",
      chatId: config.tgChatId || "",
      allowedUsers: config.tgAllowedUsers || [],
    };
  }
  if (config.enabledChannels.includes("discord") || config.discordBotToken) {
    ui.discord = {
      botToken: config.discordBotToken || "",
      allowedUsers: config.discordAllowedUsers || [],
      allowedChannels: config.discordAllowedChannels || [],
      allowedGuilds: config.discordAllowedGuilds || [],
    };
  }
  if (config.enabledChannels.includes("feishu") || config.feishuAppId) {
    ui.feishu = {
      appId: config.feishuAppId || "",
      appSecret: config.feishuAppSecret || "",
      domain: config.feishuDomain || "",
      allowedUsers: config.feishuAllowedUsers || [],
    };
  }
  if (config.enabledChannels.includes("qq") || config.qqAppId) {
    ui.qq = {
      appId: config.qqAppId || "",
      appSecret: config.qqAppSecret || "",
      allowedUsers: config.qqAllowedUsers || [],
      imageEnabled: config.qqImageEnabled ?? true,
      maxImageSize: config.qqMaxImageSize ?? 20,
    };
  }
  return ui;
}

/** Build API response object for an instance. */
function instanceResponse(name: string, config: Config, instanceHome: string) {
  const status = getInstanceStatus(instanceHome);
  return {
    name,
    config: configToUI(maskConfig(config)),
    ...status,
  };
}

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(
  res: http.ServerResponse,
  data: unknown,
  status = 200,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function execDaemon(
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("bash", [DAEMON_SH, ...args], (_err, stdout, stderr) => {
      // Don't reject on non-zero exit — daemon.sh returns 1 for
      // "already running", "already stopped", etc. which are not errors.
      resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

// ── Route handler ──

async function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const parsedUrl = new URL(req.url || "/", "http://localhost:3247");
  const pathname = parsedUrl.pathname;
  const method = req.method || "GET";

  try {
    // ── Favicon ──
    if (method === "GET" && pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Serve HTML UI ──
    if (method === "GET" && pathname === "/") {
      let html: string;
      try {
        html = fs.readFileSync(HTML_PATH, "utf-8");
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("admin-ui.html not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // ── GET /api/instances ──
    if (method === "GET" && pathname === "/api/instances") {
      const names = listInstances();
      const instances = names.map((name) => {
        const home = resolveInstanceHome(name === "default" ? undefined : name);
        const config = loadConfigFrom(home);
        return instanceResponse(name, config, home);
      });
      sendJson(res, instances);
      return;
    }

    // ── POST /api/instances ──
    if (method === "POST" && pathname === "/api/instances") {
      const body = (await parseBody(req)) as UIPayload & { name?: string };
      const name = body.name as string;

      if (!name) {
        sendJson(res, { error: "name is required" }, 400);
        return;
      }
      if (name !== "default" && !validateInstanceName(name)) {
        sendJson(
          res,
          { error: "Invalid instance name. Use alphanumeric, hyphens, underscores only." },
          400,
        );
        return;
      }

      const instanceHome = resolveInstanceHome(
        name === "default" ? undefined : name,
      );

      // Check if already exists
      if (fs.existsSync(path.join(instanceHome, "config.env"))) {
        sendJson(res, { error: `Instance '${name}' already exists` }, 409);
        return;
      }

      // Create directory structure
      for (const sub of ["data", "logs", "runtime", "data/messages"]) {
        fs.mkdirSync(path.join(instanceHome, sub), { recursive: true });
      }

      // Convert UI payload → Config
      const configPart = uiToConfig(body);
      const config: Config = {
        runtime: configPart.runtime || "claude",
        enabledChannels: configPart.enabledChannels || [],
        defaultWorkDir: configPart.defaultWorkDir || process.cwd(),
        defaultModel: configPart.defaultModel,
        defaultMode: configPart.defaultMode || "code",
        tgBotToken: configPart.tgBotToken,
        tgChatId: configPart.tgChatId,
        tgAllowedUsers: configPart.tgAllowedUsers,
        feishuAppId: configPart.feishuAppId,
        feishuAppSecret: configPart.feishuAppSecret,
        feishuDomain: configPart.feishuDomain,
        feishuAllowedUsers: configPart.feishuAllowedUsers,
        discordBotToken: configPart.discordBotToken,
        discordAllowedUsers: configPart.discordAllowedUsers,
        discordAllowedChannels: configPart.discordAllowedChannels,
        discordAllowedGuilds: configPart.discordAllowedGuilds,
        qqAppId: configPart.qqAppId,
        qqAppSecret: configPart.qqAppSecret,
        qqAllowedUsers: configPart.qqAllowedUsers,
        qqImageEnabled: configPart.qqImageEnabled,
        qqMaxImageSize: configPart.qqMaxImageSize,
      };

      saveConfigTo(config, instanceHome);
      sendJson(res, instanceResponse(name, config, instanceHome), 201);
      return;
    }

    // ── Instance-specific routes: /api/instances/:name[/action] ──
    const instanceMatch = pathname.match(
      /^\/api\/instances\/([^/]+)(\/.*)?$/,
    );
    if (instanceMatch) {
      const name = decodeURIComponent(instanceMatch[1]);
      const action = instanceMatch[2] || "";

      // Validate the instance name exists (or is a valid new name)
      const instanceHome = resolveInstanceHome(
        name === "default" ? undefined : name,
      );
      const configExists = fs.existsSync(
        path.join(instanceHome, "config.env"),
      );

      // ── GET /api/instances/:name ──
      if (method === "GET" && action === "") {
        if (!configExists) {
          sendJson(res, { error: `Instance '${name}' not found` }, 404);
          return;
        }
        const config = loadConfigFrom(instanceHome);
        sendJson(res, instanceResponse(name, config, instanceHome));
        return;
      }

      // ── PUT /api/instances/:name ──
      if (method === "PUT" && action === "") {
        if (!configExists) {
          sendJson(res, { error: `Instance '${name}' not found` }, 404);
          return;
        }
        const body = (await parseBody(req)) as UIPayload;
        const existing = loadConfigFrom(instanceHome);
        const updates = uiToConfig(body);

        // Merge updates into existing config, preserving secrets when not provided
        const merged: Config = { ...existing };
        for (const key of Object.keys(updates) as (keyof Config)[]) {
          const newVal = updates[key];

          // For secret fields: keep existing value if new value is empty or masked
          if (SECRET_FIELDS.includes(key)) {
            if (
              typeof newVal === "string" &&
              (newVal === "" || newVal.startsWith("****"))
            ) {
              continue; // keep existing
            }
          }

          if (newVal !== undefined) {
            (merged as unknown as Record<string, unknown>)[key] = newVal;
          }
        }

        // Always update enabledChannels from UI payload
        if (body.channels) {
          merged.enabledChannels = body.channels;
        }

        saveConfigTo(merged, instanceHome);
        sendJson(res, instanceResponse(name, merged, instanceHome));
        return;
      }

      // ── DELETE /api/instances/:name ──
      if (method === "DELETE" && action === "") {
        if (!configExists) {
          sendJson(res, { error: `Instance '${name}' not found` }, 404);
          return;
        }

        // Stop the instance first
        try {
          await execDaemon(["--instance", name, "stop"]);
        } catch {
          // may already be stopped
        }

        if (name === "default") {
          // For default instance, only delete config.env (not the whole CTI_HOME)
          const configPath = path.join(instanceHome, "config.env");
          try {
            fs.unlinkSync(configPath);
          } catch {
            // ignore
          }
        } else {
          // Remove the entire instance directory
          fs.rmSync(instanceHome, { recursive: true, force: true });
        }

        sendJson(res, { ok: true });
        return;
      }

      // ── POST /api/instances/:name/start ──
      if (method === "POST" && action === "/start") {
        if (!configExists) {
          sendJson(res, { error: `Instance '${name}' not found` }, 404);
          return;
        }
        try {
          const { stdout, stderr } = await execDaemon([
            "--instance",
            name,
            "start",
          ]);
          sendJson(res, { ok: true, stdout: stdout.trim(), stderr: stderr.trim() });
        } catch (err: unknown) {
          const message =
            err instanceof Error ? err.message : String(err);
          sendJson(res, { error: `Failed to start: ${message}` }, 500);
        }
        return;
      }

      // ── POST /api/instances/:name/stop ──
      if (method === "POST" && action === "/stop") {
        if (!configExists) {
          sendJson(res, { error: `Instance '${name}' not found` }, 404);
          return;
        }
        try {
          const { stdout, stderr } = await execDaemon([
            "--instance",
            name,
            "stop",
          ]);
          sendJson(res, { ok: true, stdout: stdout.trim(), stderr: stderr.trim() });
        } catch (err: unknown) {
          const message =
            err instanceof Error ? err.message : String(err);
          sendJson(res, { error: `Failed to stop: ${message}` }, 500);
        }
        return;
      }

      // ── GET /api/instances/:name/logs?lines=50 ──
      if (method === "GET" && action === "/logs") {
        if (!configExists) {
          sendJson(res, { error: `Instance '${name}' not found` }, 404);
          return;
        }
        const lines = Number(parsedUrl.searchParams.get("lines")) || 50;
        const logPath = path.join(instanceHome, "logs", "bridge.log");

        let logContent = "";
        try {
          const raw = fs.readFileSync(logPath, "utf-8");
          const allLines = raw.split("\n");
          const tail = allLines.slice(-lines);
          logContent = tail.join("\n");
        } catch {
          logContent = "(no logs yet)";
        }

        sendJson(res, { name, lines: logContent });
        return;
      }
    }

    // ── 404 ──
    sendJson(res, { error: "Not found" }, 404);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Admin API error:", message);
    sendJson(res, { error: message }, 500);
  }
}

// ── Start server ──

const server = http.createServer(route);
server.listen(3247, "127.0.0.1", () => {
  console.log("Admin panel: http://localhost:3247");
  if (process.platform === "darwin") {
    execFile("open", ["http://localhost:3247"]);
  }
});
