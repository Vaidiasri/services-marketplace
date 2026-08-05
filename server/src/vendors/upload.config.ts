import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { diskStorage } from 'multer';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Deliberately outside any static mount. Documents are streamed through an
 * authenticated route, never served as static files - otherwise anyone who guesses a
 * filename reads another vendor's paperwork.
 */
export const UPLOAD_DIR = resolve(process.env.UPLOAD_DIR ?? 'uploads/vendor-documents');

/** MIME -> the extension we will store, and the leading bytes a real file must have. */
const SIGNATURES: Record<string, { ext: string; magic: number[][] }> = {
  'application/pdf': { ext: '.pdf', magic: [[0x25, 0x50, 0x44, 0x46]] }, // %PDF
  'image/png': { ext: '.png', magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  'image/jpeg': { ext: '.jpg', magic: [[0xff, 0xd8, 0xff]] },
};

export const ALLOWED_MIME = Object.keys(SIGNATURES);

export function ensureUploadDir(): void {
  if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * Multer decides the filename, never the client.
 *
 * The stored name is a UUID plus an extension derived from the declared MIME type - not
 * from the uploaded filename. That closes path traversal completely: no part of a
 * client-supplied string reaches the path. The original name is kept in the database for
 * display only.
 */
export const multerOptions: MulterOptions = {
  storage: diskStorage({
    destination: (_req, _file, cb) => {
      ensureUploadDir();
      cb(null, UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
      const declared = SIGNATURES[file.mimetype];
      const ext = declared?.ext ?? safeExt(file.originalname);
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  // A cheap first pass on the declared type. The real check is the magic-byte sniff
  // below, which runs after the write - Content-Type is client-supplied and trivially
  // forged, so rejecting on it alone would accept a renamed executable.
  fileFilter: (_req, file, cb) => cb(null, file.mimetype in SIGNATURES),
};

function safeExt(original: string): string {
  const ext = extname(original).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '';
}

/**
 * Reads the first bytes off disk and compares them against the signature for the
 * declared MIME type. Returns false when the declared type and the actual content
 * disagree - a .exe renamed to .pdf with Content-Type: application/pdf fails here, which
 * is the case the fileFilter above cannot see.
 */
export function magicBytesMatch(path: string, mimetype: string): boolean {
  const sig = SIGNATURES[mimetype];
  if (!sig) return false;

  const longest = Math.max(...sig.magic.map((m) => m.length));
  const buf = Buffer.alloc(longest);
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const read = readSync(fd, buf, 0, longest, 0);
    return sig.magic.some(
      (magic) => read >= magic.length && magic.every((byte, i) => buf[i] === byte),
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
