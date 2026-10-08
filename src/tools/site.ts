import { z } from "zod";
import type { ToolModule } from "../context.js";
import { json, safe, ToolError } from "../lib/result.js";

interface WpIndex {
  name: string;
  description: string;
  url: string;
  home: string;
  gmt_offset: number;
  timezone_string: string;
  namespaces: string[];
}

export const registerSiteTools: ToolModule = (server, ctx) => {
  server.registerTool(
    "wp_site_info",
    {
      title: "Información del sitio",
      description:
        "Resumen del sitio: nombre, URL, usuario conectado, namespaces REST (indica plugins con API: wc/v3, acf, elementor…), " +
        "y si hay SSH: versión de WordPress, PHP, tema activo y estado de la conexión. Úsala primero para orientarte.",
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const [{ data: index }, { data: me }] = await Promise.all([
        ctx.rest.get<WpIndex>(""),
        ctx.rest.get<{ id: number; name: string; roles: string[] }>("wp/v2/users/me", { context: "edit" }),
      ]);
      const info: Record<string, unknown> = {
        name: index.name,
        description: index.description,
        url: index.url,
        home: index.home,
        timezone: index.timezone_string || `UTC${index.gmt_offset >= 0 ? "+" : ""}${index.gmt_offset}`,
        connected_as: { id: me.id, name: me.name, roles: me.roles },
        rest_namespaces: index.namespaces,
        read_only_mode: ctx.cfg.READ_ONLY,
        write_allowed_paths: ctx.cfg.WRITE_ALLOWED_PATHS,
        ssh: ctx.ssh.enabled ? "configurado" : "no configurado (herramientas de archivos y WP-CLI deshabilitadas)",
      };
      if (ctx.ssh.enabled) {
        try {
          const [core, php, theme] = await Promise.all([
            ctx.ssh.wpOrThrow(["core", "version", "--extra"]),
            ctx.ssh.exec("php -r 'echo PHP_VERSION;'"),
            ctx.ssh.wpOrThrow(["theme", "list", "--status=active", "--field=name"]),
          ]);
          info.wordpress = core.trim();
          info.php = php.stdout.trim();
          info.active_theme = theme.trim();
          info.wp_root = ctx.cfg.WP_ROOT;
        } catch (err) {
          info.ssh_error = (err as Error).message;
        }
      }
      return json(info);
    }),
  );

  server.registerTool(
    "wp_get_settings",
    {
      title: "Leer ajustes",
      description: "Lee los ajustes generales del sitio (título, descripción, idioma, página de inicio, permalinks de lectura…).",
      annotations: { readOnlyHint: true },
    },
    safe(async () => json((await ctx.rest.get("wp/v2/settings")).data)),
  );

  server.registerTool(
    "wp_update_settings",
    {
      title: "Actualizar ajustes",
      description:
        'Actualiza ajustes del sitio vía REST (p. ej. {"title":"…","show_on_front":"page","page_on_front":12}). ' +
        "Para opciones no expuestas en REST usa wp_cli con `option update`.",
      inputSchema: { settings: z.record(z.string(), z.unknown()) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    safe(async ({ settings }) => {
      ctx.guards.assertWritable("actualizar ajustes");
      const { data: before } = await ctx.rest.get<Record<string, unknown>>("wp/v2/settings");
      const { data: after } = await ctx.rest.post<Record<string, unknown>>("wp/v2/settings", settings);
      const changes = Object.keys(settings).map((k) => ({ key: k, before: before[k], after: after[k] }));
      return json({ changes });
    }),
  );

  server.registerTool(
    "wp_list_users",
    {
      title: "Listar usuarios",
      description: "Lista usuarios del sitio con sus roles.",
      inputSchema: {
        search: z.string().optional(),
        roles: z.array(z.string()).optional(),
        per_page: z.number().int().min(1).max(100).default(50),
        page: z.number().int().min(1).default(1),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async (q) => {
      const res = await ctx.rest.get<
        Array<{ id: number; username: string; name: string; email: string; roles: string[]; registered_date: string }>
      >("wp/v2/users", { ...q, context: "edit" });
      return json({
        total: res.total,
        items: res.data.map((u) => ({
          id: u.id,
          username: u.username,
          name: u.name,
          email: u.email,
          roles: u.roles,
          registered: u.registered_date,
        })),
      });
    }),
  );

  server.registerTool(
    "wp_list_menus",
    {
      title: "Listar menús",
      description: "Lista los menús de navegación clásicos y, opcionalmente, sus elementos. (Los temas de bloques usan wp_navigation: wp_list_content type=wp_navigation).",
      inputSchema: { include_items: z.boolean().default(true) },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ include_items }) => {
      const { data: menus } = await ctx.rest.get<Array<{ id: number; name: string; slug: string; locations: string[] }>>(
        "wp/v2/menus",
        { per_page: 100 },
      );
      if (!include_items) return json(menus);
      const out = await Promise.all(
        menus.map(async (m) => {
          const { data: items } = await ctx.rest.get<
            Array<{ id: number; title: { rendered: string }; url: string; parent: number; menu_order: number; object: string; object_id: number }>
          >("wp/v2/menu-items", { menus: m.id, per_page: 100, context: "edit" });
          return {
            ...m,
            items: items.map((i) => ({
              id: i.id,
              title: i.title?.rendered,
              url: i.url,
              parent: i.parent,
              order: i.menu_order,
              object: i.object,
              object_id: i.object_id,
            })),
          };
        }),
      );
      return json(out);
    }),
  );

  server.registerTool(
    "wp_rest_request",
    {
      title: "Petición REST genérica",
      description:
        "Llama a cualquier endpoint de la REST API (núcleo o plugins: WooCommerce wc/v3, Yoast, ACF, comentarios, " +
        "menu-items, bloques reutilizables, etc.). Ruta relativa a /wp-json, p. ej. 'wp/v2/comments' o 'wc/v3/products'. " +
        "Los métodos de escritura respetan READ_ONLY y DELETE requiere confirm=true.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        route: z.string().min(1),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.unknown().optional(),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    safe(async ({ method, route, query, body, confirm }) => {
      if (/^https?:|\/\/|(^|\/)\.\.(\/|$)/i.test(route)) {
        throw new ToolError("La ruta debe ser relativa a /wp-json (sin URL completa ni '..').");
      }
      // buildUrl (rest.ts) rechaza además '?', '#', segmentos codificados y '_method', así que el
      // método declarado es siempre el método efectivo que WordPress ejecuta.
      ctx.rest.buildUrl(route, query);
      if (method !== "GET") ctx.guards.assertWritable(`${method} ${route}`);
      if (method === "DELETE") ctx.guards.assertConfirmed(confirm, `DELETE ${route}`);
      const res = await ctx.rest.request(route, { method, query, body });
      return json({ status: res.status, total: res.total, totalPages: res.totalPages, data: res.data });
    }),
  );
};
