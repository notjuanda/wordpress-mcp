import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Raíz del proyecto (carpeta que contiene package.json), independiente del cwd del cliente MCP. */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// WP_MCP_ENV_FILE permite tener un .env por sitio (p. ej. .env.tienda, .env.blog) con una sola instalación.
const envFile = path.resolve(PROJECT_ROOT, process.env.WP_MCP_ENV_FILE ?? ".env");
if (existsSync(envFile)) {
  // Las variables ya definidas (p. ej. desde la config del cliente MCP) tienen prioridad.
  process.loadEnvFile(envFile);
}

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const bool = (def: boolean) =>
  z.preprocess(
    (v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(String(v).toLowerCase())),
    z.boolean(),
  );

const schema = z.object({
  WP_URL: z
    .string({ error: "WP_URL es obligatorio" })
    .url("WP_URL debe ser una URL válida")
    .transform((u) => u.replace(/\/+$/, "")),
  WP_USERNAME: z.string({ error: "WP_USERNAME es obligatorio" }).min(1),
  WP_APP_PASSWORD: z
    .string({ error: "WP_APP_PASSWORD es obligatorio" })
    .min(1)
    .transform((p) => p.replace(/\s+/g, "")),

  SSH_HOST: optionalString,
  SSH_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(22)),
  SSH_USERNAME: optionalString,
  SSH_PASSWORD: optionalString,
  SSH_PRIVATE_KEY_PATH: optionalString,
  SSH_PRIVATE_KEY_PASSPHRASE: optionalString,
  /** Huella SHA256 de la clave del servidor (formato OpenSSH "SHA256:…"). Evita ataques man-in-the-middle. */
  SSH_HOST_FINGERPRINT: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/, 'SSH_HOST_FINGERPRINT debe tener el formato "SHA256:…" (43 caracteres base64)')
      .transform((f) => f.replace(/=$/, ""))
      .optional(),
  ),
  /** Permite WP_URL con http:// (solo para entornos locales). */
  ALLOW_INSECURE_HTTP: bool(false),
  /** Carpetas locales desde las que wp_upload_media puede leer archivos (separadas por ';'). Vacío = cualquiera. */
  LOCAL_UPLOAD_DIRS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .optional()
      .transform((s) =>
        (s ?? "")
          .split(";")
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => path.resolve(p)),
      ),
  ),
  WP_ROOT: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .refine((p) => p.startsWith("/"), "WP_ROOT debe ser una ruta absoluta del servidor (empieza por /)")
      .transform((p) => p.replace(/\/+$/, ""))
      .optional(),
  ),
  WP_CLI_BIN: z.preprocess(emptyToUndefined, z.string().default("wp")),

  READ_ONLY: bool(false),
  WRITE_ALLOWED_PATHS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .default("wp-content")
      .transform((s) =>
        s
          .split(",")
          .map((p) => p.trim().replace(/^\/+|\/+$/g, ""))
          .filter(Boolean),
      ),
  ),
  REDACT_SECRETS: bool(true),
  BACKUP_DIR: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .default("./backups")
      .transform((p) => path.resolve(PROJECT_ROOT, p)),
  ),
  REQUEST_TIMEOUT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(30_000)),
});

export type Config = z.infer<typeof schema> & {
  /** true si hay datos suficientes para abrir SSH. */
  sshEnabled: boolean;
  privateKey?: Buffer;
};

export function loadConfig(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuración inválida (revisa tu .env):\n${issues}`);
  }
  const cfg = parsed.data;

  const url = new URL(cfg.WP_URL);
  // Solo loopback: *.local/*.test pueden resolver a otra máquina de la LAN (la contraseña viajaría en claro).
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/.test(url.hostname);
  if (url.protocol !== "https:" && !isLocal && !cfg.ALLOW_INSECURE_HTTP) {
    throw new Error(
      "WP_URL usa http://: la Application Password viajaría sin cifrar. Usa https:// (o ALLOW_INSECURE_HTTP=true solo en local).",
    );
  }

  let privateKey: Buffer | undefined;
  if (cfg.SSH_PRIVATE_KEY_PATH) {
    const keyPath = path.resolve(PROJECT_ROOT, cfg.SSH_PRIVATE_KEY_PATH);
    if (!existsSync(keyPath)) throw new Error(`SSH_PRIVATE_KEY_PATH no existe: ${keyPath}`);
    privateKey = readFileSync(keyPath);
  }

  const sshEnabled = Boolean(cfg.SSH_HOST && cfg.SSH_USERNAME && (privateKey || cfg.SSH_PASSWORD));
  if (sshEnabled && !cfg.WP_ROOT) {
    throw new Error("SSH está configurado pero falta WP_ROOT (ruta absoluta a WordPress en el servidor).");
  }

  return { ...cfg, sshEnabled, privateKey };
}
