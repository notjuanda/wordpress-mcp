import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Error "esperado" cuyo mensaje se muestra tal cual al modelo. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

const MAX_TEXT = 100_000;

function truncate(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  return `${text.slice(0, MAX_TEXT)}\n\n…[truncado: ${text.length - MAX_TEXT} caracteres más. Usa paginación/offset para ver el resto]`;
}

export function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: truncate(value) }] };
}

export function json(value: unknown): CallToolResult {
  return text(JSON.stringify(value, null, 2));
}

export function errorResult(err: unknown): CallToolResult {
  let msg: string;
  if (err instanceof ToolError) {
    msg = err.details === undefined ? err.message : `${err.message}\n${JSON.stringify(err.details, null, 2)}`;
  } else if (err instanceof Error) {
    msg = `${err.name}: ${err.message}`;
  } else {
    msg = String(err);
  }
  return { isError: true, content: [{ type: "text", text: truncate(msg) }] };
}

/** Envuelve un handler para que cualquier excepción se convierta en un resultado de error legible. */
export function safe<A extends unknown[]>(
  fn: (...args: A) => Promise<CallToolResult>,
): (...args: A) => Promise<CallToolResult> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      return errorResult(err);
    }
  };
}
