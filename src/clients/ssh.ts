import { createHash } from "node:crypto";
import { Client, type SFTPWrapper, type Stats } from "ssh2";
import type { Config } from "../config.js";
import { ToolError } from "../lib/result.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface DirEntry {
  name: string;
  type: "file" | "dir" | "link" | "other";
  size: number;
  modified: string;
  mode: string;
}

/** Comillas seguras para shell POSIX. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Conexión SSH/SFTP perezosa y reutilizable. */
export class SshClient {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private sftpSession: SFTPWrapper | null = null;

  constructor(private readonly cfg: Config) {}

  get enabled(): boolean {
    return this.cfg.sshEnabled;
  }

  get root(): string {
    return this.cfg.WP_ROOT!;
  }

  private assertEnabled(): void {
    if (!this.cfg.sshEnabled) {
      throw new ToolError(
        "SSH no está configurado. Rellena SSH_HOST, SSH_USERNAME, SSH_PASSWORD o SSH_PRIVATE_KEY_PATH y WP_ROOT en .env.",
      );
    }
  }

  private connect(): Promise<Client> {
    this.assertEnabled();
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<Client>((resolve, reject) => {
      const c = new Client();
      c.on("ready", () => {
        this.client = c;
        this.connecting = null;
        resolve(c);
      })
        .on("error", (err) => {
          this.reset();
          reject(new ToolError(`Error SSH: ${err.message}`));
        })
        .on("close", () => this.reset())
        .connect({
          host: this.cfg.SSH_HOST,
          port: this.cfg.SSH_PORT,
          username: this.cfg.SSH_USERNAME,
          password: this.cfg.SSH_PASSWORD,
          privateKey: this.cfg.privateKey,
          passphrase: this.cfg.SSH_PRIVATE_KEY_PASSPHRASE,
          readyTimeout: this.cfg.REQUEST_TIMEOUT_MS,
          keepaliveInterval: 15_000,
          hostVerifier: (key: Buffer) => this.verifyHostKey(key),
        });
    });
    return this.connecting;
  }

  /** Huella SHA256 de la clave del servidor en el formato de OpenSSH ("SHA256:base64sinpadding"). */
  lastHostFingerprint: string | null = null;

  private verifyHostKey(key: Buffer): boolean {
    const fp = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
    this.lastHostFingerprint = fp;
    const expected = this.cfg.SSH_HOST_FINGERPRINT;
    if (!expected) {
      console.error(
        `[wordpress-mcp] AVISO: no se verifica la identidad del servidor SSH. Añade a .env: SSH_HOST_FINGERPRINT=${fp}`,
      );
      return true;
    }
    if (fp !== expected) {
      console.error(`[wordpress-mcp] Huella SSH no coincide (recibida ${fp}, esperada ${expected}). Conexión rechazada.`);
      return false;
    }
    return true;
  }

  private reset(): void {
    this.client = null;
    this.connecting = null;
    this.sftpSession = null;
  }

  close(): void {
    this.client?.end();
    this.reset();
  }

  async exec(command: string, timeoutMs = 120_000): Promise<ExecResult> {
    const c = await this.connect();
    return new Promise((resolve, reject) => {
      c.exec(command, (err, stream) => {
        if (err) return reject(new ToolError(`No se pudo ejecutar el comando: ${err.message}`));
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          stream.close();
          reject(new ToolError(`Timeout (${timeoutMs} ms) ejecutando: ${command.slice(0, 200)}`));
        }, timeoutMs);
        stream
          .on("close", (code: number | null) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, code });
          })
          .on("data", (d: Buffer) => (stdout += d.toString("utf8")));
        stream.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      });
    });
  }

  /** Ejecuta WP-CLI en la instalación configurada. `args` se escapan individualmente. */
  async wp(args: string[], timeoutMs?: number): Promise<ExecResult> {
    const cmd = [this.cfg.WP_CLI_BIN, ...args.map(shq), `--path=${shq(this.root)}`, "--no-color"].join(" ");
    return this.exec(`cd ${shq(this.root)} && ${cmd}`, timeoutMs);
  }

  private realRoot: string | null = null;

  /**
   * Devuelve la ruta REAL (resolviendo symlinks) relativa a WP_ROOT, o lanza si queda fuera.
   * Evita que un enlace simbólico (p. ej. wp-content/x -> ../../wp-config.php) burle las rutas permitidas.
   */
  async realRelPath(abs: string): Promise<string> {
    const real = async (p: string) => {
      const r = await this.exec(`realpath -m -- ${shq(p)}`);
      if (r.code !== 0) throw new ToolError(`No se pudo resolver la ruta ${p}: ${r.stderr}`);
      return r.stdout.trim();
    };
    this.realRoot ??= await real(this.root);
    const resolved = await real(abs);
    if (resolved === this.realRoot) return "";
    if (!resolved.startsWith(`${this.realRoot}/`)) {
      throw new ToolError(`La ruta apunta (vía enlace simbólico) fuera de la instalación de WordPress: ${resolved}`);
    }
    return resolved.slice(this.realRoot.length + 1);
  }

  private homeDir: string | null = null;

  /** Carpeta privada fuera de la web pública para archivos temporales y dumps (~/wp-mcp-tmp). */
  async privateDir(name = "wp-mcp-tmp"): Promise<string> {
    if (!this.homeDir) {
      const home = (await this.exec('printf %s "$HOME"')).stdout.trim();
      if (!home.startsWith("/")) throw new ToolError("No se pudo determinar $HOME en el servidor.");
      if (home === this.root || home.startsWith(`${this.root}/`)) {
        throw new ToolError("$HOME está dentro de la web pública; abortado para no exponer archivos.");
      }
      this.homeDir = home;
    }
    const dir = `${this.homeDir}/${name}`;
    const r = await this.exec(`umask 077; mkdir -p ${shq(dir)} && realpath -- ${shq(dir)} && realpath -- ${shq(this.root)}`);
    if (r.code !== 0) throw new ToolError(`No se pudo crear ${dir}: ${r.stderr}`);
    // Comparación con rutas reales: un symlink no puede colocar la carpeta privada dentro de la web pública.
    const [realDir = "", realRoot = ""] = r.stdout.trim().split("\n");
    if (realDir === realRoot || realDir.startsWith(`${realRoot}/`)) {
      throw new ToolError("La carpeta privada quedaría dentro de la web pública; abortado.");
    }
    return dir;
  }

  /** Como wp() pero lanza error si el código de salida no es 0. */
  async wpOrThrow(args: string[], timeoutMs?: number): Promise<string> {
    const r = await this.wp(args, timeoutMs);
    if (r.code !== 0) {
      throw new ToolError(`wp ${args.join(" ")} falló (código ${r.code}):\n${r.stderr || r.stdout}`);
    }
    return r.stdout;
  }

  // ── SFTP ──────────────────────────────────────────────────────────

  private async sftp(): Promise<SFTPWrapper> {
    if (this.sftpSession) return this.sftpSession;
    const c = await this.connect();
    return new Promise((resolve, reject) => {
      c.sftp((err, s) => {
        if (err) return reject(new ToolError(`No se pudo abrir SFTP: ${err.message}`));
        this.sftpSession = s;
        s.on("close", () => (this.sftpSession = null));
        resolve(s);
      });
    });
  }

  async stat(abs: string): Promise<Stats | null> {
    const s = await this.sftp();
    return new Promise((resolve, reject) => {
      s.stat(abs, (err, st) => {
        if (err) {
          if ((err as { code?: number }).code === 2) return resolve(null); // ENOENT
          return reject(new ToolError(`stat ${abs}: ${err.message}`));
        }
        resolve(st);
      });
    });
  }

  /** Como stat pero sin seguir enlaces simbólicos. */
  async lstat(abs: string): Promise<Stats | null> {
    const s = await this.sftp();
    return new Promise((resolve, reject) => {
      s.lstat(abs, (err, st) => {
        if (err) {
          if ((err as { code?: number }).code === 2) return resolve(null);
          return reject(new ToolError(`lstat ${abs}: ${err.message}`));
        }
        resolve(st);
      });
    });
  }

  async readFile(abs: string): Promise<Buffer> {
    const s = await this.sftp();
    return new Promise((resolve, reject) => {
      s.readFile(abs, (err, data) =>
        err ? reject(new ToolError(`No se pudo leer ${abs}: ${err.message}`)) : resolve(data),
      );
    });
  }

  async writeFile(abs: string, data: Buffer): Promise<void> {
    const s = await this.sftp();
    return new Promise((resolve, reject) => {
      s.writeFile(abs, data, (err) =>
        err ? reject(new ToolError(`No se pudo escribir ${abs}: ${err.message}`)) : resolve(),
      );
    });
  }

  /** Descarga en streaming (para archivos grandes, p. ej. dumps de BD). */
  async download(abs: string, localPath: string): Promise<void> {
    const s = await this.sftp();
    return new Promise((resolve, reject) => {
      s.fastGet(abs, localPath, (err) =>
        err ? reject(new ToolError(`No se pudo descargar ${abs}: ${err.message}`)) : resolve(),
      );
    });
  }

  async unlink(abs: string): Promise<void> {
    const s = await this.sftp();
    return new Promise((resolve, reject) => {
      s.unlink(abs, (err) => (err ? reject(new ToolError(`No se pudo borrar ${abs}: ${err.message}`)) : resolve()));
    });
  }

  async mkdirp(abs: string): Promise<void> {
    const r = await this.exec(`mkdir -p ${shq(abs)}`);
    if (r.code !== 0) throw new ToolError(`mkdir -p ${abs}: ${r.stderr}`);
  }

  async readdir(abs: string): Promise<DirEntry[]> {
    const s = await this.sftp();
    return new Promise((resolve, reject) => {
      s.readdir(abs, (err, list) => {
        if (err) return reject(new ToolError(`No se pudo listar ${abs}: ${err.message}`));
        resolve(
          list
            .map((e) => ({
              name: e.filename,
              type: e.attrs.isDirectory()
                ? ("dir" as const)
                : e.attrs.isFile()
                  ? ("file" as const)
                  : e.attrs.isSymbolicLink()
                    ? ("link" as const)
                    : ("other" as const),
              size: e.attrs.size,
              modified: new Date(e.attrs.mtime * 1000).toISOString(),
              mode: (e.attrs.mode & 0o777).toString(8),
            }))
            .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1)),
        );
      });
    });
  }
}
