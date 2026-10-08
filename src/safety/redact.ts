const SECRET_NAME = "(?:DB_PASSWORD|AUTH_KEY|SECURE_AUTH_KEY|LOGGED_IN_KEY|NONCE_KEY|AUTH_SALT|SECURE_AUTH_SALT|LOGGED_IN_SALT|NONCE_SALT|[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|TOKEN|_SALT)[A-Z0-9_]*)";

/** define('SECRETO', 'valor') y const SECRETO = 'valor' en PHP. */
const SECRET_DEFINES = new RegExp(
  `(define\\s*\\(\\s*['"]${SECRET_NAME}['"]\\s*,\\s*|\\bconst\\s+${SECRET_NAME}\\s*=\\s*)(['"])((?:\\\\.|(?!\\2)[^\\\\])*)\\2`,
  "gi",
);

/** VAR=valor (.env), opcionalmente precedido por "archivo:línea:" (salida de grep) o "export ". */
const ENV_SECRETS = new RegExp(`^((?:[^\\n]*?:\\d+:)?\\s*(?:export\\s+)?${SECRET_NAME}\\s*=\\s*).+$`, "gim");

/** Archivos cuyo contenido se redacta al leerlos (incluye copias como wp-config.php.bak o wp-config-old.php). */
export function isSensitiveFile(relPath: string): boolean {
  const base = (relPath.split("/").pop() ?? "").toLowerCase();
  return (
    /^wp-config.*\.php.*$/.test(base) ||
    base === ".env" ||
    base.startsWith(".env.") ||
    base === "auth.json"
  );
}

export function redactSecrets(content: string): string {
  return content
    .replace(SECRET_DEFINES, (_m, prefix: string, quote: string) => `${prefix}${quote}***REDACTADO***${quote}`)
    .replace(ENV_SECRETS, (_m, prefix: string) => `${prefix}***REDACTADO***`);
}
