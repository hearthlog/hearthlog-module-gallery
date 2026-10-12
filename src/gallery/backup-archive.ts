import type { AddGalleryPhotoPayload } from '@hearthlog/sdk/data';

const BLOCK = 512;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_PHOTOS = 100_000;
const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

export interface GalleryBackupPhoto extends AddGalleryPhotoPayload {
    sha256: string;
}

export interface GalleryBackupManifest {
    format: 'stor-gallery';
    version: 1;
    exportedAt: string;
    photos: GalleryBackupPhoto[];
    albums: Array<{ id: string; title: string; description: string; coverPhotoId: string }>;
    memberships: Array<{ albumId: string; photoId: string; addedAt: string }>;
}

export type ArchivePart = Blob;

function photoPath(id: string): string { return `photos/${id}.bin`; }

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
    const text = value.toString(8).padStart(length - 1, '0');
    if (text.length >= length) throw new Error('Gallery archive entry is too large.');
    for (let i = 0; i < text.length; i += 1) target[offset + i] = text.charCodeAt(i);
    target[offset + length - 1] = 0;
}

function header(name: string, size: number): Uint8Array {
    if (!/^[a-zA-Z0-9/._-]+$/.test(name) || name.length > 100 || !Number.isSafeInteger(size) || size < 0) {
        throw new Error('Invalid Gallery archive entry.');
    }
    const bytes = new Uint8Array(BLOCK);
    bytes.set(new TextEncoder().encode(name), 0);
    writeOctal(bytes, 100, 8, 0o644);
    writeOctal(bytes, 108, 8, 0);
    writeOctal(bytes, 116, 8, 0);
    writeOctal(bytes, 124, 12, size);
    writeOctal(bytes, 136, 12, 0);
    bytes.fill(32, 148, 156);
    bytes[156] = 48; // Regular file.
    bytes.set(new TextEncoder().encode('ustar\0'), 257);
    bytes.set(new TextEncoder().encode('00'), 263);
    const checksum = bytes.reduce((sum, byte) => sum + byte, 0);
    writeOctal(bytes, 148, 8, checksum);
    return bytes;
}

function padding(size: number): Uint8Array {
    return new Uint8Array((BLOCK - size % BLOCK) % BLOCK);
}

function bytesPart(bytes: Uint8Array): Blob {
    return new Blob([bytes as BlobPart]);
}

export async function sha256(blob: Blob): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A streaming, uncompressed tar. Manifest follows the bytes so each hash is verified. */
export async function* createGalleryArchive(
    manifest: Omit<GalleryBackupManifest, 'photos'> & { photos: Array<Omit<GalleryBackupPhoto, 'sha256'>> },
    original: (photo: Omit<GalleryBackupPhoto, 'sha256'>) => Promise<Blob>,
): AsyncGenerator<ArchivePart> {
    const photos: GalleryBackupPhoto[] = [];
    for (const photo of manifest.photos) {
        const blob = await original(photo);
        if (blob.size !== photo.byteSize) throw new Error(`${photo.filename}: original size does not match its metadata.`);
        photos.push({ ...photo, sha256: await sha256(blob) });
        yield bytesPart(header(photoPath(photo.id), blob.size));
        yield blob;
        yield bytesPart(padding(blob.size));
    }
    const encoded = new TextEncoder().encode(JSON.stringify({ ...manifest, photos } satisfies GalleryBackupManifest));
    if (encoded.byteLength > MAX_MANIFEST_BYTES) throw new Error('Gallery backup manifest is too large.');
    yield bytesPart(header('manifest.json', encoded.byteLength));
    yield bytesPart(encoded);
    yield bytesPart(padding(encoded.byteLength));
    yield bytesPart(new Uint8Array(BLOCK * 2));
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
    const end = bytes.indexOf(0, start);
    return new TextDecoder('ascii', { fatal: true }).decode(bytes.subarray(start, end < 0 || end >= start + length ? start + length : end));
}

function parseHeader(bytes: Uint8Array): { name: string; size: number } | null {
    if (bytes.length !== BLOCK) throw new Error('Gallery backup is truncated.');
    if (bytes.every((byte) => byte === 0)) return null;
    const expected = Number.parseInt(ascii(bytes, 148, 8).trim(), 8);
    const copy = bytes.slice();
    copy.fill(32, 148, 156);
    if (!Number.isSafeInteger(expected) || copy.reduce((sum, byte) => sum + byte, 0) !== expected) {
        throw new Error('Gallery backup header checksum is invalid.');
    }
    const name = ascii(bytes, 0, 100);
    const size = Number.parseInt(ascii(bytes, 124, 12).trim(), 8);
    if (!name || !Number.isSafeInteger(size) || size < 0 || bytes[156] !== 48) {
        throw new Error('Gallery backup contains an invalid entry.');
    }
    return { name, size };
}

function validateManifest(value: unknown): GalleryBackupManifest {
    if (!value || typeof value !== 'object') throw new Error('Gallery backup manifest is invalid.');
    const manifest = value as GalleryBackupManifest;
    if (manifest.format !== 'stor-gallery' || manifest.version !== 1 || !Array.isArray(manifest.photos)
        || !Array.isArray(manifest.albums) || !Array.isArray(manifest.memberships)
        || manifest.photos.length > MAX_PHOTOS) throw new Error('Unsupported Gallery backup.');
    const photoIds = new Set<string>();
    for (const photo of manifest.photos) {
        if (!UUID.test(photo.id) || !UUID.test(photo.fileVersionId) || photoIds.has(photo.id)
            || !TYPES.has(photo.contentType) || !Number.isSafeInteger(photo.byteSize)
            || photo.byteSize < 1 || photo.byteSize > MAX_PHOTO_BYTES
            || !/^[0-9a-f]{64}$/.test(photo.sha256)
            || typeof photo.filename !== 'string' || !photo.filename || photo.filename.length > 255
            || /[\\/\u0000-\u001f]/.test(photo.filename)
            || typeof photo.caption !== 'string' || photo.caption.length > 500
            || !Number.isSafeInteger(photo.width) || photo.width < 0
            || !Number.isSafeInteger(photo.height) || photo.height < 0
            || typeof photo.capturedAt !== 'string' || typeof photo.importedAt !== 'string'
            || !/^\d{4}-\d{2}-\d{2}$/.test(photo.timelineDay)
            || typeof photo.favorite !== 'boolean'
            || !optionalString(photo.cameraMake) || !optionalString(photo.cameraModel)
            || !optionalString(photo.lensModel) || !optionalNumber(photo.focalLength)
            || !optionalNumber(photo.fNumber) || !optionalNumber(photo.exposureTime)
            || !optionalNumber(photo.iso) || !optionalNumber(photo.latitude)
            || !optionalNumber(photo.longitude)) {
            throw new Error('Gallery backup contains invalid photo metadata.');
        }
        photoIds.add(photo.id);
    }
    const albumIds = new Set<string>();
    for (const album of manifest.albums) {
        if (!UUID.test(album.id) || albumIds.has(album.id) || typeof album.title !== 'string'
            || !album.title.trim() || album.title.length > 120 || typeof album.description !== 'string'
            || album.description.length > 240 || (album.coverPhotoId && !photoIds.has(album.coverPhotoId))) {
            throw new Error('Gallery backup contains invalid album metadata.');
        }
        albumIds.add(album.id);
    }
    for (const member of manifest.memberships) {
        if (!albumIds.has(member.albumId) || !photoIds.has(member.photoId) || typeof member.addedAt !== 'string') {
            throw new Error('Gallery backup contains invalid album membership.');
        }
    }
    return manifest;
}

function optionalString(value: unknown): boolean { return value === undefined || typeof value === 'string'; }
function optionalNumber(value: unknown): boolean { return value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value)); }

export async function readGalleryArchive(file: Blob): Promise<{
    manifest: GalleryBackupManifest;
    original: (photo: GalleryBackupPhoto) => Promise<Blob>;
}> {
    const entries = new Map<string, { start: number; size: number }>();
    let offset = 0;
    while (offset + BLOCK <= file.size && entries.size <= MAX_PHOTOS + 1) {
        const entry = parseHeader(new Uint8Array(await file.slice(offset, offset + BLOCK).arrayBuffer()));
        if (!entry) break;
        const start = offset + BLOCK;
        const next = start + entry.size + padding(entry.size).length;
        if (next > file.size || entries.has(entry.name) || (entry.name !== 'manifest.json' && !/^photos\/[0-9a-f-]{36}\.bin$/i.test(entry.name))) {
            throw new Error('Gallery backup contains an invalid or duplicate entry.');
        }
        entries.set(entry.name, { start, size: entry.size });
        offset = next;
    }
    const manifestEntry = entries.get('manifest.json');
    if (!manifestEntry || manifestEntry.size > MAX_MANIFEST_BYTES) throw new Error('Gallery backup manifest is missing.');
    const manifest = validateManifest(JSON.parse(await file.slice(manifestEntry.start, manifestEntry.start + manifestEntry.size).text()) as unknown);
    if (entries.size !== manifest.photos.length + 1) throw new Error('Gallery backup photo count does not match its manifest.');
    for (const photo of manifest.photos) {
        const entry = entries.get(photoPath(photo.id));
        if (!entry || entry.size !== photo.byteSize) throw new Error('Gallery backup photo is missing or incomplete.');
    }
    return {
        manifest,
        original: async (photo) => {
            const entry = entries.get(photoPath(photo.id));
            if (!entry) throw new Error('Gallery backup photo is missing.');
            const blob = file.slice(entry.start, entry.start + entry.size, photo.contentType);
            if (await sha256(blob) !== photo.sha256) throw new Error(`${photo.filename}: backup checksum does not match.`);
            return blob;
        },
    };
}
