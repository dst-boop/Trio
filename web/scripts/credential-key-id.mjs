// Prints the key_id fingerprint for an encryption master read from standard input, so an
// operator rotating TRIO_CREDENTIAL_KEY can check which saved keys still use an older master.
// Usage: node scripts/credential-key-id.mjs   (then paste the base64 key and press Ctrl-D)
import { credentialKeyId } from '../lib/credential-crypto.ts';

let input = '';
for await (const chunk of process.stdin) input += chunk;
try { console.log(await credentialKeyId(input.trim())); }
catch { console.error('Enter one 32-byte base64 key (44 characters).'); process.exitCode = 1; }
