const encoder = new TextEncoder();
const bytes = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const base64 = (value: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(value)));

async function encryptionKey(master: string | undefined) {
  if (!master || !/^[A-Za-z0-9+/]{43}=$/.test(master)) throw new Error('Credential storage is unavailable.');
  const raw = bytes(master);
  if (raw.length !== 32) throw new Error('Credential storage is unavailable.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const associatedData = (userId: string, provider: string) => encoder.encode(JSON.stringify(['trio-credentials-v1', userId, provider]));
export async function encryptCredential(master: string | undefined, userId: string, provider: string, value: string) {
  const key = await encryptionKey(master), iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: associatedData(userId, provider), tagLength: 128 }, key, encoder.encode(value));
  return { cipher: base64(cipher), iv: base64(iv) };
}
export async function decryptCredential(master: string | undefined, userId: string, provider: string, value: { cipher: string; iv: string }) {
  const key = await encryptionKey(master), iv = bytes(value.iv);
  if (iv.length !== 12) throw new Error('Credential storage is unavailable.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: associatedData(userId, provider), tagLength: 128 }, key, bytes(value.cipher));
  return new TextDecoder('utf-8', { fatal: true }).decode(plain);
}
