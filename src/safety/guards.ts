import path from "node:path";
import type { Config } from "../config.js";
import { ToolError } from "../lib/result.js";

const posix = path.posix;

export class Guards {
  constructor(private readonly cfg: Config) {}

  get readOnly(): boolean {
    return this.cfg.READ_ONLY;
  }

  assertWritable(action: string): void {
    if (this.cfg.READ_ONLY) {
      throw new ToolError(`Modo solo lectura activo (READ_ONLY=true). Acción bloqueada: ${action}`);
    }
  }

  /** Exige confirm=true para acciones destructivas o irreversibles. */
  assertConfirmed(confirm: boolean | undefined, action: string): void {
    if (!confirm) {
      throw new ToolError(
        `"${action}" es destructivo o irreversible. Vuelve a llamar con confirm=true después de confirmarlo con el usuario.`,
      );
    }
  }

  /**
   * Resuelve una ruta (absoluta o relativa a WP_ROOT) y garantiza que queda dentro de WP_ROOT.
   * Devuelve la ruta absoluta en el servidor y la relativa a WP_ROOT.
   */
  resolveRemote(input: string): { abs: string; rel: string } {
    const root = this.cfg.WP_ROOT;
    if (!root) throw new ToolError("WP_ROOT no está configurado; las herramientas de archivos requieren SSH.");
    const cleaned = input.trim().replace(/\\/g, "/");
    const abs = posix.normalize(cleaned.startsWith("/") ? cleaned : posix.join(root, cleaned));
    if (abs !== root && !abs.startsWith(`${root}/`)) {
      throw new ToolError(`Ruta fuera de la instalación de WordPress: ${input}`);
    }
    const rel = abs === root ? "" : abs.slice(root.length + 1);
    return { abs, rel };
  }

  /** Comprueba que la ruta (relativa a WP_ROOT) está dentro de WRITE_ALLOWED_PATHS. */
  assertWritablePath(rel: string): void {
    this.assertWritable(`escribir ${rel}`);
    const allowed = this.cfg.WRITE_ALLOWED_PATHS;
    if (allowed.includes("*")) return;
    const ok = allowed.some((p) => rel === p || rel.startsWith(`${p}/`));
    if (!ok) {
      throw new ToolError(
        `Escritura no permitida en "${rel}". Rutas permitidas: ${allowed.join(", ")}. ` +
          `Amplía WRITE_ALLOWED_PATHS en .env si realmente lo necesitas.`,
      );
    }
  }
}

// ── Política de WP-CLI ────────────────────────────────────────────────

/** Subcomandos que nunca se ejecutan sin confirm=true (borran datos o ejecutan código arbitrario). */
const DANGEROUS: string[][] = [
  ["db", "drop"],
  ["db", "reset"],
  ["db", "clean"],
  ["db", "import"],
  ["db", "query"],
  ["site", "empty"],
  ["site", "delete"],
  ["eval"],
  ["eval-file"],
  ["shell"],
  ["search-replace"],
  ["user", "delete"],
  ["plugin", "delete"],
  ["plugin", "uninstall"],
  ["theme", "delete"],
  ["post", "delete"],
  ["term", "delete"],
  ["comment", "delete"],
  ["media", "regenerate"],
  ["core", "update"],
  ["core", "download"],
  ["config", "set"],
  ["config", "delete"],
  ["config", "shuffle-salts"],
  ["config", "create"],
  ["config", "edit"],
  ["db", "export"], // puede dejar el dump dentro de public_html: usa wp_db_backup
  ["package"], // instala código arbitrario en WP-CLI
  ["cli", "update"],
  ["core", "multisite-convert"],
  ["core", "multisite-install"],
  ["user", "reset-password"],
  ["user", "application-password"],
  // Leen/escriben rutas arbitrarias del servidor (no pasan por WRITE_ALLOWED_PATHS):
  ["media", "import"],
  ["export"],
  ["import"],
  ["scaffold"],
  ["i18n"],
  ["server"],
  ["db", "cli"],
  // Devuelven secretos de wp-config.php sin redactar:
  ["config", "get"],
  ["config", "list"],
];

/** Verbos que modifican algo: si aparece cualquiera, el comando NO es de solo lectura. */
const WRITE_VERBS = new Set([
  "add", "update", "create", "delete", "set", "patch", "activate", "deactivate", "install", "uninstall", "toggle",
  "import", "export", "flush", "reset", "generate", "regenerate", "run", "edit", "enable", "disable", "remove",
  "empty", "clean", "optimize", "repair", "shuffle-salts", "convert", "spam", "unspam", "trash", "untrash",
  "approve", "unapprove", "recount", "migrate", "replace", "rewrite", "schedule", "unschedule", "upgrade",
  "download", "scaffold", "add-cap", "remove-cap", "add-role", "remove-role", "set-role", "assign", "unassign",
  "duplicate", "destroy", "purge", "move", "rename", "switch-language", "shuffle", "reset-password",
]);

/** Verbos considerados de solo lectura (permitidos con READ_ONLY=true). */
const READ_VERBS = new Set([
  "list",
  "get",
  "status",
  "is-active",
  "is-installed",
  "exists",
  "verify-checksums",
  "check-update",
  "version",
  "path",
  "info",
  "count",
  "search",
  "tables",
  "size",
  "has",
  "pluck",
  "describe",
  "diff",
  "check",
  "url",
  "is-multisite",
  "lint",
]);
const READ_TOP = new Set(["help", "cli", "doctor"]);

export function classifyWpCli(args: string[]): { dangerous: boolean; readOnly: boolean } {
  const positional = args.filter((a) => !a.startsWith("-"));
  const top = positional[0] ?? "";
  const dryRun = args.includes("--dry-run");
  const head = positional.slice(0, 3);

  // Instalar plugins/temas desde URL o zip = ejecutar código arbitrario.
  const installsFromSource =
    (top === "plugin" || top === "theme") &&
    positional[1] === "install" &&
    positional.slice(2).some((p) => /:\/\/|\.zip$/i.test(p));

  const dangerous =
    (DANGEROUS.some((d) => d.every((part, i) => positional[i] === part)) || installsFromSource) &&
    !(top === "search-replace" && dryRun);

  const hasWriteVerb = head.some((p) => WRITE_VERBS.has(p));
  const readOnly =
    (top === "search-replace" && dryRun) ||
    (!hasWriteVerb && top !== "search-replace" && (READ_TOP.has(top) || head.some((p) => READ_VERBS.has(p))));
  return { dangerous, readOnly };
}
