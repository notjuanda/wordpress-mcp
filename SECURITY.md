# Política de seguridad

## Reportar una vulnerabilidad

Si encuentras un problema de seguridad, **no abras un issue público**. Usa
[GitHub Security Advisories](../../security/advisories/new) (pestaña *Security → Report a vulnerability*)
para reportarlo de forma privada. Intentaremos responder en un plazo de 7 días.

## Alcance

Este proyecto es un servidor MCP **local** que se ejecuta en tu máquina con tus credenciales.
Son especialmente relevantes:

- Formas de saltarse `READ_ONLY`, `WRITE_ALLOWED_PATHS` o la exigencia de `confirm=true`.
- Inyección de comandos en SSH/WP-CLI.
- Fugas de credenciales (logs, mensajes de error, copias de seguridad).
- Lectura/escritura fuera de `WP_ROOT`.

## Buenas prácticas para usuarios

- No compartas tu `.env`. Si una Application Password se expone, revócala en *wp-admin → Usuarios → Perfil*.
- Usa una cuenta de WordPress dedicada para el MCP y clave SSH con `SSH_HOST_FINGERPRINT`.
- Empieza con `READ_ONLY=true` y actívalo cuando confíes en el flujo.
