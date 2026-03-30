import dotenv from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  matrix: {
    homeserverUrl: string;
    accessToken: string;
    botUserId: string;
    ownerUserId: string;
  };
  claude: {
    model: string;
    defaultWorkDir: string;
  };
  ports: {
    start: number;
    end: number;
  };
  database: {
    path: string;
  };
  logLevel: string;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    process.stderr.write(`Missing required environment variable: ${key}\n`);
    process.exit(1);
  }
  return value;
}

export function loadConfig(): Config {
  // Load .env from repo root (two levels up from packages/supervisor/)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(__dirname, "..", "..", "..");
  dotenv.config({ path: resolve(repoRoot, ".env") });

  return {
    matrix: {
      homeserverUrl: requireEnv("MATRIX_HOMESERVER_URL"),
      accessToken: requireEnv("MATRIX_ACCESS_TOKEN"),
      botUserId: requireEnv("MATRIX_BOT_USER_ID"),
      ownerUserId: requireEnv("MATRIX_OWNER_USER_ID"),
    },
    claude: {
      model: process.env.CLAUDE_MODEL ?? "sonnet",
      defaultWorkDir: process.env.CLAUDE_DEFAULT_WORKDIR ?? process.cwd(),
    },
    ports: {
      start: Number(process.env.RELAY_PORT_START ?? 9000),
      end: Number(process.env.RELAY_PORT_END ?? 9015),
    },
    database: {
      path: process.env.DATABASE_PATH ?? "./data/bot.db",
    },
    logLevel: process.env.LOG_LEVEL ?? "info",
  };
}
