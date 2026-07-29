/**
 * crypto.getRandomValues(new Uint8Array(n)) は TS 5.7 以降の typed array 総称化により
 * 戻り値が Uint8Array<ArrayBufferLike> と推論され、BufferSource（ArrayBuffer前提）に
 * 渡せなくなることがある。ArrayBuffer を明示してから渡すことで型を固定する。
 */
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  crypto.getRandomValues(bytes);
  return bytes;
}
