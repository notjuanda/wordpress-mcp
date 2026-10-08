# wordpress-mcp

[![CI](https://github.com/notjuanda/wordpress-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/notjuanda/wordpress-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520.12-339933?logo=node.js&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-server-6E56CF)

Servidor **MCP (Model Context Protocol) local** para administrar un **WordPress self-hosted** (no wordpress.com) desde Claude u otro cliente MCP: editar entradas, páginas y páginas de **Elementor**, medios, menús, ajustes, plugins y temas; leer y editar archivos del servidor; ejecutar WP-CLI y revisar salud y seguridad del sitio — con protecciones pensadas para que una IA no pueda romper tu web.

```
Claude (Desktop / Code) ──stdio──► wordpress-mcp (tu PC) ──HTTPS──► REST API de WordPress
                                                        └──SSH────► SFTP + WP-CLI en el servidor
```

| Modo | Necesita | Permite |
|---|---|---|
| **Solo REST** | Application Password | Contenido (incl. Elementor), medios, taxonomías, ajustes, usuarios, menús, plugins |
| **REST + SSH** *(recomendado)* | + acceso SSH | Además: archivos de temas/plugins, WP-CLI, actualizaciones, copias de BD, chequeos de salud y seguridad |

## Índice

- [Inicio rápido](#inicio-rápido)
- [Configuración](#configuración)
- [Conectarlo a Claude](#conectarlo-a-claude)
- [Herramientas](#herramientas)
- [Seguridad](#seguridad)
- [Problemas frecuentes](#problemas-frecuentes)
- [Desarrollo](#desarrollo)
- [Licencia](#licencia)

---

## Inicio rápido

Requisitos: **Node.js 20.12+**, un usuario **administrador** en WordPress y, opcionalmente, acceso **SSH** al hosting.

```bash
git clone https://github.com/notjuanda/wordpress-mcp.git
cd wordpress-mcp
npm install
npm run build
cp .env.example .env      # en Windows: copy .env.example .env
```

1. Rellena `.env` (ver [Configuración](#configuración)). Empieza con `READ_ONLY=true` para probar sin riesgo.
2. Comprueba la conexión:
   ```bash
   npm run check
   ```
3. Regístralo en tu cliente MCP ([ver abajo](#conectarlo-a-claude)) y abre una conversación nueva:
   > *"Dame un resumen de mi sitio de WordPress"*
4. Cuando confíes en el flujo, cambia a `READ_ONLY=false`.

---

## Configuración

Toda la configuración vive en `.env` (nunca se sube a git). Variables:

| Variable | Obligatoria | Por defecto | Descripción |
|---|---|---|---|
| `WP_URL` | ✅ | — | URL pública del sitio, sin barra final. Debe ser `https://` |
| `WP_USERNAME` | ✅ | — | Usuario de WordPress (administrador) |
| `WP_APP_PASSWORD` | ✅ | — | Application Password (con o sin espacios) |
| `SSH_HOST` / `SSH_PORT` / `SSH_USERNAME` | SSH | puerto `22` | Datos de acceso SSH |
| `SSH_PRIVATE_KEY_PATH` **o** `SSH_PASSWORD` | SSH | — | Clave privada (recomendado) o contraseña |
| `SSH_PRIVATE_KEY_PASSPHRASE` | | — | Si la clave tiene passphrase |
| `SSH_HOST_FINGERPRINT` | recomendada | — | Huella `SHA256:…` del servidor (anti man-in-the-middle). `npm run check` te la muestra |
| `WP_ROOT` | SSH | — | Ruta absoluta de WordPress en el servidor |
| `WP_CLI_BIN` | | `wp` | Binario de WP-CLI |
| `READ_ONLY` | | `false` | `true` = ninguna herramienta puede modificar nada |
| `WRITE_ALLOWED_PATHS` | | `wp-content` | Rutas (relativas a `WP_ROOT`, separadas por coma) donde se permite escribir |
| `LOCAL_UPLOAD_DIRS` | | *(cualquiera)* | Carpetas locales desde las que se permite subir medios (separadas por `;`) |
| `REDACT_SECRETS` | | `true` | Ocultar contraseñas/claves/salts en lo que se devuelve a la IA |
| `BACKUP_DIR` | | `./backups` | Copias locales automáticas antes de cada cambio |
| `REQUEST_TIMEOUT_MS` | | `30000` | Timeout de red |
| `ALLOW_INSECURE_HTTP` | | `false` | Permitir `http://` (solo para sitios locales) |

### Application Password

1. En wp-admin: **Usuarios → Perfil → Contraseñas de aplicación**.
2. Escribe un nombre (p. ej. `claude-mcp`) y pulsa **Añadir**.
3. Copia la contraseña en `WP_APP_PASSWORD`. Solo se muestra una vez; puedes revocarla en cualquier momento desde la misma pantalla.

> **¿No aparece la sección "Contraseñas de aplicación"?** Algún plugin la está desactivando:
> - **Hostinger:** *Herramientas → Hostinger Tools →* desactiva **"Disable application passwords"**.
> - **Wordfence:** *All Options → "Disable WordPress application passwords"*.
> - **All In One WP Security:** *User Security → Additional settings*.
> - El sitio debe servirse por **HTTPS**.

### SSH (opcional, recomendado)

**Hostinger:** hPanel → **Sitios web → tu dominio → Avanzado → Acceso SSH** (habilítalo si está apagado). Ahí tienes IP, puerto (normalmente `65002`) y usuario.

```ini
SSH_HOST=123.45.67.89
SSH_PORT=65002
SSH_USERNAME=u123456789
SSH_PRIVATE_KEY_PATH=C:/Users/<tu-usuario>/.ssh/id_ed25519   # o SSH_PASSWORD=...
WP_ROOT=/home/u123456789/domains/tudominio.com/public_html
```

Con clave es más seguro: genera una con `ssh-keygen -t ed25519` y pega el `.pub` en hPanel → Acceso SSH → Claves SSH. Después ejecuta `npm run check` y copia la huella que muestra en `SSH_HOST_FINGERPRINT`.

### Varios sitios

Crea un archivo por sitio (`.env.tienda`, `.env.blog`) y registra una instancia del servidor por cada uno con
`"env": { "WP_MCP_ENV_FILE": ".env.tienda" }`. Las variables definidas en `env` tienen prioridad sobre el archivo.

---

## Conectarlo a Claude

**Claude Code** (desde cualquier terminal):

```bash
claude mcp add wordpress --scope user -- node /ruta/a/wordpress-mcp/dist/index.js
```

**Claude Desktop** — edita `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\`, macOS: `~/Library/Application Support/Claude/`):

```json
{
  "mcpServers": {
    "wordpress": {
      "command": "node",
      "args": ["/ruta/a/wordpress-mcp/dist/index.js"]
    }
  }
}
```

Cualquier otro cliente MCP compatible con stdio funciona igual. Para probarlo sin cliente: `npm run inspect` (MCP Inspector).

---

## Herramientas

48 herramientas agrupadas por área:

| Área | Herramientas | SSH |
|---|---|---|
| Sitio | `wp_site_info`, `wp_get_settings`, `wp_update_settings`, `wp_list_users`, `wp_list_menus`, `wp_rest_request`, `wp_clear_cache` | |
| Contenido | `wp_list_post_types`, `wp_list_content`, `wp_get_content`, `wp_create_content`, `wp_update_content`, `wp_replace_in_content`, `wp_delete_content`, `wp_list_revisions` | |
| Elementor | `elementor_get_page`, `elementor_replace_text`, `elementor_update_element`, `elementor_restore_backup` | |
| Taxonomías | `wp_list_taxonomies`, `wp_list_terms`, `wp_upsert_term`, `wp_delete_term` | |
| Medios | `wp_list_media`, `wp_upload_media`, `wp_update_media`, `wp_delete_media` | |
| Plugins y temas | `wp_list_plugins`, `wp_set_plugin_status`, `wp_install_plugin`, `wp_delete_plugin`, `wp_list_themes`, `wp_update_plugins`, `wp_activate_theme`, `wp_update_themes` | parcial |
| Archivos | `fs_list`, `fs_read_file`, `fs_write_file`, `fs_edit_file`, `fs_delete_file`, `fs_search`, `fs_list_backups`, `fs_restore_backup` | ✅ |
| WP-CLI | `wp_cli`, `wp_db_backup` | ✅ |
| Diagnóstico | `wp_health_check`, `wp_read_debug_log`, `wp_security_scan` | parcial |

`wp_rest_request` (cualquier endpoint, p. ej. WooCommerce `wc/v3`, Yoast, ACF, comentarios) y `wp_cli` son las vías para todo lo que no tenga herramienta propia.

### Páginas de Elementor

Elementor guarda el diseño en el meta `_elementor_data`, no en el contenido normal: editar `content` de una página de Elementor **no cambia lo que se ve** (el MCP lo detecta, lo bloquea y avisa). Las herramientas `elementor_*` editan ese JSON por la REST API (sin SSH), guardan una copia local y vacían la caché de Elementor y de Hostinger para que el cambio se vea al momento.

### Ejemplos de uso

- *"Cambia el texto del botón de la Home por «Reserva tu clase gratis»"*
- *"Crea un borrador de entrada sobre nutrición en la categoría Beneficios"*
- *"¿Hay plugins desactualizados o archivos sospechosos?"*
- *"Añade este snippet al `functions.php` del tema hijo"*
- *"¿Por qué sale error 500? Mira el debug.log"*

---

## Seguridad

Una IA con acceso de administrador a tu web es potente y peligrosa. Este servidor añade controles **deterministas** (no dependen de que la IA "se porte bien"):

| Protección | Detalle |
|---|---|
| **Copia antes de escribir** | Cada archivo o página de Elementor se guarda en `backups/` (local) antes de modificarse. `fs_restore_backup` / `elementor_restore_backup` lo revierten. |
| **Rollback PHP automático** | Tras escribir un `.php` se ejecuta `php -l`; si hay error de sintaxis se restaura el original para no tumbar el sitio. |
| **Rutas permitidas** | Escritura solo en `WRITE_ALLOWED_PATHS` (por defecto `wp-content`), nunca fuera de `WP_ROOT`. Las rutas se resuelven en el servidor (`realpath`) para que un enlace simbólico no pueda burlarlo. |
| **Solo lectura** | `READ_ONLY=true` bloquea toda escritura (REST, archivos, copias de BD, WP-CLI que no sea de consulta); el cliente REST además rechaza cualquier método distinto de GET. |
| **Confirmación** | Borrados permanentes, `db reset/query/import/export`, `eval`, `package`, `search-replace` sin `--dry-run`, `config get/list`, `media import`, `export`, `scaffold`, instalar plugins desde URL/zip o activándolos, etc. exigen `confirm=true`. |
| **Secretos ocultos** | Contraseñas, claves y salts se redactan en `fs_read_file`, `fs_search`, `wp_cli` y `wp_read_debug_log` (incluidas copias tipo `wp-config.php.bak`). |
| **WP-CLI sin shell** | Cada argumento se escapa; no hay pipes ni `;`. `--path`, `--ssh`, `--http`, `--config-file` y alias `@…` están prohibidos; `--exec`/`--require` exigen confirmación; los slugs se validan. |
| **REST acotada** | Las rutas se validan ya normalizadas y deben quedar dentro de `/wp-json`; se rechaza `_method` (también variantes que PHP normaliza); no se siguen redirecciones con credenciales. |
| **Dumps fuera de la web** | `wp_db_backup` guarda en `~/wp-mcp-backups` (fuera de `public_html`, comprobado con rutas reales, permisos 600) y lo descarga. |
| **HTTPS obligatorio** | `WP_URL` con `http://` solo se acepta en loopback o con `ALLOW_INSECURE_HTTP=true`. |
| **Verificación SSH** | Con `SSH_HOST_FINGERPRINT` se rechaza cualquier servidor que no sea el tuyo. |
| **Subida de medios** | Descargas solo hacia IPs públicas (IPv4/IPv6, incl. mapeadas, NAT64, 6to4), con la conexión fijada a la IP validada (anti DNS rebinding) y tope de tamaño en streaming. Nunca se suben archivos de la carpeta del MCP, copias de BD, claves ni credenciales. |

### Modelo de amenazas

- El MCP actúa con **los permisos del usuario de WordPress** de la Application Password. Si es administrador, puede hacer lo mismo que un administrador.
- El contenido que lee de tu sitio (entradas, comentarios, logs, archivos) **no es de confianza**: podría contener instrucciones dirigidas a la IA (*prompt injection*). `confirm=true` lo establece el propio modelo, así que la barrera final es **tu aprobación en el cliente MCP**: revisa las acciones destructivas antes de aprobarlas, o usa `READ_ONLY=true`.
- Las credenciales viven **solo** en tu `.env` local. El servidor no abre puertos: se comunica por stdio con tu cliente.

### Recomendaciones

- Crea un **usuario administrador dedicado** para el MCP: podrás revocar su Application Password sin afectar a tu cuenta.
- Usa **clave SSH** y rellena `SSH_HOST_FINGERPRINT`.
- Edita siempre el **tema hijo**, no el padre.
- Ejecuta `wp_db_backup` antes de actualizaciones o `search-replace`.

Para reportar una vulnerabilidad, consulta [SECURITY.md](SECURITY.md).

---

## Problemas frecuentes

<details>
<summary><b>401 <code>rest_not_logged_in</code> con la contraseña correcta</b></summary>

El servidor (LiteSpeed/Apache) elimina la cabecera `Authorization`. Añade al `.htaccess`, antes de `# BEGIN WordPress`:

```apache
SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1
```
</details>

<details>
<summary><b>No aparece "Contraseñas de aplicación" en el perfil</b></summary>

Un plugin las desactiva. Ver [Application Password](#application-password) (Hostinger Tools, Wordfence, AIOS).
</details>

<details>
<summary><b>"WordPress respondió con una redirección"</b></summary>

`WP_URL` no es la URL canónica: revisa `https://`, `www.` y que no tenga barra final. Por seguridad el MCP no sigue redirecciones con tus credenciales.
</details>

<details>
<summary><b>403 o bloqueos de la REST API</b></summary>

Algún plugin de seguridad (Wordfence, iThemes…) puede bloquear la REST API o las Application Passwords: permítelas en sus ajustes.
</details>

<details>
<summary><b>Un cambio no se ve en la web</b></summary>

Pide a Claude que ejecute `wp_clear_cache`. Si la página es de Elementor, asegúrate de usar las herramientas `elementor_*`.
</details>

<details>
<summary><b><code>wp: command not found</code></b></summary>

Ajusta `WP_CLI_BIN` a la ruta completa (`which wp` por SSH). En Hostinger viene instalado.
</details>

---

## Desarrollo

```bash
npm run dev        # ejecuta desde src/ con tsx
npm run build      # compila a dist/
npm run typecheck  # comprobación de tipos
npm run check      # diagnóstico de conexión con tu .env
npm run inspect    # MCP Inspector
```

```
src/
├─ index.ts            # arranque MCP (stdio) + registro de módulos
├─ check.ts            # diagnóstico: npm run check
├─ config.ts           # carga y validación de .env (zod)
├─ context.ts          # dependencias compartidas por las herramientas
├─ clients/
│  ├─ rest.ts          # cliente REST (Application Password, validación de rutas)
│  └─ ssh.ts           # SSH perezoso y reutilizable: exec, WP-CLI, SFTP
├─ safety/
│  ├─ guards.ts        # solo lectura, rutas permitidas, política WP-CLI
│  ├─ backup.ts        # copias locales + manifiesto
│  └─ redact.ts        # ocultación de secretos
├─ lib/                # resultados, diff, caché, red segura (netguard)
└─ tools/              # un módulo por área (site, content, elementor, media, files, cli, health…)
```

Para añadir una herramienta, crea un `ToolModule` en `src/tools/` y regístralo en `src/index.ts`. Toda herramienta que modifique algo debe llamar a `ctx.guards.assertWritable()` (y `assertConfirmed()` si es destructiva).

Las contribuciones son bienvenidas: abre un *issue* o un *pull request*.

---

## Licencia

[MIT](LICENSE) © 2026 Juan David Viveros Chavez

> Proyecto independiente, sin afiliación con WordPress, Automattic, Elementor, Hostinger ni Anthropic. Úsalo bajo tu responsabilidad y haz copias de seguridad de tu sitio.
