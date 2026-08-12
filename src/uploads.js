'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const judge = require('./penalty/judge');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

/**
 * Shared evidence handling for both proof routes.
 *
 * Files are buffered in memory so they can be hashed and sniffed before
 * anything is written to disk, then stored outside the webroot under a random
 * name and served only through an authenticated route. The player's original
 * filename never becomes a path on the server.
 */
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: judge.MAX_FILE_BYTES, files: 1, fields: 6 },
});

/** Turn a multer file into the shape precheck and storage expect, or null. */
function fileFrom(reqFile) {
    if (!reqFile || !reqFile.buffer || reqFile.buffer.length === 0) return null;
    return {
        buffer: reqFile.buffer,
        mime: reqFile.mimetype,
        originalName: reqFile.originalname,
        size: reqFile.size,
        sha256: judge.sha256Of(reqFile.buffer),
    };
}

/** Persist the buffer and return the metadata a submission row stores. */
function store(file, prefix) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const ext = path.extname(file.originalName || '').slice(0, 10).replace(/[^\w.]/g, '');
    const name = `${prefix}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), file.buffer);
    return {
        storedPath: name,
        originalName: file.originalName,
        mime: file.mime,
        size: file.size,
        sha256: file.sha256,
    };
}

module.exports = { upload, fileFrom, store, UPLOAD_DIR };
