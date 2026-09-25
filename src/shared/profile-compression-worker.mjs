import { compressToUTF16 } from './vendor/lz-string.mjs';

self.onmessage = (event) => {
  self.postMessage(compressToUTF16(event.data));
};
