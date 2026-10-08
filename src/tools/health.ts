import { z } from "zod";
import { shq } from "../clients/ssh.js";
import type { Ctx, ToolModule } from "../context.js";
import { json, safe, text, ToolError } from "../lib/result.js";
import { redactSecrets } from "../safety/redact.js";

const SITE_HEALTH_TESTS = [
  "background-updates",
  "loopback-requests",
  "https-status",
  "dotorg-communication",
  "authorization-header",
  "page-cache",
];

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** Ejecuta una comprobación sin que su fallo tumbe el informe completo. */
async function attempt<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function wpJson(ctx: Ctx, args: string[]): Promise<unknown> {
  const r = await ctx.ssh.wp([...args, "--format=json"], 300_000);
  try {
    return JSON.parse(r.stdout || "[]");
  } catch {
    return { exit_code: r.code, output: (r.stdout + r.stderr).trim() };
  }
}

async function wpText(ctx: Ctx, args: string[]): Promise<{ ok: boolean; output: string }> {
  const r = await ctx.ssh.wp(args, 300_000);
  return { ok: r.code === 0, output: (r.stdout + r.stderr).trim() };
}

export const registerHealthTools: ToolModule = (server, ctx) => {
  server.registerTool(
    "wp_health_check",
    {
      title: "Chequeo de salud",
      description:
        "Informe de salud del sitio: tests de Site Health de WordPress, actualizaciones pendientes (core/plugins/temas), " +
        "integridad de archivos del núcleo y plugins (checksums), configuración de debug, permisos, espacio en disco y log de errores.",
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const report: Record<string, unknown> = {};
      const warnings: string[] = [];

      const health = await Promise.all(
        SITE_HEALTH_TESTS.map(async (t) => {
          const r = await attempt(() =>
            ctx.rest.get<{ label: string; status: "good" | "recommended" | "critical"; description: string }>(
              `wp-site-health/v1/tests/${t}`,
            ),
          );
          if ("error" in r) return { test: t, error: r.error };
          const { label, status, description } = r.data;
          if (status !== "good") warnings.push(`[Site Health · ${status}] ${label}`);
          return { test: t, status, label, detail: status === "good" ? undefined : stripHtml(description).slice(0, 400) };
        }),
      );
      report.site_health = health;

      if (!ctx.ssh.enabled) {
        report.note = "Sin SSH: solo se ejecutaron los tests REST. Configura SSH para el informe completo.";
        return json({ warnings, ...report });
      }

      const [coreUpdates, coreChecksums, pluginUpdates, themeUpdates, pluginChecksums, inactive, php, debug, perms, disk, debugLog] =
        await Promise.all([
          attempt(() => wpJson(ctx, ["core", "check-update"])),
          attempt(() => wpText(ctx, ["core", "verify-checksums"])),
          attempt(() => wpJson(ctx, ["plugin", "list", "--update=available", "--fields=name,version,update_version"])),
          attempt(() => wpJson(ctx, ["theme", "list", "--update=available", "--fields=name,version,update_version"])),
          attempt(() => wpText(ctx, ["plugin", "verify-checksums", "--all"])),
          attempt(() => wpJson(ctx, ["plugin", "list", "--status=inactive", "--fields=name,version"])),
          attempt(async () => (await ctx.ssh.exec("php -r 'echo PHP_VERSION;'")).stdout.trim()),
          attempt(async () => {
            const keys = ["WP_DEBUG", "WP_DEBUG_LOG", "WP_DEBUG_DISPLAY", "DISALLOW_FILE_EDIT", "WP_AUTO_UPDATE_CORE"];
            const out: Record<string, string> = {};
            for (const k of keys) {
              const r = await ctx.ssh.wp(["config", "get", k]);
              out[k] = r.code === 0 ? r.stdout.trim() : "(no definido)";
            }
            return out;
          }),
          attempt(async () => {
            const r = await ctx.ssh.exec(`cd ${shq(ctx.cfg.WP_ROOT!)} && stat -c '%a %n' wp-config.php .htaccess 2>/dev/null`);
            return r.stdout.trim();
          }),
          attempt(async () => {
            const r = await ctx.ssh.exec(
              `cd ${shq(ctx.cfg.WP_ROOT!)} && du -sh wp-content/uploads wp-content/plugins wp-content/themes . 2>/dev/null; df -h . | tail -1`,
            );
            return r.stdout.trim();
          }),
          attempt(async () => {
            const r = await ctx.ssh.exec(`cd ${shq(ctx.cfg.WP_ROOT!)} && ls -l wp-content/debug.log error_log 2>/dev/null`);
            return r.stdout.trim() || "(no hay debug.log ni error_log)";
          }),
        ]);

      Object.assign(report, {
        php_version: php,
        core_updates: coreUpdates,
        core_checksums: coreChecksums,
        plugin_updates: pluginUpdates,
        theme_updates: themeUpdates,
        plugin_checksums: pluginChecksums,
        inactive_plugins: inactive,
        debug_config: debug,
        permissions: perms,
        disk_usage: disk,
        logs: debugLog,
      });

      // Señales a destacar
      if (Array.isArray(coreUpdates) && coreUpdates.length) warnings.push("Hay actualización del núcleo de WordPress disponible.");
      if (Array.isArray(pluginUpdates) && pluginUpdates.length) warnings.push(`${pluginUpdates.length} plugin(s) con actualización pendiente.`);
      if (Array.isArray(themeUpdates) && themeUpdates.length) warnings.push(`${themeUpdates.length} tema(s) con actualización pendiente.`);
      if (Array.isArray(inactive) && inactive.length) warnings.push(`${inactive.length} plugin(s) inactivos: si no se usan, conviene eliminarlos.`);
      if (typeof coreChecksums === "object" && "ok" in coreChecksums && !coreChecksums.ok) {
        warnings.push("⚠ Los archivos del núcleo NO coinciden con los checksums oficiales (posible modificación o malware).");
      }
      if (typeof pluginChecksums === "object" && "output" in pluginChecksums && /doesn't verify|File was added|File is missing/i.test(pluginChecksums.output)) {
        warnings.push("⚠ Algunos plugins tienen archivos que no coinciden con wordpress.org.");
      }
      if (typeof debug === "object" && !("error" in debug)) {
        if (debug.WP_DEBUG_DISPLAY !== "0" && debug.WP_DEBUG === "1") warnings.push("WP_DEBUG activo y mostrando errores en pantalla.");
        if (debug.DISALLOW_FILE_EDIT !== "1") warnings.push("DISALLOW_FILE_EDIT no está activado (editor de archivos de wp-admin habilitado).");
      }
      if (typeof perms === "string" && /^(6[6-7]\d|7\d\d|\d\d[2-7]) wp-config/m.test(perms)) {
        warnings.push("Permisos de wp-config.php demasiado abiertos (recomendado 600/640/440).");
      }

      return json({ warnings, ...report });
    }),
  );

  server.registerTool(
    "wp_read_debug_log",
    {
      title: "Leer log de errores",
      description: "Muestra las últimas líneas de wp-content/debug.log (o el definido en WP_DEBUG_LOG) y del error_log de PHP.",
      inputSchema: {
        lines: z.number().int().min(1).max(2000).default(150),
        filter: z.string().optional().describe("Mostrar solo líneas que contengan este texto (p. ej. 'Fatal')"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ lines, filter }) => {
      if (!ctx.ssh.enabled) throw new ToolError("Requiere SSH.");
      const root = ctx.cfg.WP_ROOT!;
      const cfgLog = await ctx.ssh.wp(["config", "get", "WP_DEBUG_LOG"]);
      const custom = cfgLog.stdout.trim();
      const candidates = [
        custom.startsWith("/") ? custom : `${root}/wp-content/debug.log`,
        `${root}/error_log`,
        `${root}/wp-admin/error_log`,
      ];
      const parts: string[] = [];
      for (const file of candidates) {
        // `-e … --`: el filtro es siempre un patrón literal, nunca opciones de grep (p. ej. "-r" leería otros archivos).
        const grep = filter ? ` | grep -F -e ${shq(filter)} --` : "";
        const r = await ctx.ssh.exec(
          `cd ${shq(root)} && test -f ${shq(file)} && tail -n ${filter ? lines * 20 : lines} -- ${shq(file)}${grep} | tail -n ${lines}`,
        );
        if (r.code === 0 && r.stdout.trim()) {
          parts.push(`# ${file}\n${ctx.cfg.REDACT_SECRETS ? redactSecrets(r.stdout) : r.stdout}`);
        }
      }
      if (!parts.length) {
        return text(
          "No hay logs con contenido. Para activarlos: wp_cli 'config set WP_DEBUG true --raw', " +
            "'config set WP_DEBUG_LOG true --raw' y 'config set WP_DEBUG_DISPLAY false --raw'.",
        );
      }
      return text(parts.join("\n\n"));
    }),
  );

  server.registerTool(
    "wp_security_scan",
    {
      title: "Escaneo de seguridad",
      description:
        "Escaneo heurístico de archivos: PHP dentro de uploads, archivos PHP modificados recientemente, patrones de código " +
        "típicos de malware (eval(base64_decode…), webshells), integridad del núcleo y administradores. No sustituye a un antimalware completo.",
      inputSchema: { days: z.number().int().min(1).max(365).default(7).describe("Ventana de 'modificados recientemente'") },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ days }) => {
      if (!ctx.ssh.enabled) throw new ToolError("Requiere SSH.");
      const root = shq(ctx.cfg.WP_ROOT!);
      const suspicious =
        "(eval|assert)[[:space:]]*\\([[:space:]]*(base64_decode|gzinflate|gzuncompress|str_rot13|stripslashes)[[:space:]]*\\(" +
        "|\\$_(POST|GET|REQUEST|COOKIE)\\[[^]]+\\][[:space:]]*\\(" +
        "|preg_replace[[:space:]]*\\(.*/e['\"]" +
        "|(shell_exec|passthru|system|proc_open|popen)[[:space:]]*\\([[:space:]]*\\$_(POST|GET|REQUEST)" +
        "|FilesMan|WSOsetcookie|c99shell|r57shell";

      const run = async (cmd: string) => (await ctx.ssh.exec(`cd ${root} && ${cmd}`, 300_000)).stdout.trim();

      const [phpInUploads, recent, patterns, coreIntegrity, admins] = await Promise.all([
        attempt(() =>
          run(`find wp-content/uploads -type f \\( -iname '*.php' -o -iname '*.phtml' -o -iname '*.php[0-9]' -o -iname '*.phar' \\) 2>/dev/null | head -n 100`),
        ),
        attempt(() =>
          run(
            `find . -type f \\( -name '*.php' -o -name '.htaccess' \\) -mtime -${days} ` +
              `-not -path './wp-content/cache/*' -not -path './wp-content/upgrade/*' -printf '%TY-%Tm-%Td %TH:%TM  %p\\n' 2>/dev/null | sort -r | head -n 150`,
          ),
        ),
        attempt(() => run(`grep -rlIE --include='*.php' ${shq(suspicious)} . --exclude-dir=node_modules 2>/dev/null | sort -u | head -n 100`)),
        attempt(() => wpText(ctx, ["core", "verify-checksums"])),
        attempt(() => wpJson(ctx, ["user", "list", "--role=administrator", "--fields=ID,user_login,user_email,user_registered"])),
      ]);

      const findings: string[] = [];
      if (typeof phpInUploads === "string" && phpInUploads) findings.push("⚠ Hay archivos PHP dentro de uploads (casi nunca es legítimo).");
      if (typeof patterns === "string" && patterns) findings.push("⚠ Archivos con patrones de código sospechosos: revísalos con fs_read_file.");
      if (typeof coreIntegrity === "object" && "ok" in coreIntegrity && !coreIntegrity.ok) findings.push("⚠ El núcleo de WordPress no coincide con los checksums oficiales.");

      return json({
        findings: findings.length ? findings : ["Sin señales evidentes. (Heurístico: no garantiza ausencia de malware)"],
        php_in_uploads: phpInUploads || "(ninguno)",
        suspicious_patterns: patterns || "(ninguno)",
        recently_modified: recent || "(ninguno)",
        core_integrity: coreIntegrity,
        administrators: admins,
      });
    }),
  );
};
