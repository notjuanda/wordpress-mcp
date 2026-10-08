import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PROJECT_ROOT } from "../config.js";
import type { ToolModule } from "../context.js";
import { safeDownload } from "../lib/netguard.js";
import { json, safe, ToolError } from "../lib/result.js";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const within = (file: string, dir: string) => {
  const f = file.toLowerCase();
  const d = path.resolve(dir).toLowerCase();
  return f === d || f.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
};

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".zip": "application/zip",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".json": "application/json",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Archivos locales que nunca deben acabar en la biblioteca de medios pública. */
const SENSITIVE_LOCAL =
  /^(\.env(\..*)?|id_[a-z0-9]+.*|.*\.(pem|key|ppk|kdbx|p12|pfx|jks|keystore|sql|sql\.gz|dump|bak|sqlite|db)|credentials.*|.*secret.*|\.git-credentials|\.netrc|_netrc|\.npmrc|\.pypirc|\.pgpass|\.my\.cnf|wp-config.*\.php.*|auth\.json|known_hosts|authorized_keys|login data|cookies|web data)$/i;
/** Directorios locales (en cualquier nivel) que nunca se suben. */
const SENSITIVE_DIRS = /[\\/]\.(ssh|aws|gnupg|config|kube|docker|azure|gcloud|git)[\\/]|[\\/](appdata)[\\/]/i;

interface WpMedia {
  id: number;
  title: { raw?: string; rendered: string };
  alt_text: string;
  caption: { raw?: string; rendered: string };
  description: { raw?: string; rendered: string };
  media_type: string;
  mime_type: string;
  source_url: string;
  post: number | null;
  date: string;
  media_details?: { width?: number; height?: number; filesize?: number };
}

const summarize = (m: WpMedia) => ({
  id: m.id,
  title: m.title?.raw ?? m.title?.rendered,
  alt_text: m.alt_text,
  caption: m.caption?.raw,
  mime_type: m.mime_type,
  url: m.source_url,
  attached_to: m.post,
  width: m.media_details?.width,
  height: m.media_details?.height,
  date: m.date,
});

export const registerMediaTools: ToolModule = (server, ctx) => {
  server.registerTool(
    "wp_list_media",
    {
      title: "Listar medios",
      description: "Lista archivos de la biblioteca de medios.",
      inputSchema: {
        search: z.string().optional(),
        media_type: z.enum(["image", "video", "audio", "application", "text"]).optional(),
        mime_type: z.string().optional(),
        parent: z.number().int().optional().describe("Solo medios adjuntos a este post"),
        per_page: z.number().int().min(1).max(100).default(30),
        page: z.number().int().min(1).default(1),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ per_page, page, ...q }) => {
      const res = await ctx.rest.get<WpMedia[]>("wp/v2/media", { ...q, per_page, page, context: "edit" });
      return json({ total: res.total, totalPages: res.totalPages, items: res.data.map(summarize) });
    }),
  );

  server.registerTool(
    "wp_upload_media",
    {
      title: "Subir medio",
      description: "Sube un archivo a la biblioteca de medios desde una ruta LOCAL de este PC o desde una URL pública.",
      inputSchema: {
        file_path: z.string().optional().describe("Ruta local absoluta del archivo"),
        url: z.string().url().optional().describe("URL pública desde la que descargar el archivo"),
        filename: z.string().optional().describe("Nombre final del archivo (opcional)"),
        title: z.string().optional(),
        alt_text: z.string().optional(),
        caption: z.string().optional(),
        description: z.string().optional(),
        post: z.number().int().optional().describe("ID del post al que adjuntarlo"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    safe(async ({ file_path, url, filename, ...meta }) => {
      ctx.guards.assertWritable("subir medio");
      if (!file_path === !url) throw new ToolError("Indica exactamente uno: file_path o url.");

      let data: Buffer;
      let name: string;
      let contentType: string | undefined;
      if (file_path) {
        const full = await realpath(path.resolve(file_path)).catch(() => {
          throw new ToolError(`No existe el archivo local: ${file_path}`);
        });
        if (SENSITIVE_LOCAL.test(path.basename(full)) || SENSITIVE_DIRS.test(full)) {
          throw new ToolError(`Por seguridad no se suben archivos locales sensibles: ${full}`);
        }
        // Nunca desde el propio proyecto (contiene .env) ni desde las copias de seguridad (volcados de BD).
        if (within(full, ctx.cfg.BACKUP_DIR) || within(full, PROJECT_ROOT)) {
          throw new ToolError("Por seguridad no se suben archivos de la carpeta del MCP ni de sus copias de seguridad.");
        }
        const dirs = ctx.cfg.LOCAL_UPLOAD_DIRS;
        if (dirs.length && !dirs.some((d) => within(full, d))) {
          throw new ToolError(`Solo se pueden subir archivos desde: ${dirs.join("; ")} (LOCAL_UPLOAD_DIRS).`);
        }
        const st = await stat(full);
        if (!st.isFile()) throw new ToolError(`${full} no es un archivo normal.`);
        if (st.size > MAX_UPLOAD_BYTES) throw new ToolError(`Archivo demasiado grande (${st.size} bytes, máx. ${MAX_UPLOAD_BYTES}).`);
        data = await readFile(full);
        const original = path.basename(full);
        // filename puede renombrar, pero no cambiar la extensión (evita disfrazar un archivo como otro tipo).
        if (filename && path.extname(filename).toLowerCase() !== path.extname(original).toLowerCase()) {
          throw new ToolError(`filename debe conservar la extensión del archivo original (${path.extname(original) || "sin extensión"}).`);
        }
        name = filename ?? original;
      } else {
        const dl = await safeDownload(url!, { timeoutMs: ctx.cfg.REQUEST_TIMEOUT_MS, maxBytes: MAX_UPLOAD_BYTES });
        data = dl.data;
        let base = path.posix.basename(dl.finalUrl.pathname);
        try {
          base = decodeURIComponent(base);
        } catch {
          /* nombre con % mal formado: se usa tal cual */
        }
        name = filename ?? (base || "archivo");
        contentType = dl.contentType;
      }
      if (/[\\/]/.test(name)) throw new ToolError("filename no puede contener rutas.");
      contentType = MIME[path.extname(name).toLowerCase()] ?? contentType ?? "application/octet-stream";

      const { data: created } = await ctx.rest.request<WpMedia>("wp/v2/media", {
        method: "POST",
        raw: { data, contentType, filename: name },
      });

      const fields = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined));
      const final =
        Object.keys(fields).length > 0
          ? (await ctx.rest.post<WpMedia>(`wp/v2/media/${created.id}`, fields)).data
          : created;
      return json({ uploaded: summarize(final) });
    }),
  );

  server.registerTool(
    "wp_update_media",
    {
      title: "Actualizar medio",
      description: "Actualiza título, texto alternativo, leyenda, descripción o post asociado de un medio.",
      inputSchema: {
        id: z.number().int(),
        title: z.string().optional(),
        alt_text: z.string().optional(),
        caption: z.string().optional(),
        description: z.string().optional(),
        post: z.number().int().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    safe(async ({ id, ...fields }) => {
      ctx.guards.assertWritable("actualizar medio");
      const { data } = await ctx.rest.post<WpMedia>(`wp/v2/media/${id}`, fields);
      return json({ updated: summarize(data) });
    }),
  );

  server.registerTool(
    "wp_delete_media",
    {
      title: "Borrar medio",
      description: "Elimina permanentemente un medio y sus archivos (los medios no tienen papelera). Requiere confirm=true.",
      inputSchema: { id: z.number().int(), confirm: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    safe(async ({ id, confirm }) => {
      ctx.guards.assertWritable("borrar medio");
      ctx.guards.assertConfirmed(confirm, `borrar medio ${id}`);
      await ctx.rest.delete(`wp/v2/media/${id}`, { force: true });
      return json({ deleted: true, id });
    }),
  );
};
