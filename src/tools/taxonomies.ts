import { z } from "zod";
import type { Ctx, ToolModule } from "../context.js";
import { json, safe, ToolError } from "../lib/result.js";

interface WpTaxonomy {
  slug: string;
  name: string;
  rest_base: string;
  rest_namespace?: string;
  types: string[];
}

interface WpTerm {
  id: number;
  name: string;
  slug: string;
  count: number;
  parent?: number;
  description?: string;
  taxonomy: string;
}

async function taxonomyRoute(ctx: Ctx, taxonomy: string): Promise<string> {
  const { data } = await ctx.rest.get<Record<string, WpTaxonomy>>("wp/v2/taxonomies", { context: "edit" });
  const t = Object.values(data).find((x) => x.slug === taxonomy || x.rest_base === taxonomy);
  if (!t) {
    throw new ToolError(
      `Taxonomía desconocida "${taxonomy}". Disponibles: ${Object.values(data)
        .map((x) => `${x.slug} (${x.rest_base})`)
        .join(", ")}`,
    );
  }
  return `${t.rest_namespace ?? "wp/v2"}/${t.rest_base}`;
}

const taxArg = z
  .string()
  .default("categories")
  .describe('"categories", "tags" o el slug/rest_base de una taxonomía personalizada (p. ej. "product_cat")');

const summarize = (t: WpTerm) => ({
  id: t.id,
  name: t.name,
  slug: t.slug,
  parent: t.parent,
  count: t.count,
  description: t.description || undefined,
});

export const registerTaxonomyTools: ToolModule = (server, ctx) => {
  server.registerTool(
    "wp_list_taxonomies",
    {
      title: "Listar taxonomías",
      description: "Lista las taxonomías registradas (categorías, etiquetas y personalizadas).",
      annotations: { readOnlyHint: true },
    },
    safe(async () => {
      const { data } = await ctx.rest.get<Record<string, WpTaxonomy>>("wp/v2/taxonomies", { context: "edit" });
      return json(Object.values(data).map((t) => ({ slug: t.slug, name: t.name, rest_base: t.rest_base, types: t.types })));
    }),
  );

  server.registerTool(
    "wp_list_terms",
    {
      title: "Listar términos",
      description: "Lista términos de una taxonomía (categorías, etiquetas…).",
      inputSchema: {
        taxonomy: taxArg,
        search: z.string().optional(),
        parent: z.number().int().optional(),
        hide_empty: z.boolean().default(false),
        per_page: z.number().int().min(1).max(100).default(100),
        page: z.number().int().min(1).default(1),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ taxonomy, ...q }) => {
      const res = await ctx.rest.get<WpTerm[]>(await taxonomyRoute(ctx, taxonomy), { ...q, context: "edit" });
      return json({ total: res.total, totalPages: res.totalPages, items: res.data.map(summarize) });
    }),
  );

  server.registerTool(
    "wp_upsert_term",
    {
      title: "Crear/actualizar término",
      description: "Crea un término (sin id) o actualiza uno existente (con id).",
      inputSchema: {
        taxonomy: taxArg,
        id: z.number().int().optional(),
        name: z.string().optional(),
        slug: z.string().optional(),
        description: z.string().optional(),
        parent: z.number().int().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ taxonomy, id, ...fields }) => {
      ctx.guards.assertWritable("crear/actualizar término");
      if (!id && !fields.name) throw new ToolError("Para crear un término hace falta 'name'.");
      const route = await taxonomyRoute(ctx, taxonomy);
      const { data } = await ctx.rest.post<WpTerm>(id ? `${route}/${id}` : route, fields);
      return json({ [id ? "updated" : "created"]: summarize(data) });
    }),
  );

  server.registerTool(
    "wp_delete_term",
    {
      title: "Borrar término",
      description: "Elimina permanentemente un término (los términos no tienen papelera). Requiere confirm=true.",
      inputSchema: { taxonomy: taxArg, id: z.number().int(), confirm: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ taxonomy, id, confirm }) => {
      ctx.guards.assertWritable("borrar término");
      ctx.guards.assertConfirmed(confirm, `borrar término ${taxonomy}/${id}`);
      await ctx.rest.delete(`${await taxonomyRoute(ctx, taxonomy)}/${id}`, { force: true });
      return json({ deleted: true, taxonomy, id });
    }),
  );
};
