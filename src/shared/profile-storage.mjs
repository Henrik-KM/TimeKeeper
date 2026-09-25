import { compressToUTF16, decompressFromUTF16 } from './vendor/lz-string.mjs';

const COMPRESSED_PREFIX = 'timekeeper-lz1:';

export function isCompressedProfile(raw) {
  return typeof raw === 'string' && raw.startsWith(COMPRESSED_PREFIX);
}

export function parseStoredProfile(raw) {
  if (!isCompressedProfile(raw)) return JSON.parse(raw);
  const decoded = decompressFromUTF16(raw.slice(COMPRESSED_PREFIX.length));
  if (!decoded)
    throw new Error('Saved TimeKeeper profile could not be decoded.');
  return JSON.parse(decoded);
}

export function persistProfile(storage, key, value) {
  const serialized = JSON.stringify(value);
  if (isCompressedProfile(storage.getItem(key))) {
    storage.setItem(key, COMPRESSED_PREFIX + compressToUTF16(serialized));
    return;
  }
  try {
    storage.setItem(key, serialized);
  } catch (error) {
    if (error?.name !== 'QuotaExceededError') throw error;
    storage.setItem(key, COMPRESSED_PREFIX + compressToUTF16(serialized));
  }
}
