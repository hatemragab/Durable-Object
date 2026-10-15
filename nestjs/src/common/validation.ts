import { isUuid, parseUserId } from "@chat-poc/contracts";
import type { UserId } from "@chat-poc/contracts";
import { invalid } from "./errors.js";

export function body(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid("A JSON object is required.");
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in data))
  )
    throw invalid("Request fields do not match the endpoint contract.");
  return data;
}
export function uuid(value: unknown, name = "id"): string {
  if (typeof value !== "string" || !isUuid(value))
    throw invalid(`${name} must be a UUID.`);
  return value;
}
export function userIds(value: unknown): UserId[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3)
    throw invalid("One to three distinct user IDs are required.");
  const ids = value.map(parseUserId);
  if (new Set(ids).size !== ids.length)
    throw invalid("Duplicate user IDs are forbidden.");
  return ids;
}
export function integer(
  value: unknown,
  min: number,
  max: number,
  name: string,
): number {
  if (typeof value !== "string" || !/^\d+$/.test(value))
    throw invalid(`${name} must be an integer.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw invalid(`${name} is outside its allowed range.`);
  return result;
}
