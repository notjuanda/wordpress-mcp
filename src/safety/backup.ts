import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { ToolError } from "../lib/result.js";

export interface BackupEntry {
  id: string;
  remotePath: string;
  createdAt: string;
  /** false si el archivo no existía antes (restaurar = borrarlo). */
  existed: boolean;
  size: number;
  reason: string;
}

/** Copias locales de cada archivo remoto antes de sobrescribirlo o borrarlo. */
export class BackupStore {
  private readonly manifest: string;

  constructor(private readonly dir: string) {
    this.manifest = path.join(dir, "manifest.jsonl");
  }

  async save(remotePath: string, content: Buffer | null, reason: string): Promise<BackupEntry> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    // Solo caracteres válidos en cualquier sistema de archivos (Windows no admite ':' y lo trataría como stream NTFS).
    const slug = remotePath
      .replace(/^\/+/, "")
      .replace(/[/\\]/g, "__")
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(-150);
    // Sufijo aleatorio: dos copias en el mismo milisegundo con slugs parecidos nunca comparten id.
    const id = `${stamp}-${randomBytes(4).toString("hex")}__${slug}`;
    // 'wx': creación exclusiva, nunca sobrescribe otra copia.
    if (content) await writeFile(path.join(this.dir, id), content, { flag: "wx", mode: 0o600 });
    const entry: BackupEntry = {
      id,
      remotePath,
      createdAt: new Date().toISOString(),
      existed: content !== null,
      size: content?.length ?? 0,
      reason,
    };
    await appendFile(this.manifest, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  async list(filter?: string, limit = 50): Promise<BackupEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.manifest, "utf8");
    } catch {
      return [];
    }
    const entries = raw
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        // Una línea corrupta (p. ej. un corte a mitad de escritura) no debe bloquear las demás restauraciones.
        try {
          return [JSON.parse(l) as BackupEntry];
        } catch {
          return [];
        }
      })
      .filter((e) => !filter || e.remotePath.includes(filter));
    return entries.reverse().slice(0, limit);
  }

  async get(id: string): Promise<{ entry: BackupEntry; content: Buffer | null }> {
    const entry = (await this.list(undefined, Number.MAX_SAFE_INTEGER)).find((e) => e.id === id);
    if (!entry) throw new ToolError(`No existe la copia de seguridad "${id}"`);
    const content = entry.existed ? await readFile(path.join(this.dir, entry.id)) : null;
    return { entry, content };
  }
}
