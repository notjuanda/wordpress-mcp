import { z } from "zod";
import type { Ctx, ToolModule } from "../context.js";
import { json, safe, text, ToolError } from "../lib/result.js";
import { assertSlug } from "./cli.js";

interface RestPlugin {
  plugin: string;
  status: "active" | "inactive" | "network-active";
  name: string;
  version: string;
  author: string;
  description: { raw: string };
  requires_wp: string;
  requires_php: string;
}

/** Normaliza "akismet", "akismet/akismet" o "akismet/akismet.php" al id REST "akismet/akismet". */
async function resolvePlugin(ctx: Ctx, input: string): Promise<RestPlugin> {
  const id = input.replace(/\.php$/, "");
  const { data } = await ctx.rest.get<RestPlugin[]>("wp/v2/plugins");
  const match =
    data.find((p) => p.plugin === id) ??
    data.find((p) => p.plugin.split("/")[0] === id) ??
    data.find((p) => p.name.toLowerCase() === input.toLowerCase());
  if (!match) throw new ToolError(`Plugin no encontrado: "${input}". Usa wp_list_plugins para ver los instalados.`);
  return match;
}

function requireSsh(ctx: Ctx, what: string): void {
  if (!ctx.ssh.enabled) throw new ToolError(`${what} requiere SSH + WP-CLI (no disponible vía REST). Configura SSH en .env.`);
}

const parseJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

export const registerExtensionTools: ToolModule = (server, ctx) => {
  // ── Plugins ────────────────────────────────────────────────────────

  server.registerTool(
    "wp_list_plugins",
    {
      title: "Listar plugins",
      description: "Lista plugins instalados con estado y versión. Con SSH incluye también si hay actualización disponible.",
      inputSchema: {
        status: z.enum(["active", "inactive", "all"]).default("all"),
        search: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ status, search }) => {
      if (ctx.ssh.enabled) {
        const args = ["plugin", "list", "--format=json", "--fields=name,title,status,version,update,update_version,auto_update"];
        if (status !== "all") args.push(`--status=${status}`);
        let list = parseJson(await ctx.ssh.wpOrThrow(args)) as Array<{ name: string; title: string }>;
        if (search) {
          const s = search.toLowerCase();
          list = list.filter((p) => p.name.includes(s) || p.title.toLowerCase().includes(s));
        }
        return json(list);
      }
      const { data } = await ctx.rest.get<RestPlugin[]>("wp/v2/plugins", {
        status: status === "all" ? undefined : status,
        search,
      });
      return json(data.map((p) => ({ plugin: p.plugin, name: p.name, status: p.status, version: p.version, author: p.author })));
    }),
  );

  server.registerTool(
    "wp_set_plugin_status",
    {
      title: "Activar/desactivar plugin",
      description: 'Activa o desactiva un plugin. Acepta el slug ("akismet"), el id ("akismet/akismet") o el nombre.',
      inputSchema: { plugin: z.string(), active: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    safe(async ({ plugin, active }) => {
      ctx.guards.assertWritable(`${active ? "activar" : "desactivar"} plugin`);
      const p = await resolvePlugin(ctx, plugin);
      const { data } = await ctx.rest.post<RestPlugin>(`wp/v2/plugins/${p.plugin}`, {
        status: active ? "active" : "inactive",
      });
      return json({ plugin: data.plugin, name: data.name, before: p.status, after: data.status });
    }),
  );

  server.registerTool(
    "wp_install_plugin",
    {
      title: "Instalar plugin",
      description:
        "Instala un plugin desde el directorio oficial de WordPress.org por su slug (p. ej. 'wordfence'). " +
        "Con activate=true ejecuta código nuevo en el sitio, por lo que requiere confirm=true.",
      inputSchema: {
        slug: z.string().regex(/^[a-z0-9-]+$/, "slug inválido"),
        activate: z.boolean().default(false),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe(async ({ slug, activate, confirm }) => {
      ctx.guards.assertWritable("instalar plugin");
      if (activate) ctx.guards.assertConfirmed(confirm, `instalar y activar el plugin ${slug}`);
      const { data } = await ctx.rest.post<RestPlugin>("wp/v2/plugins", {
        slug,
        status: activate ? "active" : "inactive",
      });
      return json({ installed: { plugin: data.plugin, name: data.name, version: data.version, status: data.status } });
    }),
  );

  server.registerTool(
    "wp_update_plugins",
    {
      title: "Actualizar plugins",
      description:
        "Actualiza uno o varios plugins (o todos) vía WP-CLI. Recomendado: hacer wp_db_backup antes. Con dry_run solo muestra qué se actualizaría.",
      inputSchema: {
        plugins: z.array(z.string()).optional().describe("Slugs a actualizar; vacío + all=true para todos"),
        all: z.boolean().default(false),
        dry_run: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe(async ({ plugins, all, dry_run }) => {
      requireSsh(ctx, "Actualizar plugins");
      if (!dry_run) ctx.guards.assertWritable("actualizar plugins");
      if (!all && !plugins?.length) throw new ToolError("Indica 'plugins' o all=true.");
      const args = ["plugin", "update", ...(all ? ["--all"] : plugins!.map((p) => assertSlug(p, "Plugin"))), "--format=json"];
      if (dry_run) args.push("--dry-run");
      const r = await ctx.ssh.wp(args, 600_000);
      return json({ exit_code: r.code, result: parseJson(r.stdout), stderr: r.stderr || undefined });
    }),
  );

  server.registerTool(
    "wp_delete_plugin",
    {
      title: "Eliminar plugin",
      description: "Elimina un plugin (debe estar desactivado). Borra sus archivos. Requiere confirm=true.",
      inputSchema: { plugin: z.string(), confirm: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ plugin, confirm }) => {
      ctx.guards.assertWritable("eliminar plugin");
      ctx.guards.assertConfirmed(confirm, `eliminar plugin ${plugin}`);
      const p = await resolvePlugin(ctx, plugin);
      if (p.status !== "inactive") throw new ToolError(`Desactiva primero el plugin ${p.plugin} (estado: ${p.status}).`);
      await ctx.rest.delete(`wp/v2/plugins/${p.plugin}`);
      return json({ deleted: p.plugin, name: p.name, version: p.version });
    }),
  );

  // ── Temas ──────────────────────────────────────────────────────────

  server.registerTool(
    "wp_list_themes",
    {
      title: "Listar temas",
      description: "Lista temas instalados, cuál está activo y (con SSH) si tienen actualización.",
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      if (ctx.ssh.enabled) {
        return json(
          parseJson(await ctx.ssh.wpOrThrow(["theme", "list", "--format=json", "--fields=name,title,status,version,update,update_version"])),
        );
      }
      const { data } = await ctx.rest.get<
        Array<{ stylesheet: string; template: string; status: string; name: { raw: string }; version: string }>
      >("wp/v2/themes");
      return json(
        data.map((t) => ({ stylesheet: t.stylesheet, parent: t.template !== t.stylesheet ? t.template : undefined, name: t.name?.raw, status: t.status, version: t.version })),
      );
    }),
  );

  server.registerTool(
    "wp_activate_theme",
    {
      title: "Activar tema",
      description: "Activa un tema instalado por su slug (stylesheet). Requiere SSH/WP-CLI.",
      inputSchema: { theme: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ theme }) => {
      requireSsh(ctx, "Activar temas");
      ctx.guards.assertWritable("activar tema");
      return text(await ctx.ssh.wpOrThrow(["theme", "activate", assertSlug(theme, "Tema")]));
    }),
  );

  server.registerTool(
    "wp_update_themes",
    {
      title: "Actualizar temas",
      description: "Actualiza temas vía WP-CLI. Cuidado: los cambios hechos directamente en un tema (no hijo) se pierden.",
      inputSchema: {
        themes: z.array(z.string()).optional(),
        all: z.boolean().default(false),
        dry_run: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe(async ({ themes, all, dry_run }) => {
      requireSsh(ctx, "Actualizar temas");
      if (!dry_run) ctx.guards.assertWritable("actualizar temas");
      if (!all && !themes?.length) throw new ToolError("Indica 'themes' o all=true.");
      const args = ["theme", "update", ...(all ? ["--all"] : themes!.map((t) => assertSlug(t, "Tema"))), "--format=json"];
      if (dry_run) args.push("--dry-run");
      const r = await ctx.ssh.wp(args, 600_000);
      return json({ exit_code: r.code, result: parseJson(r.stdout), stderr: r.stderr || undefined });
    }),
  );
};
