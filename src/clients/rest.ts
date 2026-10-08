import type { Config } from "../config.js";
import { ToolError } from "../lib/result.js";

export type Query = Record<string, string | number | boolean | Array<string | number> | undefined | null>;

export interface RestResponse<T = unknown> {
  data: T;
  status: number;
  total?: number;
  totalPages?: number;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Query;
  body?: unknown;
  /** Cuerpo binario (subida de medios). */
  raw?: { data: Buffer; contentType: string; filename: string };
}

/**
 * true si PHP convertiría la clave en `_method` al construir $_GET (quita espacios iniciales,
 * corta en '[', y ' ' / '.' pasan a '_'). WordPress usa $_GET['_method'] como método efectivo.
 */
function isMethodOverrideKey(key: string): boolean {
  const php = key.replace(/^ +/, "").split("[")[0]!.replace(/[ .]/g, "_");
  return php.toLowerCase() === "_method";
}

/** Cliente mínimo de la REST API de WordPress autenticado con Application Password. */
export class WpRestClient {
  private readonly base: string;
  private readonly auth: string;

  constructor(private readonly cfg: Config) {
    this.base = `${cfg.WP_URL}/wp-json`;
    this.auth = `Basic ${Buffer.from(`${cfg.WP_USERNAME}:${cfg.WP_APP_PASSWORD}`).toString("base64")}`;
  }

  /**
   * Construye la URL y garantiza que queda dentro de <WP_URL>/wp-json/ en el mismo origen.
   * La validación se hace sobre la URL YA normalizada (así `%2e%2e`, `\..` etc. no pueden escapar).
   */
  buildUrl(route: string, query?: Query): URL {
    if (/[?#\\]|%2e|%2f|%5c|%00/i.test(route)) {
      throw new ToolError("Ruta REST no permitida: usa 'query' para parámetros y no incluyas '?', '#', '\\' ni caracteres codificados.");
    }
    const clean = route.replace(/^\/?(wp-json\/)?/, "");
    const baseUrl = new URL(this.base);
    const url = new URL(`${this.base}/${clean}`);
    if (url.origin !== baseUrl.origin || !url.pathname.startsWith(`${baseUrl.pathname}/`)) {
      throw new ToolError("La ruta REST debe quedar dentro de /wp-json.");
    }
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      if (isMethodOverrideKey(k)) {
        throw new ToolError("No se permite '_method' en la query: usa el método HTTP real.");
      }
      url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    return url;
  }

  async request<T = unknown>(route: string, opts: RequestOptions = {}): Promise<RestResponse<T>> {
    const method = opts.method ?? "GET";
    // Defensa en profundidad: aunque cada herramienta compruebe READ_ONLY, el cliente nunca envía escrituras en ese modo.
    if (method !== "GET" && this.cfg.READ_ONLY) {
      throw new ToolError(`Modo solo lectura activo (READ_ONLY=true). Petición bloqueada: ${method} ${route}`);
    }
    const url = this.buildUrl(route, opts.query);
    const headers: Record<string, string> = {
      Authorization: this.auth,
      Accept: "application/json",
      "User-Agent": "wordpress-mcp/0.1",
    };

    let body: Uint8Array | string | undefined;
    if (opts.raw) {
      headers["Content-Type"] = opts.raw.contentType;
      headers["Content-Disposition"] = `attachment; filename="${encodeURIComponent(opts.raw.filename)}"`;
      body = new Uint8Array(opts.raw.data);
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        // No seguir redirecciones: evita reenviar la Application Password a otra URL.
        redirect: "manual",
        signal: AbortSignal.timeout(this.cfg.REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ToolError(`No se pudo conectar con ${url.origin}: ${(err as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400) {
      throw new ToolError(
        `WordPress respondió con una redirección (${res.status} → ${res.headers.get("location") ?? "?"}). ` +
          "Revisa que WP_URL sea la URL canónica exacta (https, con o sin www).",
      );
    }

    const textBody = await res.text();
    let data: unknown = textBody;
    try {
      data = textBody ? JSON.parse(textBody) : null;
    } catch {
      /* respuesta no JSON (p. ej. HTML de error del servidor) */
    }

    if (!res.ok) {
      const wpErr = data as { code?: string; message?: string; data?: unknown } | string;
      const hint = res.status === 401 ? this.authHint(wpErr) : "";
      if (typeof wpErr === "object" && wpErr?.code) {
        throw new ToolError(`WordPress ${res.status} ${wpErr.code}: ${wpErr.message ?? ""}${hint}`, wpErr.data);
      }
      throw new ToolError(`HTTP ${res.status} en ${method} ${url.pathname}${hint}\n${String(textBody).slice(0, 2000)}`);
    }

    const total = res.headers.get("x-wp-total");
    const totalPages = res.headers.get("x-wp-totalpages");
    return {
      data: data as T,
      status: res.status,
      total: total ? Number(total) : undefined,
      totalPages: totalPages ? Number(totalPages) : undefined,
    };
  }

  get<T = unknown>(route: string, query?: Query) {
    return this.request<T>(route, { query });
  }
  post<T = unknown>(route: string, body?: unknown, query?: Query) {
    return this.request<T>(route, { method: "POST", body, query });
  }
  delete<T = unknown>(route: string, query?: Query) {
    return this.request<T>(route, { method: "DELETE", query });
  }

  private authHint(err: unknown): string {
    const code = typeof err === "object" && err ? (err as { code?: string }).code : undefined;
    if (code === "rest_not_logged_in" || code === "rest_forbidden") {
      return (
        "\nPista: WordPress no recibió las credenciales. En Hostinger/LiteSpeed/Apache a veces se elimina la " +
        "cabecera Authorization; añade en .htaccess: `SetEnvIf Authorization \"(.*)\" HTTP_AUTHORIZATION=$1`"
      );
    }
    return "\nPista: revisa WP_USERNAME y WP_APP_PASSWORD (Application Password, no la contraseña normal).";
  }
}
