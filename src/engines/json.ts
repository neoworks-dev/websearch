// Readers for JSON of unknown shape: a field that isn't what it should be reads as empty, so a
// changed API gives fewer results instead of a crash.
import { plainText } from "../entities.ts";

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return value as Record<string, unknown>;
}

export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value;
}

export function text(value: unknown): string {
  if (typeof value !== "string") return "";
  return value;
}

/** A number, or a numeric string; undefined otherwise. */
export function number(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

/** `JSON.parse`, but a body that isn't JSON reads as an empty object. */
export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

export function stripTags(html: string): string {
  return plainText(html.replace(/<[^>]*>/g, ""));
}
