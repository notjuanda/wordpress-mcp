import type { Ctx } from "../context.js";

/**
 * Vacía la caché de Elementor (HTML de widgets + CSS) y la caché de página de Hostinger.
 * Nunca lanza: devuelve qué se pudo limpiar (los endpoints solo existen si el plugin está activo).
 */
export async function clearCaches(ctx: Ctx): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const attempts: Array<[string, string]> = [
    ["elementor", "elementor/v1/cache"],
    ["hostinger", "hostinger-tools-plugin/v1/clear-cache"],
  ];
  for (const [name, route] of attempts) {
    try {
      await ctx.rest.delete(route);
      out[name] = "ok";
    } catch (err) {
      out[name] = (err as Error).message.split("\n")[0]!.slice(0, 120);
    }
  }
  return out;
}
