#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createContext, type ToolModule } from "./context.js";
import { registerCliTools } from "./tools/cli.js";
import { registerContentTools } from "./tools/content.js";
import { registerElementorTools } from "./tools/elementor.js";
import { registerExtensionTools } from "./tools/extensions.js";
import { registerFileTools } from "./tools/files.js";
import { registerHealthTools } from "./tools/health.js";
import { registerMediaTools } from "./tools/media.js";
import { registerSiteTools } from "./tools/site.js";
import { registerTaxonomyTools } from "./tools/taxonomies.js";

// Importante: en transporte stdio, stdout es el canal del protocolo. Todo log va a stderr.
const log = (...args: unknown[]) => console.error("[wordpress-mcp]", ...args);

const INSTRUCTIONS = `
Servidor MCP para administrar un WordPress self-hosted.
- Empieza con wp_site_info para conocer el sitio, versión, tema y si hay SSH.
- Contenido (entradas, páginas, CPTs): wp_list_content → wp_get_content → wp_replace_in_content (cambios puntuales) o wp_update_content.
- Páginas hechas con Elementor (template "elementor_*" o aviso en wp_get_content): su contenido real NO está en 'content'.
  Usa elementor_get_page → elementor_replace_text / elementor_update_element.
- Archivos (temas, plugins, .htaccess): fs_list / fs_search / fs_read_file → fs_edit_file. Cada escritura crea copia local y valida PHP con rollback automático.
- Edita el tema hijo, no el padre, para que los cambios sobrevivan a actualizaciones.
- Antes de cambios grandes (actualizaciones, search-replace) ejecuta wp_db_backup.
- Para todo lo demás: wp_cli (WP-CLI) o wp_rest_request (cualquier endpoint REST, incl. WooCommerce).
- Las acciones destructivas requieren confirm=true: confírmalas antes con el usuario.
`.trim();

async function main() {
  const cfg = loadConfig();
  const ctx = createContext(cfg);

  const server = new McpServer({ name: "wordpress-mcp", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  const modules: ToolModule[] = [
    registerSiteTools,
    registerContentTools,
    registerElementorTools,
    registerTaxonomyTools,
    registerMediaTools,
    registerExtensionTools,
    registerFileTools,
    registerCliTools,
    registerHealthTools,
  ];
  for (const register of modules) register(server, ctx);

  const shutdown = async () => {
    ctx.ssh.close();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);

  await server.connect(new StdioServerTransport());
  log(
    `conectado a ${cfg.WP_URL} · SSH ${cfg.sshEnabled ? "activo" : "desactivado"} · ${cfg.READ_ONLY ? "SOLO LECTURA" : "lectura/escritura"}`,
  );
}

main().catch((err) => {
  log("error fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
