import { parse as uuidParse } from 'uuid';
export const AAD_VERSION = 0x01;
export const AAD_LENGTH = 1 + 16 * 4;
export function buildAad(args: { userId: string; fileId: string; versionId: string; keyId: string }): Buffer {
  const out = Buffer.alloc(AAD_LENGTH);
  out[0] = AAD_VERSION;
  Buffer.from(uuidParse(args.userId)).copy(out, 1);
  Buffer.from(uuidParse(args.fileId)).copy(out, 17);
  Buffer.from(uuidParse(args.versionId)).copy(out, 33);
  Buffer.from(uuidParse(args.keyId)).copy(out, 49);
  return out;
}
