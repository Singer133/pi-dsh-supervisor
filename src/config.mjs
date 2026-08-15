export function parseStringArray(value, name, { maxItems = 64, maxItemLength = 4096 } = {}) {
  if (value === undefined || value === "") return undefined;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  if (parsed.length > maxItems || parsed.some((item) => item.length > maxItemLength)) {
    throw new Error(`${name} exceeds the bounded argument limit`);
  }
  return parsed;
}

export function parseBoundedInteger(value, name, { fallback, min = 1, max } = {}) {
  if (value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}
