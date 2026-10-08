import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WpRestClient } from "./clients/rest.js";
import { SshClient } from "./clients/ssh.js";
import type { Config } from "./config.js";
import { BackupStore } from "./safety/backup.js";
import { Guards } from "./safety/guards.js";

export interface Ctx {
  cfg: Config;
  rest: WpRestClient;
  ssh: SshClient;
  guards: Guards;
  backups: BackupStore;
}

export function createContext(cfg: Config): Ctx {
  return {
    cfg,
    rest: new WpRestClient(cfg),
    ssh: new SshClient(cfg),
    guards: new Guards(cfg),
    backups: new BackupStore(cfg.BACKUP_DIR),
  };
}

export type ToolModule = (server: McpServer, ctx: Ctx) => void;
