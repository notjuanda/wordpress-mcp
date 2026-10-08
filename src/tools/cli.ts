import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { shq } from "../clients/ssh.js";
import type { ToolModule } from "../context.js";
import { json, safe, ToolError } from "../lib/result.js";
import { classifyWpCli } from "../safety/guards.js";
import { redactSecrets } from "../safety/redact.js";

/** Divide un comando estilo shell respetando comillas simples y dobles (sin expansión). */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) tokens.push(cur);
      cur = "";
      has = false;
    } else if (ch === "\\" && i + 1 < command.length) {
      cur += command[++i];
      has = true;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) throw new ToolError("Comillas sin cerrar en el comando.");
  if (has || cur) tokens.push(cur);
  return tokens;
}

/** Flags que redirigen la instalación/host o hacen que WP-CLI evalúe otro archivo PHP de config. */
const FORBIDDEN_FLAGS = /^--(path|ssh|http|config-file|url-file)(=|$)/;
const CODE_EXEC_FLAGS = /^--(exec|require)(=|$)/;

/**
 * Valida tokens que deben ser slugs/identificadores (plugins, temas): nunca opciones de WP-CLI
 * (p. ej. "--exec=…"), alias ("@prod") ni rutas. Usado por las herramientas que construyen comandos `wp`.
 */
export function assertSlug(value: string, what: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) {
    throw new ToolError(`${what} inválido: "${value}". Solo letras, números, '.', '_' y '-' (sin empezar por '-').`);
  }
  return value;
}

export const registerCliTools: ToolModule = (server, ctx) => {
  server.registerTool(
    "wp_cli",
    {
      title: "Ejecutar WP-CLI",
      description:
        "Ejecuta un comando WP-CLI en el servidor (sin el prefijo 'wp'). Ejemplos: 'option get blogname', " +
        "'post meta get 12 _elementor_data', 'cache flush', 'rewrite flush', 'cron event list', " +
        "'search-replace http://viejo https://nuevo --dry-run'. Los comandos destructivos " +
        "(db reset/query/import, eval, search-replace sin --dry-run, delete…) requieren confirm=true. " +
        "No se permiten pipes ni operadores de shell: cada argumento se escapa.",
      inputSchema: {
        command: z.string().min(1).describe("Comando WP-CLI, p. ej. 'plugin list --status=active'"),
        confirm: z.boolean().optional(),
        timeout_seconds: z.number().int().min(5).max(900).default(120),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ command, confirm, timeout_seconds }) => {
      if (!ctx.ssh.enabled) throw new ToolError("WP-CLI requiere SSH. Configúralo en .env.");
      const args = tokenize(command.trim().replace(/^wp\s+/, ""));
      if (args.length === 0) throw new ToolError("Comando vacío.");
      const bad = args.find((a) => FORBIDDEN_FLAGS.test(a));
      if (bad) throw new ToolError(`Flag no permitido: ${bad} (la ruta/host se fijan desde la configuración).`);
      if (args.some((a) => a.startsWith("@"))) {
        throw new ToolError("No se permiten alias de WP-CLI (@…): el destino lo fija la configuración.");
      }

      const { dangerous, readOnly } = classifyWpCli(args);
      const execsCode = args.some((a) => CODE_EXEC_FLAGS.test(a));
      if (!readOnly || execsCode) ctx.guards.assertWritable(`wp ${args.join(" ")}`);
      if (dangerous || execsCode) ctx.guards.assertConfirmed(confirm, `wp ${args.join(" ")}`);

      const r = await ctx.ssh.wp(args, timeout_seconds * 1000);
      const clean = (s: string) => (ctx.cfg.REDACT_SECRETS ? redactSecrets(s) : s);
      return json({
        command: `wp ${args.join(" ")}`,
        exit_code: r.code,
        stdout: clean(r.stdout),
        stderr: r.stderr ? clean(r.stderr) : undefined,
      });
    }),
  );

  server.registerTool(
    "wp_db_backup",
    {
      title: "Copia de seguridad de la base de datos",
      description:
        "Exporta la base de datos (gzip) a ~/wp-mcp-backups en el servidor (FUERA de public_html) y, por defecto, la descarga a la carpeta local de backups. " +
        "Hazlo antes de cambios grandes (actualizaciones, search-replace…).",
      inputSchema: {
        download: z.boolean().default(true),
        keep_remote: z.boolean().default(false).describe("Conservar también la copia en el servidor"),
      },
      // Crea y borra archivos (servidor y local): no es de solo lectura.
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    safe(async ({ download, keep_remote }) => {
      if (!ctx.ssh.enabled) throw new ToolError("Requiere SSH.");
      ctx.guards.assertWritable("copia de seguridad de la base de datos");
      const remoteDir = await ctx.ssh.privateDir("wp-mcp-backups");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const remote = `${remoteDir}/db-${stamp}.sql.gz`;
      const root = shq(ctx.cfg.WP_ROOT!);
      const cmd =
        `set -o pipefail; umask 077; cd ${root} && ` +
        `${ctx.cfg.WP_CLI_BIN} db export - --path=${root} --no-color | gzip > ${shq(remote)}`;
      const r = await ctx.ssh.exec(`bash -c ${shq(cmd)}`, 900_000);
      if (r.code !== 0) throw new ToolError(`Falló la exportación:\n${r.stderr || r.stdout}`);

      const result: Record<string, unknown> = { remote_file: remote };
      if (download) {
        const localDir = path.join(ctx.cfg.BACKUP_DIR, "db");
        await mkdir(localDir, { recursive: true, mode: 0o700 });
        const local = path.join(localDir, path.posix.basename(remote));
        try {
          await ctx.ssh.download(remote, local);
          result.local_file = local;
          result.size_bytes = (await stat(local)).size;
        } finally {
          // Si la descarga falla tampoco se deja el volcado en el servidor (salvo keep_remote).
          if (!keep_remote) {
            await ctx.ssh.unlink(remote).catch(() => undefined);
            result.remote_file = "(eliminado)";
          }
        }
      }
      return json(result);
    }),
  );
};
