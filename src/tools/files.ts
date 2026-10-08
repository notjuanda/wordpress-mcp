import { z } from "zod";
import { shq } from "../clients/ssh.js";
import type { Ctx, ToolModule } from "../context.js";
import { exactReplace, unifiedDiff } from "../lib/diff.js";
import { json, safe, text, ToolError } from "../lib/result.js";
import { isSensitiveFile, redactSecrets } from "../safety/redact.js";

const MAX_READ_BYTES = 2 * 1024 * 1024;
const REDACTED_MARK = "***REDACTADO***";

const pathArg = z.string().describe("Ruta relativa a la raíz de WordPress (p. ej. 'wp-content/themes/mi-tema/functions.php') o absoluta dentro de ella");

function maybeRedact(ctx: Ctx, rel: string, content: string): string {
  return ctx.cfg.REDACT_SECRETS && isSensitiveFile(rel) ? redactSecrets(content) : content;
}

function requireSsh(ctx: Ctx): void {
  if (!ctx.ssh.enabled) throw new ToolError("Las herramientas de archivos requieren SSH. Configúralo en .env.");
}

/** Resolución léxica (dentro de WP_ROOT) + resolución real en el servidor (symlinks). */
async function resolvePath(ctx: Ctx, input: string): Promise<{ abs: string; rel: string }> {
  requireSsh(ctx);
  const { abs } = ctx.guards.resolveRemote(input);
  return { abs, rel: await ctx.ssh.realRelPath(abs) };
}

/**
 * Escritura segura: valida ruta permitida → copia local del original → escribe →
 * si es PHP, `php -l` y rollback automático si hay error de sintaxis.
 */
async function safeWrite(ctx: Ctx, input: string, next: string, reason: string) {
  const { abs, rel } = await resolvePath(ctx, input);
  ctx.guards.assertWritablePath(rel);
  if (isSensitiveFile(rel) && next.includes(REDACTED_MARK)) {
    throw new ToolError(`El contenido contiene "${REDACTED_MARK}": escribirlo destruiría secretos reales. Usa fs_edit_file con fragmentos concretos.`);
  }

  const st = await ctx.ssh.stat(abs);
  if (st?.isDirectory()) throw new ToolError(`${rel} es un directorio.`);
  const previous = st ? await ctx.ssh.readFile(abs) : null;
  const backup = await ctx.backups.save(abs, previous, reason);

  await ctx.ssh.writeFile(abs, Buffer.from(next, "utf8"));

  if (abs.endsWith(".php")) {
    const lint = await ctx.ssh.exec(`php -l ${shq(abs)}`);
    if (lint.code !== 0) {
      if (previous) await ctx.ssh.writeFile(abs, previous);
      else await ctx.ssh.unlink(abs);
      throw new ToolError(
        `Error de sintaxis PHP: el cambio se ha REVERTIDO automáticamente para no romper el sitio.\n${(lint.stdout + lint.stderr).trim()}`,
      );
    }
  }

  const before = previous?.toString("utf8") ?? "";
  return {
    path: rel,
    created: !previous,
    backup_id: backup.id,
    php_lint: abs.endsWith(".php") ? "ok" : undefined,
    diff: maybeRedact(ctx, rel, unifiedDiff(rel, before, next)),
  };
}

export const registerFileTools: ToolModule = (server, ctx) => {
  server.registerTool(
    "fs_list",
    {
      title: "Listar directorio",
      description: "Lista archivos y carpetas de la instalación de WordPress. depth>1 recorre subcarpetas (ignora node_modules y .git).",
      inputSchema: { path: pathArg.default("wp-content"), depth: z.number().int().min(1).max(6).default(1) },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ path, depth }) => {
      requireSsh(ctx);
      const { abs, rel } = await resolvePath(ctx, path);
      if (depth === 1) return json({ path: rel || ".", entries: await ctx.ssh.readdir(abs) });
      const r = await ctx.ssh.exec(
        `find ${shq(abs)} -mindepth 1 -maxdepth ${depth} \\( -name node_modules -o -name .git \\) -prune -o ` +
          `-printf '%y\\t%s\\t%TY-%Tm-%Td %TH:%TM\\t%P\\n' | sort -k4 | head -n 2000`,
      );
      if (r.code !== 0) throw new ToolError(r.stderr);
      return text(`# ${rel || "."}  (tipo d=dir f=archivo · bytes · modificado · ruta)\n${r.stdout}`);
    }),
  );

  server.registerTool(
    "fs_read_file",
    {
      title: "Leer archivo",
      description:
        "Lee un archivo de texto del servidor (PHP, CSS, JS, .htaccess, logs…). Admite rango de líneas. " +
        "wp-config.php y .env se muestran con secretos ocultos.",
      inputSchema: {
        path: pathArg,
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ path, start_line, end_line }) => {
      requireSsh(ctx);
      const { abs, rel } = await resolvePath(ctx, path);
      const st = await ctx.ssh.stat(abs);
      if (!st) throw new ToolError(`No existe: ${rel}`);
      if (st.isDirectory()) throw new ToolError(`${rel} es un directorio; usa fs_list.`);

      let content: string;
      if (st.size > MAX_READ_BYTES) {
        if (!start_line) {
          throw new ToolError(`Archivo grande (${st.size} bytes). Indica start_line/end_line o usa fs_search.`);
        }
        const end = end_line ?? start_line + 500;
        const r = await ctx.ssh.exec(`sed -n '${start_line},${end}p' ${shq(abs)}`);
        return text(`# ${rel} (líneas ${start_line}-${end})\n${maybeRedact(ctx, rel, r.stdout)}`);
      }
      const buf = await ctx.ssh.readFile(abs);
      if (buf.subarray(0, 8000).includes(0)) throw new ToolError(`${rel} parece un archivo binario (${st.size} bytes).`);
      // Redactar el archivo completo ANTES de recortar líneas (un define partido en varias líneas no escapa).
      content = maybeRedact(ctx, rel, buf.toString("utf8"));

      const lines = content.split("\n");
      const from = start_line ?? 1;
      const to = Math.min(end_line ?? lines.length, lines.length);
      const slice = start_line || end_line ? lines.slice(from - 1, to).join("\n") : content;
      const header = `# ${rel} · ${st.size} bytes · ${lines.length} líneas · modificado ${new Date(st.mtime * 1000).toISOString()}` +
        (start_line || end_line ? ` · mostrando ${from}-${to}` : "");
      return text(`${header}\n${slice}`);
    }),
  );

  server.registerTool(
    "fs_write_file",
    {
      title: "Escribir archivo",
      description:
        "Crea o sobrescribe un archivo completo. Hace copia local previa y, si es PHP, valida la sintaxis y revierte si falla. " +
        "Para cambios parciales usa fs_edit_file. Solo se permite dentro de WRITE_ALLOWED_PATHS.",
      inputSchema: {
        path: pathArg,
        content: z.string(),
        create_dirs: z.boolean().default(false).describe("Crear las carpetas intermedias si no existen"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ path, content, create_dirs }) => {
      requireSsh(ctx);
      if (create_dirs) {
        const { abs, rel } = await resolvePath(ctx, path);
        ctx.guards.assertWritablePath(rel);
        await ctx.ssh.mkdirp(abs.slice(0, abs.lastIndexOf("/")));
      }
      return json(await safeWrite(ctx, path, content, "fs_write_file"));
    }),
  );

  server.registerTool(
    "fs_edit_file",
    {
      title: "Editar archivo",
      description:
        "Reemplaza un fragmento exacto dentro de un archivo (debe ser único salvo replace_all=true). " +
        "Copia previa + validación PHP con rollback automático. Devuelve el diff.",
      inputSchema: {
        path: pathArg,
        old_string: z.string().min(1).describe("Texto exacto actual (incluye suficiente contexto para que sea único)"),
        new_string: z.string(),
        replace_all: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ path, old_string, new_string, replace_all }) => {
      requireSsh(ctx);
      const { abs, rel } = await resolvePath(ctx, path);
      ctx.guards.assertWritablePath(rel);
      if (!(await ctx.ssh.stat(abs))) throw new ToolError(`No existe: ${rel}`);
      const current = (await ctx.ssh.readFile(abs)).toString("utf8");
      const { result, count } = exactReplace(current, old_string, new_string, replace_all);
      return json({ replacements: count, ...(await safeWrite(ctx, path, result, "fs_edit_file")) });
    }),
  );

  server.registerTool(
    "fs_delete_file",
    {
      title: "Borrar archivo",
      description: "Borra un archivo (no directorios). Se guarda copia local antes. Requiere confirm=true.",
      inputSchema: { path: pathArg, confirm: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ path, confirm }) => {
      requireSsh(ctx);
      const { abs, rel } = await resolvePath(ctx, path);
      ctx.guards.assertWritablePath(rel);
      ctx.guards.assertConfirmed(confirm, `borrar ${rel}`);
      const st = await ctx.ssh.lstat(abs);
      if (!st) throw new ToolError(`No existe: ${rel}`);
      if (st.isSymbolicLink()) throw new ToolError(`${path} es un enlace simbólico; no se borran enlaces.`);
      if (!st.isFile()) throw new ToolError(`${rel} no es un archivo normal.`);
      const backup = await ctx.backups.save(abs, await ctx.ssh.readFile(abs), "fs_delete_file");
      await ctx.ssh.unlink(abs);
      return json({ deleted: rel, backup_id: backup.id });
    }),
  );

  server.registerTool(
    "fs_search",
    {
      title: "Buscar en archivos",
      description: "Busca texto o regex (grep) en archivos del servidor. Útil para localizar funciones, hooks, shortcodes, CSS, etc.",
      inputSchema: {
        pattern: z.string().min(1),
        path: pathArg.default("wp-content"),
        regex: z.boolean().default(false).describe("true = regex extendida; false = texto literal"),
        ignore_case: z.boolean().default(false),
        include: z.string().optional().describe("Filtro de nombre de archivo, p. ej. '*.php'"),
        max_results: z.number().int().min(1).max(1000).default(200),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ pattern, path, regex, ignore_case, include, max_results }) => {
      requireSsh(ctx);
      const { abs } = await resolvePath(ctx, path);
      // -H: el nombre de archivo aparece siempre (también con un único archivo como operando).
      const flags = ["-rnIH", regex ? "-E" : "-F", ignore_case ? "-i" : "", "--exclude-dir=node_modules", "--exclude-dir=.git"]
        .filter(Boolean)
        .join(" ");
      const inc = include ? `--include=${shq(include)}` : "";
      const cmd = `grep ${flags} ${inc} -e ${shq(pattern)} -- ${shq(abs)} | head -n ${max_results}`;
      const r = await ctx.ssh.exec(cmd);
      const out = r.stdout
        .split("\n")
        .map((line) => {
          const relLine = line.startsWith(`${ctx.cfg.WP_ROOT}/`) ? line.slice(ctx.cfg.WP_ROOT!.length + 1) : line;
          // Redacción independiente del nombre de archivo: se aplica a TODAS las líneas, y antes de truncar.
          const safeLine = ctx.cfg.REDACT_SECRETS ? redactSecrets(relLine) : relLine;
          return safeLine.length > 400 ? `${safeLine.slice(0, 400)}…` : safeLine;
        })
        .join("\n");
      return text(out.trim() ? out : "(sin coincidencias)");
    }),
  );

  server.registerTool(
    "fs_list_backups",
    {
      title: "Listar copias de seguridad",
      description: "Lista las copias locales que el MCP guardó antes de modificar o borrar archivos.",
      inputSchema: { filter: z.string().optional().describe("Filtrar por ruta"), limit: z.number().int().default(30) },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ filter, limit }) => json(await ctx.backups.list(filter, limit))),
  );

  server.registerTool(
    "fs_restore_backup",
    {
      title: "Restaurar copia de seguridad",
      description: "Restaura un archivo a la versión guardada en una copia (si el archivo no existía, lo borra). La versión actual también se respalda.",
      inputSchema: { backup_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ backup_id }) => {
      requireSsh(ctx);
      const { entry, content } = await ctx.backups.get(backup_id);
      if (entry.remotePath.startsWith("elementor:")) {
        throw new ToolError("Es una copia de una página de Elementor: usa elementor_restore_backup.");
      }
      const { abs, rel } = await resolvePath(ctx, entry.remotePath);
      ctx.guards.assertWritablePath(rel);
      const currentStat = await ctx.ssh.stat(abs);
      const current = currentStat ? await ctx.ssh.readFile(abs) : null;
      const safety = await ctx.backups.save(abs, current, `antes de restaurar ${backup_id}`);
      if (content) await ctx.ssh.writeFile(abs, content);
      else if (current) await ctx.ssh.unlink(abs);
      return json({
        restored: rel,
        from: entry.createdAt,
        action: content ? "contenido restaurado" : "archivo eliminado (no existía en la copia)",
        backup_of_current: safety.id,
      });
    }),
  );
};
