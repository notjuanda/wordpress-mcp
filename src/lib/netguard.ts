import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { ToolError } from "./result.js";

// ── Clasificación de direcciones ──────────────────────────────────────

function ipv4ToOctets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? nums : null;
}

function isNonPublicIpv4(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast + reservado + broadcast
  );
}

/** Expande una IPv6 (incluida la forma con IPv4 embebida) a 8 grupos de 16 bits. */
function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const o = ipv4ToOctets(v4[1]!);
    if (!o) return null;
    s = s.slice(0, -v4[1]!.length) + `${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string) => (h ? h.split(":") : []);
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * true si la dirección NO es pública (loopback, privada, link-local, CGNAT, documentación, multicast,
 * o IPv6 que embebe una IPv4 no pública). Cualquier cosa que no se pueda interpretar se considera no pública.
 */
export function isNonPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const o = ipv4ToOctets(address);
    return !o || isNonPublicIpv4(o);
  }
  if (kind !== 6) return true;
  const h = expandIpv6(address);
  if (!h) return true;
  const embedded = (hi: number, lo: number) => isNonPublicIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  const zeros = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return true; // ::
  if (zeros(0, 7) && h[7] === 1) return true; // ::1
  if (zeros(0, 5) && h[5] === 0xffff) return embedded(h[6]!, h[7]!); // ::ffff:a.b.c.d (mapeada)
  if (zeros(0, 6)) return true; // ::a.b.c.d (compatible, obsoleta)
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) return embedded(h[6]!, h[7]!); // NAT64
  if (h[0] === 0x2002) return embedded(h[1]!, h[2]!); // 6to4
  if (h[0] === 0x2001 && h[1] === 0) return true; // Teredo
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentación
  if ((h[0]! & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((h[0]! & 0xffc0) === 0xfe80 || (h[0]! & 0xffc0) === 0xfec0) return true; // link/site-local
  if ((h[0]! & 0xff00) === 0xff00) return true; // multicast
  return false;
}

// ── Descarga con IP fijada ────────────────────────────────────────────

/**
 * lookup para http(s).request que valida TODAS las direcciones resueltas y devuelve exactamente esas
 * al socket. Como la misma resolución se valida y se usa para conectar, no hay ventana de DNS rebinding.
 */
function guardedLookup(
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as LookupAddress[];
    if (!list.length || list.some((a) => isNonPublicAddress(a.address))) {
      return callback(new ToolError(`URL bloqueada: ${hostname} resuelve a una dirección privada/local.`), "", 0);
    }
    if (options.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

export interface Download {
  data: Buffer;
  contentType?: string;
  finalUrl: URL;
}

/** Descarga una URL pública (http/https) siguiendo hasta 5 redirecciones, cada una revalidada, con tope de bytes. */
export async function safeDownload(rawUrl: string, opts: { timeoutMs: number; maxBytes: number }): Promise<Download> {
  let current = new URL(rawUrl);
  for (let hop = 0; hop <= 5; hop++) {
    if (current.protocol !== "https:" && current.protocol !== "http:") {
      throw new ToolError(`Protocolo no permitido: ${current.protocol}`);
    }
    if (current.username || current.password) throw new ToolError("No se permiten credenciales en la URL.");
    const host = current.hostname.replace(/^\[|\]$/g, "");
    // Los literales IP no pasan por lookup: se validan aquí.
    if (isIP(host) && isNonPublicAddress(host)) {
      throw new ToolError(`URL bloqueada: ${current.hostname} es una dirección privada/local.`);
    }

    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const mod = current.protocol === "https:" ? https : http;
      const req = mod.request(current, { method: "GET", lookup: guardedLookup, headers: { "User-Agent": "wordpress-mcp" } }, resolve);
      req.setTimeout(opts.timeoutMs, () => req.destroy(new ToolError(`Timeout descargando ${current.href}`)));
      req.on("error", reject);
      req.end();
    });

    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, current);
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new ToolError(`No se pudo descargar ${current.href}: HTTP ${status}`);
    }
    const declared = Number(res.headers["content-length"] ?? 0);
    if (declared > opts.maxBytes) {
      res.destroy();
      throw new ToolError(`Archivo demasiado grande (${declared} bytes, máx. ${opts.maxBytes}).`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res) {
      size += (chunk as Buffer).length;
      if (size > opts.maxBytes) {
        res.destroy();
        throw new ToolError(`Archivo demasiado grande (más de ${opts.maxBytes} bytes).`);
      }
      chunks.push(chunk as Buffer);
    }
    return { data: Buffer.concat(chunks), contentType: res.headers["content-type"]?.split(";")[0], finalUrl: current };
  }
  throw new ToolError("Demasiadas redirecciones.");
}
