const DEFAULT_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAlwOlfFRaxuI1Jymudsj8
S4gU+xt0QaU5juxx7OCuS+nh/cEfViSyFpYsgK2zMQjuVJQyADVLxYdRwYaA9AXX
X1s3ELgo7JX1hh0B4G2CfFlbXZTqJDiq9cO0wlsuTCnbzNGVT22gkz4k75xtcB6O
+zUlgMQ56bbBGf8QB/2KTL1lrv7X1kHKYr8n3jLI706X2N225j4QYjeCABMxqcsE
2NODIDWbWHVDs3tRkzQmmbIfOv/EkyQwHT3cPNDza3Xi9qGtuHWdXgeTquO7Td8I
JesiOfXaO92XTeaELx3PTJWd/aACPHFEmB2FggQ1OcVsdBKJM4IjnO9LEkniSsL1
ALuTQj4wM+sXnDmILG+fMiAyvlpAZ0Uk/0Dogp20D76ZjJXqeo2B3g39rBnJN7gF
AOSnsZEEGyL0DapcOxR3IGAySa+agIjU6RiEgeVZ+Uwt1AcsU09tQK3sh0C/Du0j
04mdica32ZMP5ZmjPnvkwqZ0ASs+6bXd04K/OD7HJdLzAgMBAAE=
-----END PUBLIC KEY-----`;

function bytesToBase64(value) {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function pemToBytes(value) {
  const encoded = String(value || '').replace(
    /-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s+/g,
    ''
  );
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function encryptCodexContext(
  context,
  publicKeyPem = DEFAULT_PUBLIC_KEY_PEM
) {
  const rsaKey = await crypto.subtle.importKey(
    'spki',
    pemToBytes(publicKeyPem),
    {
      name: 'RSA-OAEP',
      hash: 'SHA-256'
    },
    false,
    ['encrypt']
  );
  const aesKey = await crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256
    },
    true,
    ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(context));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv
    },
    aesKey,
    plaintext
  );
  const rawAesKey = await crypto.subtle.exportKey('raw', aesKey);
  const wrappedKey = await crypto.subtle.encrypt(
    {
      name: 'RSA-OAEP'
    },
    rsaKey,
    rawAesKey
  );
  return {
    schema: 'timekeeper-codex-encrypted-context/v1',
    encryptedAt: new Date().toISOString(),
    algorithms: {
      content: 'AES-256-GCM',
      key: 'RSA-OAEP-3072-SHA256'
    },
    wrappedKey: bytesToBase64(wrappedKey),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext)
  };
}
