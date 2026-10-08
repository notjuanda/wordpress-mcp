import { createTwoFilesPatch } from "diff";
import { ToolError } from "./result.js";

const MAX_DIFF = 20_000;

/** Diff unificado compacto (3 líneas de contexto) para mostrar qué cambió. */
export function unifiedDiff(label: string, before: string, after: string): string {
  if (before === after) return "(sin cambios)";
  const patch = createTwoFilesPatch(`a/${label}`, `b/${label}`, before, after, undefined, undefined, { context: 3 });
  return patch.length > MAX_DIFF ? `${patch.slice(0, MAX_DIFF)}\n…[diff truncado]` : patch;
}

/** Cuenta apariciones literales (no regex) de `needle` en `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Reemplazo literal exacto, exigiendo unicidad salvo que replaceAll=true. */
export function exactReplace(
  source: string,
  find: string,
  replace: string,
  replaceAll: boolean,
): { result: string; count: number } {
  const count = countOccurrences(source, find);
  if (count === 0) {
    throw new ToolError("El texto a buscar no aparece. Vuelve a leer el contenido y copia el fragmento exacto.");
  }
  if (count > 1 && !replaceAll) {
    throw new ToolError(
      `El texto aparece ${count} veces. Amplía el fragmento para que sea único o usa replace_all=true.`,
    );
  }
  return { result: source.split(find).join(replace), count: replaceAll ? count : 1 };
}
