/**
 * Diagnóstico de conexión: `npm run check`
 * Verifica .env, REST API (autenticación) y SSH/WP-CLI sin arrancar el servidor MCP.
 */
import { loadConfig } from "./config.js";
import { createContext } from "./context.js";

const ok = (m: string) => console.log(`  ✔ ${m}`);
const fail = (m: string) => console.log(`  ✘ ${m}`);

async function main() {
  console.log("\n1) Configuración");
  const cfg = loadConfig();
  ok(`.env válido · sitio ${cfg.WP_URL} · usuario ${cfg.WP_USERNAME}`);
  ok(`modo ${cfg.READ_ONLY ? "SOLO LECTURA" : "lectura/escritura"} · escritura permitida en: ${cfg.WRITE_ALLOWED_PATHS.join(", ")}`);
  const ctx = createContext(cfg);
  let failed = false;

  console.log("\n2) REST API");
  try {
    const { data } = await ctx.rest.get<{ name: string; namespaces: string[] }>("");
    ok(`REST accesible: "${data.name}" (${data.namespaces.length} namespaces)`);
    const { data: me } = await ctx.rest.get<{ name: string; roles: string[] }>("wp/v2/users/me", { context: "edit" });
    ok(`autenticado como ${me.name} [${me.roles.join(", ")}]`);
    if (!me.roles.includes("administrator")) fail("el usuario no es administrador: muchas herramientas fallarán");
  } catch (err) {
    failed = true;
    fail((err as Error).message);
  }

  console.log("\n3) SSH / WP-CLI");
  if (!cfg.sshEnabled) {
    console.log("  – no configurado (opcional, pero necesario para archivos, WP-CLI y chequeos)");
  } else {
    try {
      const who = await ctx.ssh.exec("whoami && uname -sr");
      ok(`SSH conectado: ${who.stdout.trim().replace(/\n/g, " · ")}`);
      if (cfg.SSH_HOST_FINGERPRINT) ok("identidad del servidor verificada (SSH_HOST_FINGERPRINT)");
      else console.log(`  ! añade a .env para verificar el servidor: SSH_HOST_FINGERPRINT=${ctx.ssh.lastHostFingerprint}`);
      const st = await ctx.ssh.stat(`${cfg.WP_ROOT}/wp-config.php`);
      st ? ok(`WP_ROOT correcto (${cfg.WP_ROOT})`) : fail(`no hay wp-config.php en WP_ROOT=${cfg.WP_ROOT}`);
      const v = await ctx.ssh.wp(["core", "version"]);
      v.code === 0 ? ok(`WP-CLI funciona · WordPress ${v.stdout.trim()}`) : fail(`WP-CLI falló: ${v.stderr || v.stdout}`);
      if (!st || v.code !== 0) failed = true;
    } catch (err) {
      failed = true;
      fail((err as Error).message);
    } finally {
      ctx.ssh.close();
    }
  }

  console.log(failed ? "\nHay problemas que resolver.\n" : "\nTodo listo.\n");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n  ✘ ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
