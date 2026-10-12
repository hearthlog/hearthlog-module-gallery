import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { AccessSessionExpiredError, fetchAccessProtected } from '@hearthlog/sdk/runtime';
import { requireActiveContext } from '@hearthlog/sdk/runtime';
import { commandActionsAvailable, commandAvailability } from '@hearthlog/sdk/runtime';

const DB_NAME = 'stor-gallery-files';
const DB_VERSION = 1;
const RETRY_MAX_MS = 5 * 60 * 1000;

export interface GalleryFileScope {
    tenantId: string;
    logId: string;
    photoId: string;
    fileVersionId: string;
}

interface GalleryBlob {
    key: string;
    blob: Blob;
    size: number;
    contentType: string;
}

export interface GalleryUpload extends GalleryFileScope {
    id: string;
    blobKey: string;
    attempts: number;
    nextAttemptAt: number;
    lastError: string;
    state: 'pending' | 'needs_attention';
}

interface GalleryFileDatabase extends DBSchema {
    blobs: { key: string; value: GalleryBlob };
    uploads: { key: string; value: GalleryUpload };
}

let databasePromise: Promise<IDBPDatabase<GalleryFileDatabase>> | null = null;
let transferPromise: Promise<void> | null = null;

function database(): Promise<IDBPDatabase<GalleryFileDatabase>> {
    databasePromise ??= openDB<GalleryFileDatabase>(DB_NAME, DB_VERSION, {
        upgrade(db) {
            db.createObjectStore('blobs', { keyPath: 'key' });
            db.createObjectStore('uploads', { keyPath: 'id' });
        },
    });
    return databasePromise;
}

function blobKey(scope: Pick<GalleryFileScope, 'tenantId' | 'photoId' | 'fileVersionId'>): string {
    return `${scope.tenantId}:${scope.photoId}:${scope.fileVersionId}`;
}

export function galleryFileEndpoint(scope: GalleryFileScope, variant: 'original' | 'thumbnail' | 'display' = 'original'): string {
    return `/api/gallery-files/v1/logs/${encodeURIComponent(scope.logId)}/photos/${encodeURIComponent(scope.photoId)}/versions/${encodeURIComponent(scope.fileVersionId)}/${variant}`;
}

/** Save bytes and the retry record in one durable transaction before appending metadata. */
export async function stageGalleryOriginal(scope: GalleryFileScope, file: File): Promise<void> {
    const db = await database();
    const key = blobKey(scope);
    const tx = db.transaction(['blobs', 'uploads'], 'readwrite');
    await Promise.all([
        tx.objectStore('blobs').put({ key, blob: file, size: file.size, contentType: file.type }),
        tx.objectStore('uploads').put({
            ...scope, id: key, blobKey: key, attempts: 0, nextAttemptAt: Date.now(),
            lastError: '', state: 'pending',
        }),
    ]);
    await tx.done;
    try { await navigator.storage?.persist?.(); } catch { /* Best effort. */ }
}

/** Only use when the corresponding metadata command definitively failed. */
export async function discardStagedGalleryOriginal(scope: GalleryFileScope): Promise<void> {
    const db = await database();
    const key = blobKey(scope);
    const tx = db.transaction(['blobs', 'uploads'], 'readwrite');
    await Promise.all([tx.objectStore('blobs').delete(key), tx.objectStore('uploads').delete(key)]);
    await tx.done;
}

export async function galleryUploadState(scope: GalleryFileScope): Promise<GalleryUpload | null> {
    return (await (await database()).get('uploads', blobKey(scope))) ?? null;
}

export async function galleryOriginal(scope: GalleryFileScope, options: { cache?: boolean } = {}): Promise<Blob> {
    const db = await database();
    const cached = await db.get('blobs', blobKey(scope));
    if (cached) return cached.blob;
    const response = await fetchAccessProtected(galleryFileEndpoint(scope));
    if (!response.ok) {
        if (response.status === 404) throw new Error('This photo is available when its original is uploaded.');
        throw new Error('The photo could not be loaded.');
    }
    const blob = await response.blob();
    // A viewed original is cached for offline use. Pending originals are never
    // evicted; cache budgeting follows in the recovery slice.
    if (options.cache !== false) {
        await db.put('blobs', {
            key: blobKey(scope), blob, size: blob.size,
            contentType: blob.type || response.headers.get('Content-Type') || 'application/octet-stream',
        });
    }
    return blob;
}

export async function galleryRendition(scope: GalleryFileScope, variant: 'thumbnail' | 'display'): Promise<Blob> {
    const db = await database();
    const key = `${blobKey(scope)}:${variant}`;
    const cached = await db.get('blobs', key);
    if (cached) return cached.blob;
    const localOriginal = await db.get('blobs', blobKey(scope));
    if (localOriginal) return localOriginal.blob;
    const response = await fetchAccessProtected(galleryFileEndpoint(scope, variant));
    if (!response.ok) {
        if (response.status === 404) throw new Error('This photo is available when its display image is uploaded.');
        throw new Error('The photo could not be loaded.');
    }
    const blob = await response.blob();
    await db.put('blobs', { key, blob, size: blob.size, contentType: 'image/webp' });
    return blob;
}

export async function galleryLocalStorageStats(): Promise<{ files: number; bytes: number; pending: number }> {
    const db = await database();
    const context = await requireActiveContext();
    const blobs = await db.getAll('blobs');
    const uploads = await db.getAll('uploads');
    return {
        files: blobs.filter((blob) => blob.key.startsWith(`${context.tenantId}:`)).length,
        bytes: blobs.filter((blob) => blob.key.startsWith(`${context.tenantId}:`)).reduce((total, blob) => total + blob.size, 0),
        pending: uploads.filter((upload) => upload.tenantId === context.tenantId).length,
    };
}

async function runGalleryTransfers(): Promise<void> {
    if (!commandActionsAvailable() || !navigator.onLine) return;
    const tenantId = (await requireActiveContext()).tenantId;
    const db = await database();
    const now = Date.now();
    const uploads = (await db.getAll('uploads'))
        .filter((upload) => upload.tenantId === tenantId && upload.state === 'pending' && upload.nextAttemptAt <= now)
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
        .slice(0, 3);
    for (const upload of uploads) {
        if (!commandActionsAvailable() || (await requireActiveContext()).tenantId !== tenantId) break;
        const cached = await db.get('blobs', upload.blobKey);
        if (!cached) {
            await db.put('uploads', { ...upload, state: 'needs_attention', lastError: 'The local photo is missing.' });
            continue;
        }
        try {
            const response = await fetchAccessProtected(galleryFileEndpoint(upload), {
                method: 'PUT', headers: { 'Content-Type': cached.contentType }, body: cached.blob,
            });
            if (!response.ok) {
                const body: unknown = await response.json().catch(() => null);
                const code = body && typeof body === 'object' && 'code' in body ? body.code : null;
                const permanent = [400, 409, 413, 415].includes(response.status);
                if (permanent) {
                    await db.put('uploads', {
                        ...upload, state: 'needs_attention', lastError: String(code ?? 'The upload was rejected.'),
                    });
                    continue;
                }
                throw new Error(String(code ?? 'The upload could not be completed.'));
            }
            await db.delete('uploads', upload.id);
            window.dispatchEvent(new CustomEvent('stor:gallery-transfer', { detail: upload.photoId }));
        } catch (cause) {
            if (cause instanceof AccessSessionExpiredError) break;
            const attempts = upload.attempts + 1;
            await db.put('uploads', {
                ...upload, attempts,
                nextAttemptAt: Date.now() + Math.min(RETRY_MAX_MS, 1000 * 2 ** Math.min(attempts, 8)),
                lastError: cause instanceof Error ? cause.message : 'Upload failed',
            });
        }
    }
    if (uploads.length === 3) window.setTimeout(triggerGalleryTransfers, 0);
}

export function triggerGalleryTransfers(): void {
    transferPromise ??= runGalleryTransfers().catch((cause) => {
        console.error('Gallery transfer failed', cause);
    }).finally(() => { transferPromise = null; });
}

export function startGalleryFileCoordinator(): () => void {
    const trigger = () => triggerGalleryTransfers();
    const unsubscribe = commandAvailability.subscribe(trigger);
    window.addEventListener('online', trigger);
    window.addEventListener('focus', trigger);
    window.addEventListener('pageshow', trigger);
    const interval = window.setInterval(trigger, 15_000);
    trigger();
    return () => {
        unsubscribe();
        window.removeEventListener('online', trigger);
        window.removeEventListener('focus', trigger);
        window.removeEventListener('pageshow', trigger);
        window.clearInterval(interval);
    };
}
