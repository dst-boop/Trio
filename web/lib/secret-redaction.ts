/** Remove known credentials from untrusted source text and model output. */
export function redactKnownSecrets(value: string, keys: string[]) {
  return [...new Set(keys)].filter(Boolean).sort((a, b) => b.length - a.length)
    .reduce((text, key) => text.split(key).join('[redacted]'), value);
}
