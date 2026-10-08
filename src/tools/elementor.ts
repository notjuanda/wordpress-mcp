import { z } from "zod";
import type { Ctx, ToolModule } from "../context.js";
import { clearCaches } from "../lib/cache.js";
import { json, safe, text, ToolError } from "../lib/result.js";
import { collectionRoute } from "./content.js";

/**
 * Elementor guarda el diseño en el meta `_elementor_data` (JSON). Elementor lo expone en la REST API
 * (context=edit), así que se lee y escribe sin SSH. Tras escribir hay que vaciar la caché de Elementor
 * (DELETE elementor/v1/cache): si no, sigue sirviendo el HTML cacheado de los widgets.
 */

interface ElNode {
  id: string;
  elType: string;
  widgetType?: string;
  settings?: Record<string, unknown>;
  elements?: ElNode[];
}

interface ElPost {
  id: number;
  type: string;
  title: { raw: string };
  meta?: { _elementor_edit_mode?: string; _elementor_data?: string };
}

const BACKUP_PREFIX = "elementor:post/";

async function readData(ctx: Ctx, type: string, id: number): Promise<{ route: string; raw: string; tree: ElNode[]; title: string }> {
  const route = `${await collectionRoute(ctx, type)}/${id}`;
  const { data } = await ctx.rest.get<ElPost>(route, { context: "edit", _fields: "id,type,title,meta" });
  if (data.meta?._elementor_edit_mode !== "builder" || !data.meta._elementor_data) {
    throw new ToolError(`El ${type} ${id} no está construido con Elementor. Usa wp_get_content / wp_replace_in_content.`);
  }
  const raw = data.meta._elementor_data;
  try {
    return { route, raw, tree: JSON.parse(raw) as ElNode[], title: data.title.raw };
  } catch {
    throw new ToolError(`_elementor_data de ${type}/${id} no es JSON válido.`);
  }
}

async function writeData(ctx: Ctx, route: string, id: number, tree: ElNode[], previousRaw: string, reason: string) {
  ctx.guards.assertWritable("editar página de Elementor");
  const backup = await ctx.backups.save(`${BACKUP_PREFIX}${route}`, Buffer.from(previousRaw, "utf8"), reason);
  await ctx.rest.post(route, { meta: { _elementor_data: JSON.stringify(tree) } });
  return { backup_id: backup.id, cache: await clearCaches(ctx) };
}

function walk(nodes: ElNode[], fn: (n: ElNode, depth: number) => void, depth = 0): void {
  for (const n of nodes) {
    fn(n, depth);
    if (n.elements?.length) walk(n.elements, fn, depth + 1);
  }
}

const STYLE_KEY = /(color|typography|size|margin|padding|border|radius|shadow|width|height|gap|align|position|z_index|opacity|animation|motion|css|_hover|flex|overflow|structure|layout|direction|order|object-fit|background_(?!image))/i;
const STYLE_VAL = /^(#[0-9a-f]{3,8}|rgba?\(.*\)|-?\d+(\.\d+)?(px|em|rem|%|vh|vw)?|yes|no|default|custom|none|inherit|library|classic|gradient)$/i;

const NOISE_KEYS = new Set(["id", "source", "ai", "unit", "sizes", "isLinked", "space", "image_size", "html_tag", "header_size", "view"]);

/** Extrae los valores "de contenido" (textos, enlaces, imágenes) de los settings de un widget. */
function contentFields(settings: unknown, prefix = ""): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (Array.isArray(settings)) {
    settings.forEach((v, i) => out.push(...contentFields(v, `${prefix}[${i}]`)));
  } else if (settings && typeof settings === "object") {
    for (const [k, v] of Object.entries(settings)) {
      if (k.startsWith("_") || STYLE_KEY.test(k) || NOISE_KEYS.has(k)) continue;
      out.push(...contentFields(v, prefix ? `${prefix}.${k}` : k));
    }
  } else if (typeof settings === "string" && settings.trim() && !STYLE_VAL.test(settings.trim())) {
    out.push([prefix, settings]);
  }
  return out;
}

const plain = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** Reemplaza texto literal en todos los strings de los settings. */
function replaceDeep(value: unknown, find: string, replace: string, counter: { n: number }): unknown {
  if (typeof value === "string") {
    if (!value.includes(find)) return value;
    counter.n += value.split(find).length - 1;
    return value.split(find).join(replace);
  }
  if (Array.isArray(value)) return value.map((v) => replaceDeep(v, find, replace, counter));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceDeep(v, find, replace, counter)]));
  }
  return value;
}

/**
 * Aplica replaceDeep solo a los settings de contenido de cada elemento: nunca a id/elType/widgetType
 * ni a ajustes internos `_*` (CSS personalizado, atributos), que elementor_get_page no muestra.
 */
function replaceInTree(nodes: ElNode[], find: string, replace: string, counter: { n: number }): ElNode[] {
  return nodes.map((n) => ({
    ...n,
    settings: n.settings
      ? Object.fromEntries(
          Object.entries(n.settings).map(([k, v]) => [k, k.startsWith("_") ? v : replaceDeep(v, find, replace, counter)]),
        )
      : n.settings,
    elements: n.elements ? replaceInTree(n.elements, find, replace, counter) : n.elements,
  }));
}

const typeArg = z.string().default("pages").describe('"pages", "posts" o un custom post type');

export const registerElementorTools: ToolModule = (server, ctx) => {
  server.registerTool(
    "elementor_get_page",
    {
      title: "Leer página de Elementor",
      description:
        "Muestra la estructura de una página hecha con Elementor: contenedores y widgets con su id, tipo y contenidos " +
        "(textos, botones, enlaces, imágenes). Los id sirven para elementor_update_element.",
      inputSchema: {
        id: z.number().int().describe("ID de la página/entrada"),
        type: typeArg,
        raw: z.boolean().default(false).describe("Devolver el JSON completo sin resumir (puede ser muy largo)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ id, type, raw }) => {
      const data = await readData(ctx, type, id);
      if (raw) return text(data.raw);
      const lines: string[] = [`# Elementor · ${type}/${id} · "${data.title}"`];
      walk(data.tree, (n, depth) => {
        const pad = "  ".repeat(depth);
        const label = n.widgetType ?? n.elType;
        const name = typeof n.settings?._title === "string" ? ` "${n.settings._title}"` : "";
        lines.push(`${pad}- ${label} #${n.id}${name}`);
        for (const [k, v] of contentFields(n.settings ?? {})) lines.push(`${pad}    ${k}: ${plain(v).slice(0, 220)}`);
      });
      return text(lines.join("\n"));
    }),
  );

  server.registerTool(
    "elementor_replace_text",
    {
      title: "Reemplazar texto en página de Elementor",
      description:
        "Reemplaza un texto literal en todos los widgets de una página de Elementor (títulos, párrafos, botones, enlaces, URLs de imágenes…). " +
        "Guarda copia previa y vacía la caché para que el cambio se vea.",
      inputSchema: {
        id: z.number().int(),
        type: typeArg,
        find: z.string().min(1),
        replace: z.string(),
        replace_all: z.boolean().default(false).describe("Permitir más de una coincidencia"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ id, type, find, replace, replace_all }) => {
      const data = await readData(ctx, type, id);
      const counter = { n: 0 };
      const tree = replaceInTree(data.tree, find, replace, counter);
      if (counter.n === 0) {
        throw new ToolError("El texto no aparece en la página. Usa elementor_get_page para ver los textos exactos (pueden tener etiquetas HTML).");
      }
      if (counter.n > 1 && !replace_all) {
        throw new ToolError(`El texto aparece ${counter.n} veces. Usa replace_all=true o un fragmento más específico.`);
      }
      const res = await writeData(ctx, data.route, id, tree, data.raw, "elementor_replace_text");
      return json({ updated: `${type}/${id}`, replacements: counter.n, ...res });
    }),
  );

  server.registerTool(
    "elementor_update_element",
    {
      title: "Modificar widget de Elementor",
      description:
        "Cambia settings de un elemento concreto (id obtenido con elementor_get_page). Se fusionan con los existentes. " +
        'Ej.: {"title":"Nuevo título"}, {"editor":"<p>Texto</p>"}, {"text":"Reservar","link":{"url":"https://…"}}, ' +
        '{"image":{"url":"https://…/foto.jpg","id":123}}, {"title_color":"#FF0000"}.',
      inputSchema: {
        id: z.number().int().describe("ID de la página"),
        type: typeArg,
        element_id: z.string().min(1),
        settings: z.record(z.string(), z.unknown()),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ id, type, element_id, settings }) => {
      const data = await readData(ctx, type, id);
      let target: ElNode | undefined;
      walk(data.tree, (n) => {
        if (n.id === element_id) target = n;
      });
      if (!target) throw new ToolError(`No existe el elemento #${element_id} en ${type}/${id}.`);
      const before = Object.fromEntries(Object.keys(settings).map((k) => [k, target!.settings?.[k]]));
      target.settings = { ...(target.settings ?? {}), ...settings };
      const res = await writeData(ctx, data.route, id, data.tree, data.raw, "elementor_update_element");
      return json({ updated: `${type}/${id}`, element: `${target.widgetType ?? target.elType}#${element_id}`, before, after: settings, ...res });
    }),
  );

  server.registerTool(
    "elementor_restore_backup",
    {
      title: "Restaurar página de Elementor",
      description: "Restaura una página de Elementor a la copia guardada antes de un cambio (ver fs_list_backups con filter 'elementor').",
      inputSchema: { backup_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ backup_id }) => {
      ctx.guards.assertWritable("restaurar página de Elementor");
      const { entry, content } = await ctx.backups.get(backup_id);
      if (!entry.remotePath.startsWith(BACKUP_PREFIX) || !content) {
        throw new ToolError("Esa copia no es de una página de Elementor (usa fs_restore_backup para archivos).");
      }
      const route = entry.remotePath.slice(BACKUP_PREFIX.length);
      const { data } = await ctx.rest.get<ElPost>(route, { context: "edit", _fields: "id,meta" });
      const safety = await ctx.backups.save(entry.remotePath, Buffer.from(data.meta?._elementor_data ?? "", "utf8"), `antes de restaurar ${backup_id}`);
      await ctx.rest.post(route, { meta: { _elementor_data: content.toString("utf8") } });
      return json({ restored: route, from: entry.createdAt, backup_of_current: safety.id, cache: await clearCaches(ctx) });
    }),
  );

  server.registerTool(
    "wp_clear_cache",
    {
      title: "Vaciar cachés",
      description:
        "Vacía la caché de Elementor (CSS y HTML de widgets) y la caché de página de Hostinger. " +
        "Úsala si un cambio no se ve en la web.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    safe(async () => {
      ctx.guards.assertWritable("vaciar cachés");
      return json(await clearCaches(ctx));
    }),
  );
};
