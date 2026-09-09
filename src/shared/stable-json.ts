import type { JsonValue } from "./json.js";
import { isJsonValue } from "./json.js";

export class StableJsonError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StableJsonError";
  }
}

/**
 * Serializes JSON with recursively sorted object keys and no platform-specific
 * whitespace. Array order is preserved because it is semantically meaningful.
 */
export function stableStringify(value: JsonValue, trailingNewline = true): string {
  if (!isJsonValue(value)) {
    throw new StableJsonError("value contains undefined, a non-finite number, or a non-JSON object");
  }

  const serialized = serialize(value);
  return trailingNewline ? `${serialized}\n` : serialized;
}

/** Parses JSON and rejects values that cannot be deterministically reserialized. */
export function parseJson(text: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown JSON syntax error";
    throw new StableJsonError(`invalid JSON: ${detail}`);
  }

  if (!isJsonValue(parsed)) {
    throw new StableJsonError("JSON contains a non-finite or unsupported value");
  }
  return parsed;
}

function serialize(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new StableJsonError("value is not JSON serializable");
    }
    return encoded;
  }

  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(",")}]`;
  }

  const members = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serialize(value[key] as JsonValue)}`);
  return `{${members.join(",")}}`;
}
