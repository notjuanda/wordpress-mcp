import { z } from "zod";
import type { Ctx, ToolModule } from "../context.js";
import { clearCaches } from "../lib/cache.js";
import { exactReplace, unifiedDiff } from "../lib/diff.js";
import { json, safe, ToolError } from "../lib/result.js";

interface WpType {
  slug: string;
  name: string;
  rest_base: string;
  rest_namespace?: string;
}

interface WpPost {
  id: number;
  type: string;
  status: string;
  slug: string;
  link: string;
  date: string;
  modified: string;
  title: { raw?: string; rendered: string };
  content?: { raw?: string; rendered: string };
  excerpt?: { raw?: string; rendered: string };
  [k: string]: unknown;
}

let typeCache: Record<string, WpType> | null = null;

async function getTypes(ctx: Ctx): Promise<Record<string, WpType>> {
  if (!typeCache) typeCache = (await ctx.rest.get<Record<string, WpType>>("wp/v2/types", { context: "edit" })).data;
  return typeCache;
}

/** Convierte "post", "posts", "page", "product"… en la ruta REST de la colección. */
export async function collectionRoute(ctx: Ctx, type: string): Promise<string> {
  const types = await getTypes(ctx);
  const t = Object.values(types).find((x) => x.slug === type || x.rest_base === type);
  if (!t) {
    const valid = Object.values(types)
      .map((x) => `${x.slug} (${x.rest_base})`)
      .join(", ");
    throw new ToolError(`Tipo de contenido desconocido "${type}". Disponibles: ${valid}`);
  }
  return `${t.rest_namespace ?? "wp/v2"}/${t.rest_base}`;
}

const summarize = (p: WpPost) => ({
  id: p.id,
  type: p.type,
  title: p.title?.raw ?? p.title?.rendered,
  status: p.status,
  slug: p.slug,
  link: p.link,
  modified: p.modified,
});

const typeArg = z
  .string()
  .default("posts")
  .describe('Tipo de contenido: "posts", "pages" o el slug/rest_base de un custom post type (p. ej. "product")');

const writableFields = {
  title: z.string().optional(),
  content: z.string().optional().describe("Contenido HTML / bloques de Gutenberg (raw)"),
  excerpt: z.string().optional(),
  status: z.enum(["publish", "draft", "pending", "private", "future"]).optional(),
  slug: z.string().optional(),
  date: z.string().optional().describe("Fecha de publicación ISO 8601 (para status=future)"),
  author: z.number().int().optional(),
  parent: z.number().int().optional(),
  menu_order: z.number().int().optional(),
  template: z.string().optional(),
  featured_media: z.number().int().optional().describe("ID del medio destacado"),
  categories: z.array(z.number().int()).optional(),
  tags: z.array(z.number().int()).optional(),
  meta: z.record(z.string(), z.unknown()).optional().describe("Campos meta registrados en la REST API"),
  extra: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Cualquier otro campo aceptado por el endpoint (ACF, taxonomías personalizadas, etc.)"),
};

function isElementor(p: WpPost): boolean {
  const meta = p.meta as Record<string, unknown> | undefined;
  return (
    meta?._elementor_edit_mode === "builder" ||
    (typeof p.template === "string" && p.template.startsWith("elementor")) ||
    /class="elementor elementor-\d+/.test(p.content?.rendered ?? "")
  );
}

function assertNotElementor(p: WpPost): void {
  if (isElementor(p)) {
    throw new ToolError(
      `"${p.title?.raw}" (id ${p.id}) está hecha con Elementor: editar 'content' no cambiaría lo que se ve. ` +
        "Usa elementor_get_page y luego elementor_replace_text o elementor_update_element.",
    );
  }
}

type WritableInput = { [K in keyof typeof writableFields]?: z.infer<(typeof writableFields)[K]> };

function buildBody(input: WritableInput): Record<string, unknown> {
  const { extra, ...rest } = input;
  const body: Record<string, unknown> = { ...(extra ?? {}) };
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
  return body;
}

export const registerContentTools: ToolModule = (server, ctx) => {
  server.registerTool(
    "wp_list_post_types",
    {
      title: "Listar tipos de contenido",
      description: "Lista los tipos de contenido (posts, pages, CPTs) disponibles en la REST API con su rest_base.",
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      typeCache = null;
      const types = await getTypes(ctx);
      return json(Object.values(types).map((t) => ({ slug: t.slug, name: t.name, rest_base: t.rest_base })));
    }),
  );

  server.registerTool(
    "wp_list_content",
    {
      title: "Listar entradas/páginas",
      description:
        "Busca y lista contenido (entradas, páginas o custom post types). Devuelve un resumen; usa wp_get_content para el contenido completo.",
      inputSchema: {
        type: typeArg,
        search: z.string().optional(),
        status: z.string().default("any").describe('publish, draft, pending, private, future, trash o "any"'),
        slug: z.string().optional(),
        parent: z.number().int().optional(),
        categories: z.array(z.number().int()).optional(),
        tags: z.array(z.number().int()).optional(),
        author: z.number().int().optional(),
        orderby: z.enum(["date", "modified", "title", "id", "menu_order", "relevance"]).default("modified"),
        order: z.enum(["asc", "desc"]).default("desc"),
        per_page: z.number().int().min(1).max(100).default(20),
        page: z.number().int().min(1).default(1),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ type, per_page, page, ...q }) => {
      const route = await collectionRoute(ctx, type);
      const res = await ctx.rest.get<WpPost[]>(route, {
        ...q,
        orderby: q.search && q.orderby === "modified" ? "relevance" : q.orderby,
        per_page,
        page,
        context: "edit",
        _fields: "id,type,title,status,slug,link,modified",
      });
      return json({ total: res.total, totalPages: res.totalPages, page, items: res.data.map(summarize) });
    }),
  );

  server.registerTool(
    "wp_get_content",
    {
      title: "Obtener entrada/página",
      description:
        "Obtiene una entrada/página completa en formato editable (raw), incluyendo bloques de Gutenberg, meta y taxonomías.",
      inputSchema: {
        type: typeArg,
        id: z.number().int(),
        include_rendered: z.boolean().default(false).describe("Incluir también el HTML renderizado"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ type, id, include_rendered }) => {
      const route = await collectionRoute(ctx, type);
      const { data: p } = await ctx.rest.get<WpPost>(`${route}/${id}`, { context: "edit" });
      const out: Record<string, unknown> = {
        ...p,
        title: p.title?.raw,
        content: p.content?.raw,
        excerpt: p.excerpt?.raw,
      };
      if (include_rendered) out.content_rendered = p.content?.rendered;
      const meta = { ...((p.meta as Record<string, unknown> | undefined) ?? {}) };
      if ("_elementor_data" in meta) meta._elementor_data = "(omitido: usa elementor_get_page)";
      out.meta = meta;
      if (isElementor(p)) {
        out._aviso =
          "Esta página usa Elementor: el campo 'content' es solo una copia y editarlo NO cambia lo que se ve. " +
          "Usa elementor_get_page / elementor_replace_text / elementor_update_element.";
      }
      delete out._links;
      delete out.guid;
      return json(out);
    }),
  );

  server.registerTool(
    "wp_create_content",
    {
      title: "Crear entrada/página",
      description: "Crea una entrada, página o custom post type. Por defecto queda como borrador.",
      inputSchema: { type: typeArg, ...writableFields, status: writableFields.status.default("draft") },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    safe(async ({ type, ...fields }) => {
      ctx.guards.assertWritable("crear contenido");
      const route = await collectionRoute(ctx, type);
      const { data } = await ctx.rest.post<WpPost>(route, buildBody(fields));
      return json({ created: summarize(data) });
    }),
  );

  server.registerTool(
    "wp_update_content",
    {
      title: "Actualizar entrada/página",
      description:
        "Actualiza campos de una entrada/página (título, contenido completo, estado, slug, taxonomías, meta…). " +
        "Para cambiar solo un fragmento del contenido usa wp_replace_in_content.",
      inputSchema: { type: typeArg, id: z.number().int(), ...writableFields },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    safe(async ({ type, id, ...fields }) => {
      ctx.guards.assertWritable("actualizar contenido");
      const body = buildBody(fields);
      if (Object.keys(body).length === 0) throw new ToolError("No se indicó ningún campo a actualizar.");
      const route = await collectionRoute(ctx, type);
      const { data: before } = await ctx.rest.get<WpPost>(`${route}/${id}`, { context: "edit" });
      if (body.content !== undefined) assertNotElementor(before);
      const { data: after } = await ctx.rest.post<WpPost>(`${route}/${id}`, body);
      const contentDiff =
        body.content !== undefined ? unifiedDiff(`${type}/${id}`, before.content?.raw ?? "", String(body.content)) : undefined;
      return json({
        updated: summarize(after),
        changed_fields: Object.keys(body),
        content_diff: contentDiff,
        cache: await clearCaches(ctx),
        note: "WordPress guarda una revisión automática si el tipo admite revisiones.",
      });
    }),
  );

  server.registerTool(
    "wp_replace_in_content",
    {
      title: "Reemplazar texto en entrada/página",
      description:
        "Edición quirúrgica: reemplaza un fragmento exacto del título/contenido/extracto raw. " +
        "El fragmento debe ser único salvo replace_all=true. Devuelve el diff.",
      inputSchema: {
        type: typeArg,
        id: z.number().int(),
        field: z.enum(["content", "title", "excerpt"]).default("content"),
        find: z.string().min(1).describe("Texto exacto a buscar (literal, no regex)"),
        replace: z.string(),
        replace_all: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ type, id, field, find, replace, replace_all }) => {
      ctx.guards.assertWritable("editar contenido");
      const route = await collectionRoute(ctx, type);
      const { data: before } = await ctx.rest.get<WpPost>(`${route}/${id}`, { context: "edit" });
      if (field === "content") assertNotElementor(before);
      const source = (before[field] as { raw?: string } | undefined)?.raw ?? "";
      const { result, count } = exactReplace(source, find, replace, replace_all);
      const { data: after } = await ctx.rest.post<WpPost>(`${route}/${id}`, { [field]: result });
      return json({
        updated: summarize(after),
        replacements: count,
        diff: unifiedDiff(`${type}/${id}.${field}`, source, result),
        cache: await clearCaches(ctx),
      });
    }),
  );

  server.registerTool(
    "wp_delete_content",
    {
      title: "Borrar entrada/página",
      description:
        "Envía a la papelera una entrada/página. Con force=true la elimina permanentemente (requiere confirm=true).",
      inputSchema: {
        type: typeArg,
        id: z.number().int(),
        force: z.boolean().default(false).describe("Borrado permanente, saltándose la papelera"),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ type, id, force, confirm }) => {
      ctx.guards.assertWritable("borrar contenido");
      if (force) ctx.guards.assertConfirmed(confirm, `borrar permanentemente ${type}/${id}`);
      const route = await collectionRoute(ctx, type);
      const { data } = await ctx.rest.delete<WpPost | { deleted: boolean; previous: WpPost }>(`${route}/${id}`, {
        force: force || undefined,
      });
      return json(force ? { deleted_permanently: true, id } : { trashed: summarize(data as WpPost) });
    }),
  );

  server.registerTool(
    "wp_list_revisions",
    {
      title: "Listar revisiones",
      description: "Lista las revisiones de una entrada/página (para ver o recuperar versiones anteriores).",
      inputSchema: { type: typeArg, id: z.number().int(), include_content: z.boolean().default(false) },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ type, id, include_content }) => {
      const route = await collectionRoute(ctx, type);
      const { data } = await ctx.rest.get<WpPost[]>(`${route}/${id}/revisions`, { context: "edit", per_page: 20 });
      return json(
        data.map((r) => ({
          id: r.id,
          date: r.date,
          author: r.author,
          title: r.title?.raw,
          ...(include_content ? { content: r.content?.raw } : {}),
        })),
      );
    }),
  );
};
