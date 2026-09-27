const encoder = new TextEncoder();
const bytes = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const base64 = (value: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(value)));

type MasterKey = { id: string; key: CryptoKey };
export type EncryptedCredential = { cipher: string; iv: string; keyId?: string | null };

/**
 * The encryption master may list several 32-byte base64 keys separated by commas.
 * The first encrypts new values; every listed key can decrypt, so a new key can be
 * added in front during rotation while values saved under the previous key keep
 * working. Each key is identified by a fingerprint stored beside its ciphertexts.
 */
async function masterKeys(master: string | undefined): Promise<MasterKey[]> {
  const values = (master ?? '').split(',').map(value => value.trim());
  if (!values.length || values.some(value => !/^[A-Za-z0-9+/]{43}=$/.test(value))) throw new Error('Credential storage is unavailable.');
  return Promise.all(values.map(async value => {
    const raw = bytes(value);
    if (raw.length !== 32) throw new Error('Credential storage is unavailable.');
    return { id: await keyFingerprint(raw), key: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']) };
  }));
}
// A one-way fingerprint, safe to store: it identifies which key encrypted a row without revealing it.
async function keyFingerprint(raw: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from([...encoder.encode('trio-credential-key-id-v1:'), ...raw])));
  return [...digest.slice(0, 8)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const associatedData = (userId: string, provider: string) => encoder.encode(JSON.stringify(['trio-credentials-v1', userId, provider]));

export async function encryptCredential(master: string | undefined, userId: string, provider: string, value: string): Promise<Required<EncryptedCredential>> {
  const [current] = await masterKeys(master), iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: associatedData(userId, provider), tagLength: 128 }, current.key, encoder.encode(value));
  return { cipher: base64(cipher), iv: base64(iv), keyId: current.id };
}

/** Decrypts with the key the row names, or else each configured key in turn; `current` is false when it was not the first key. */
export async function decryptCredentialDetailed(master: string | undefined, userId: string, provider: string, value: EncryptedCredential) {
  const keys = await masterKeys(master), iv = bytes(value.iv);
  if (iv.length !== 12) throw new Error('Credential storage is unavailable.');
  // AES-GCM authenticates: a wrong key always fails here rather than returning garbage.
  const ordered = value.keyId ? [...keys.filter(k => k.id === value.keyId), ...keys.filter(k => k.id !== value.keyId)] : keys;
  for (const candidate of ordered) {
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: associatedData(userId, provider), tagLength: 128 }, candidate.key, bytes(value.cipher));
      return { value: new TextDecoder('utf-8', { fatal: true }).decode(plain), keyId: candidate.id, current: candidate.id === keys[0].id };
    } catch { /* try the next configured key */ }
  }
  throw new Error('Credential storage is unavailable.');
}
export async function decryptCredential(master: string | undefined, userId: string, provider: string, value: EncryptedCredential) {
  return (await decryptCredentialDetailed(master, userId, provider, value)).value;
}
