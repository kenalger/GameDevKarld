/**
 * Hands bytes to the browser as a file download.
 *
 * This was written out three times — once in App's crash-recovery export, once in the
 * states panel and once in the saves panel — with the same two subtleties in each copy
 * and no guarantee they would stay in step:
 *
 *  - The bytes are COPIED into a fresh ArrayBuffer first. The emulator's view may be
 *    backed by a SharedArrayBuffer once the core moves to a Web Worker, and `Blob` cannot
 *    take one.
 *  - The object URL is revoked immediately after the synthetic click, which is safe
 *    because `click()` on an anchor starts the download synchronously.
 *
 * Nothing here touches the network. The bytes go from memory to the user's own disk; an
 * object URL is local to the document and is never fetched by anything else.
 */
export declare function downloadBytes(data: Uint8Array, filename: string): void;
//# sourceMappingURL=download.d.ts.map