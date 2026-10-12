import { authorizeStorRequest, LedgerAdminConfigurationError, type LedgerAdminIdentity } from '@hearthlog/sdk/server';
import { LedgerScopeError, verifyLogAppId } from '@hearthlog/sdk/server';
import { verifyGalleryPhotoReference } from './ledger.js';
import { readBodyCapped } from '@hearthlog/sdk/server';
import {
    activeKey, assetKey, idsKey, indexKey, pageKey, parsePublicManifest, publicIdShards, publicMonths, UUID, validPhotoDetails,
    type PublicGalleryManifest, type PublicGalleryIndex, type PublicGalleryPage, type PublicGalleryPhotoDetails,
} from '../../public/contract.js';

const PREFIX = '/api/gallery-publications/v1';
const ID = '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})';
const ROOT = new RegExp(`^${PREFIX}/logs/${ID}/publications/${ID}$`);
const REVISION = new RegExp(`^${PREFIX}/logs/${ID}/publications/${ID}/revisions/${ID}$`);
const CHUNK = new RegExp(`^${PREFIX}/logs/${ID}/publications/${ID}/revisions/${ID}/chunks/(0|[1-9][0-9]*)$`);
const ACTIVATE = new RegExp(`^${PREFIX}/logs/${ID}/publications/${ID}/revisions/${ID}/activate$`);
const CLEANUP = new RegExp(`^${PREFIX}/logs/${ID}/publications/${ID}/revisions/${ID}/cleanup$`);
const UNPUBLISH = new RegExp(`^${PREFIX}/logs/${ID}/publications/${ID}/unpublish$`);
const MAX_BODY = 16 * 1024 * 1024;
const CHUNK_SIZE = 8;
const MAX_PHOTOS = 10_000;
/** A revision nobody activated or resumed for this long is abandoned. */
const ABANDONED_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const SWEEP_PUBLICATIONS_PER_RUN = 100;
const SWEEP_CURSOR_KEY = 'v1/sweep/publications.json';
const PUBLICATIONS_PREFIX = 'v1/publications/';

export type PublicationEnv = Pick<Env,
    'CF_ACCESS_APP_AUD' | 'CF_ACCESS_TEAM_DOMAIN' | 'STOR_AUTHORIZED_EMAILS' |
    'LEDGER' | 'LEDGER_AUTH_TOKEN' | 'GALLERY_FILES' | 'GALLERY_PUBLIC' |
    'GALLERY_PUBLIC_ORIGIN' | 'IMAGES'
>;

/** What the pointer, cleanup queue, and sweep touch; they need neither Ledger nor Access. */
type StorageEnv = Pick<PublicationEnv, 'GALLERY_FILES' | 'GALLERY_PUBLIC'>;

type Authorizer = (request: Request, env: PublicationEnv) => Promise<LedgerAdminIdentity>;

interface SourcePhoto {
    photoId: string;
    fileVersionId: string;
    assetId: string;
}

interface ReviewPhoto extends PublicGalleryPhotoDetails {
    photoId: string;
    fileVersionId: string;
    caption: string;
    alt: string;
    width: number;
    height: number;
}

const DETAIL_FIELDS = ['takenAt', 'camera', 'lens', 'fNumber', 'exposureTime', 'iso', 'focalLength', 'latitude', 'longitude'] as const;

/** The details an owner kept in the review, and nothing else the request carried. */
function sharedDetails(photo: PublicGalleryPhotoDetails): PublicGalleryPhotoDetails {
    const details: Record<string, unknown> = {};
    for (const field of DETAIL_FIELDS) {
        const value = photo[field];
        if (value !== undefined) details[field] = typeof value === 'string' ? value.trim() : value;
    }
    return details as PublicGalleryPhotoDetails;
}

interface ReviewRequest {
    title: string;
    description: string;
    photos: ReviewPhoto[];
}

interface Draft {
    version: 1;
    requestHash: string;
    expectedEtag: string | null;
    sources: SourcePhoto[];
    manifest: PublicGalleryManifest;
}

interface Owner { appId: string; logId: string }

function ownerKey(publicationId: string): string { return `v1/publications/${publicationId}/owner.json`; }
function draftKey(publicationId: string, revision: string): string { return `v1/publications/${publicationId}/revisions/${revision}/draft.json`; }
function markerPrefix(publicationId: string, revision: string): string { return `v1/publications/${publicationId}/revisions/${revision}/chunks/`; }
function markerKey(publicationId: string, revision: string, chunk: number): string { return `${markerPrefix(publicationId, revision)}${chunk}.json`; }
function cleanupPrefix(publicationId: string): string { return `v1/publications/${publicationId}/cleanup/`; }
function cleanupKey(publicationId: string, revision: string): string { return `${cleanupPrefix(publicationId)}${revision}.json`; }
function privateOriginalKey(appId: string, source: SourcePhoto): string { return `v1/${appId}/${source.photoId}/${source.fileVersionId}/original`; }

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    } });
}

function failure(status: number, code: string, message: string): Response { return json({ code, error: message }, status); }

async function parseBody(request: Request): Promise<ReviewRequest | null> {
    if (!request.body) return null;
    const bytes = await readBodyCapped(request.body, MAX_BODY);
    if (!bytes) return null;
    let value: unknown;
    try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
    if (!value || typeof value !== 'object') return null;
    const input = value as Partial<ReviewRequest>;
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120
        || typeof input.description !== 'string' || input.description.length > 500
        || !Array.isArray(input.photos) || input.photos.length < 1 || input.photos.length > MAX_PHOTOS) return null;
    const ids = new Set<string>();
    for (const photo of input.photos) {
        if (!photo || !UUID.test(photo.photoId) || !UUID.test(photo.fileVersionId) || ids.has(photo.photoId)
            || typeof photo.caption !== 'string' || photo.caption.length > 500
            || typeof photo.alt !== 'string' || photo.alt.length > 500
            || !Number.isSafeInteger(photo.width) || photo.width <= 0
            || !Number.isSafeInteger(photo.height) || photo.height <= 0
            || !validPhotoDetails(sharedDetails(photo))) return null;
        ids.add(photo.photoId);
    }
    return { title: input.title.trim(), description: input.description.trim(), photos: input.photos.map((photo) => ({
        photoId: photo.photoId, fileVersionId: photo.fileVersionId, caption: photo.caption.trim(),
        alt: photo.alt.trim(), width: photo.width, height: photo.height, ...sharedDetails(photo),
    })) };
}

async function digest(value: string): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
    const object = await bucket.get(key);
    if (!object) return null;
    try { return await object.json() as T; } catch { return null; }
}

async function getOwner(env: PublicationEnv, publicationId: string, appId: string, logId: string): Promise<Owner | null> {
    const owner = await readJson<Owner>(env.GALLERY_FILES, ownerKey(publicationId));
    return owner?.appId === appId && owner.logId === logId ? owner : null;
}

async function ensureOwner(env: PublicationEnv, publicationId: string, appId: string, logId: string): Promise<boolean> {
    const key = ownerKey(publicationId);
    if (!await env.GALLERY_FILES.head(key)) {
        await env.GALLERY_FILES.put(key, JSON.stringify({ appId, logId } satisfies Owner), {
            onlyIf: new Headers({ 'If-None-Match': '*' }),
            httpMetadata: { contentType: 'application/json' },
        });
    }
    return Boolean(await getOwner(env, publicationId, appId, logId));
}

async function draft(env: PublicationEnv, publicationId: string, revision: string): Promise<Draft | null> {
    const value = await readJson<Draft>(env.GALLERY_FILES, draftKey(publicationId, revision));
    if (value?.version !== 1 || !Array.isArray(value.sources) || !parsePublicManifest(value.manifest)) return null;
    if (value.sources.length !== value.manifest.photos.length) return null;
    return value;
}

async function publicRevision(env: StorageEnv, publicationId: string): Promise<string | null> {
    const pointer = await readJson<{ revision?: unknown }>(env.GALLERY_PUBLIC, activeKey(publicationId));
    return pointer && typeof pointer.revision === 'string' && UUID.test(pointer.revision) ? pointer.revision : null;
}

/** Retired revisions whose public files still await deletion. */
async function cleanupRevisions(env: Pick<StorageEnv, 'GALLERY_FILES'>, publicationId: string): Promise<string[]> {
    const pending: string[] = [];
    let cursor: string | undefined;
    do {
        const page = await env.GALLERY_FILES.list({ prefix: cleanupPrefix(publicationId), limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const object of page.objects) {
            const revision = object.key.slice(cleanupPrefix(publicationId).length).replace(/\.json$/, '');
            if (UUID.test(revision)) pending.push(revision);
        }
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return pending;
}

async function status(env: PublicationEnv, publicationId: string): Promise<Response> {
    const activeRevision = await publicRevision(env, publicationId);
    const pending = await cleanupRevisions(env, publicationId);
    return json({ publicationId, activeRevision, publicUrl: `${env.GALLERY_PUBLIC_ORIGIN}/g/${publicationId}`, cleanupRevisions: pending });
}

async function queueCleanup(env: StorageEnv, publicationId: string, revision: string | null): Promise<boolean> {
    if (!revision) return false;
    const key = cleanupKey(publicationId, revision);
    if (await env.GALLERY_FILES.head(key)) return false;
    const stored = await env.GALLERY_FILES.put(key, JSON.stringify({ revision }), {
        onlyIf: new Headers({ 'If-None-Match': '*' }),
        httpMetadata: { contentType: 'application/json' },
    });
    return Boolean(stored);
}

async function reviewedRevision(env: PublicationEnv, publicationId: string, revision: string): Promise<Response> {
    const current = await draft(env, publicationId, revision);
    if (!current) return failure(404, 'revision_not_found', 'Publication revision not found');
    return json({
        title: current.manifest.title,
        description: current.manifest.description,
        photos: current.sources.map((source, index) => ({
            photoId: source.photoId,
            fileVersionId: source.fileVersionId,
            caption: current.manifest.photos[index].caption,
            alt: current.manifest.photos[index].alt,
            width: current.manifest.photos[index].width,
            height: current.manifest.photos[index].height,
            ...sharedDetails(current.manifest.photos[index]),
        })),
    } satisfies ReviewRequest);
}

/**
 * Asset IDs of the live revision by source photo and file version. A photo
 * that is unchanged keeps its ID, so its address survives a republish.
 */
async function publishedAssetIds(env: PublicationEnv, publicationId: string): Promise<Map<string, string>> {
    const revision = await publicRevision(env, publicationId);
    const live = revision ? await draft(env, publicationId, revision) : null;
    return new Map((live?.sources ?? []).map((source) => [`${source.photoId}:${source.fileVersionId}`, source.assetId]));
}

async function putDraft(request: Request, env: PublicationEnv, appId: string, logId: string, publicationId: string, revision: string): Promise<Response> {
    const review = await parseBody(request).catch(() => null);
    if (!review) return failure(400, 'invalid_review', 'Review title, photos, and public captions are required');
    const requestHash = await digest(JSON.stringify(review));
    const key = draftKey(publicationId, revision);
    const existing = await draft(env, publicationId, revision);
    if (existing) {
        if (!await getOwner(env, publicationId, appId, logId)) return failure(404, 'publication_not_found', 'Publication not found');
        return existing.requestHash === requestHash
            ? json({ publicationId, revision, chunks: Math.ceil(existing.sources.length / CHUNK_SIZE) })
            : failure(409, 'revision_conflict', 'This revision was already reviewed with different content');
    }
    if (!await ensureOwner(env, publicationId, appId, logId)) return failure(404, 'publication_not_found', 'Publication not found');
    const pointer = await env.GALLERY_PUBLIC.head(activeKey(publicationId));
    const earlier = await publishedAssetIds(env, publicationId);
    const sources = review.photos.map((photo) => ({
        photoId: photo.photoId, fileVersionId: photo.fileVersionId,
        assetId: earlier.get(`${photo.photoId}:${photo.fileVersionId}`) ?? crypto.randomUUID(),
    }));
    const manifest: PublicGalleryManifest = {
        version: 1, title: review.title, description: review.description,
        photos: review.photos.map((photo, index) => ({
            assetId: sources[index].assetId, caption: photo.caption, alt: photo.alt,
            width: photo.width, height: photo.height, ...sharedDetails(photo),
        })),
    };
    const value: Draft = { version: 1, requestHash, expectedEtag: pointer?.httpEtag ?? null, sources, manifest };
    const created = await env.GALLERY_FILES.put(key, JSON.stringify(value), {
        onlyIf: new Headers({ 'If-None-Match': '*' }),
        httpMetadata: { contentType: 'application/json' },
    });
    if (!created) {
        const raced = await draft(env, publicationId, revision);
        if (!raced || raced.requestHash !== requestHash) return failure(409, 'revision_conflict', 'This revision was already reviewed with different content');
    }
    return json({ publicationId, revision, chunks: Math.ceil(sources.length / CHUNK_SIZE) }, 201);
}

async function transform(images: ImagesBinding, bytes: Uint8Array, width: number): Promise<ArrayBuffer> {
    const result = await images.input(new Blob([new Uint8Array(bytes)]).stream())
        .transform({ width, fit: 'scale-down' }).output({ format: 'image/webp', quality: 82, anim: false });
    const output = await result.response().arrayBuffer();
    if (output.byteLength === 0 || output.byteLength > 10 * 1024 * 1024) throw new Error('Invalid public image');
    return output;
}

async function processChunk(env: PublicationEnv, appId: string, logId: string, publicationId: string, revision: string, chunk: number): Promise<Response> {
    const current = await draft(env, publicationId, revision);
    if (!current) return failure(404, 'revision_not_found', 'Publication revision not found');
    const chunks = Math.ceil(current.sources.length / CHUNK_SIZE);
    if (chunk >= chunks) return failure(404, 'chunk_not_found', 'Publication chunk not found');
    const key = markerKey(publicationId, revision, chunk);
    const sources = current.sources.slice(chunk * CHUNK_SIZE, (chunk + 1) * CHUNK_SIZE);
    if (await env.GALLERY_FILES.head(key)) {
        const present = await Promise.all(sources.flatMap((source) => [
            env.GALLERY_PUBLIC.head(assetKey(publicationId, revision, source.assetId, 'thumbnail')),
            env.GALLERY_PUBLIC.head(assetKey(publicationId, revision, source.assetId, 'display')),
        ]));
        if (present.every(Boolean)) return json({ chunk, chunks, complete: true });
    }
    for (const source of sources) {
        try { await verifyGalleryPhotoReference(logId, source.photoId, source.fileVersionId, env); }
        catch (cause) {
            if (cause instanceof LedgerScopeError) return failure(cause.status, cause.code, cause.message);
            return failure(503, 'reference_unavailable', 'Source photo could not be verified');
        }
        const original = await env.GALLERY_FILES.get(privateOriginalKey(appId, source));
        if (!original) return failure(409, 'source_not_uploaded', 'Upload every selected original before publishing');
        const bytes = new Uint8Array(await original.arrayBuffer());
        for (const [variant, width] of [['thumbnail', 640], ['display', 2400]] as const) {
            const path = assetKey(publicationId, revision, source.assetId, variant);
            if (!await env.GALLERY_PUBLIC.head(path)) {
                let output: ArrayBuffer;
                try { output = await transform(env.IMAGES, bytes, width); }
                catch { return failure(503, 'public_image_failed', 'A public image could not be prepared'); }
                await env.GALLERY_PUBLIC.put(path, output, {
                    onlyIf: new Headers({ 'If-None-Match': '*' }),
                    httpMetadata: { contentType: 'image/webp' },
                });
                if (!await env.GALLERY_PUBLIC.head(path)) return failure(503, 'public_image_unavailable', 'A public image could not be stored');
            }
        }
    }
    await env.GALLERY_FILES.put(key, JSON.stringify({ complete: true }), {
        onlyIf: new Headers({ 'If-None-Match': '*' }),
        httpMetadata: { contentType: 'application/json' },
    });
    return json({ chunk, chunks, complete: true });
}

async function allChunksComplete(env: PublicationEnv, publicationId: string, revision: string, count: number): Promise<boolean> {
    const prefix = markerPrefix(publicationId, revision);
    const seen = new Set<number>();
    let cursor: string | undefined;
    do {
        const page = await env.GALLERY_FILES.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const object of page.objects) {
            const match = object.key.slice(prefix.length).match(/^(0|[1-9][0-9]*)\.json$/);
            if (match) seen.add(Number(match[1]));
        }
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return seen.size === count && Array.from({ length: count }, (_, index) => seen.has(index)).every(Boolean);
}

async function allPublicAssetsPresent(env: PublicationEnv, publicationId: string, revision: string, current: Draft): Promise<boolean> {
    const prefix = `v1/galleries/${publicationId}/revisions/${revision}/assets/`;
    const expected = new Set(current.sources.flatMap((source) => [
        assetKey(publicationId, revision, source.assetId, 'thumbnail'),
        assetKey(publicationId, revision, source.assetId, 'display'),
    ]));
    let cursor: string | undefined;
    do {
        const page = await env.GALLERY_PUBLIC.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const object of page.objects) expected.delete(object.key);
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return expected.size === 0;
}

async function ensurePublicJson(bucket: R2Bucket, key: string, value: unknown): Promise<boolean> {
    const body = JSON.stringify(value);
    const checksum = await digest(body);
    const existing = await bucket.head(key);
    if (existing) return existing.customMetadata?.sha256 === checksum;
    await bucket.put(key, body, {
        onlyIf: new Headers({ 'If-None-Match': '*' }),
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { sha256: checksum },
    });
    return (await bucket.head(key))?.customMetadata?.sha256 === checksum;
}

async function activate(env: PublicationEnv, publicationId: string, revision: string): Promise<Response> {
    const current = await draft(env, publicationId, revision);
    if (!current) return failure(404, 'revision_not_found', 'Publication revision not found');
    const chunks = Math.ceil(current.sources.length / CHUNK_SIZE);
    if (!await allChunksComplete(env, publicationId, revision, chunks)) {
        return failure(409, 'publication_incomplete', 'Public images are still being prepared');
    }
    if (!await allPublicAssetsPresent(env, publicationId, revision, current)) {
        return failure(409, 'publication_incomplete', 'A public image is missing');
    }
    const months = publicMonths(current.manifest.photos);
    const index: PublicGalleryIndex = {
        version: 2, title: current.manifest.title, description: current.manifest.description,
        photoCount: current.manifest.photos.length, ids: true, ...(months ? { months } : {}),
    };
    for (let page = 0; page < Math.ceil(index.photoCount / 100); page += 1) {
        const shard: PublicGalleryPage = { version: 2, photos: current.manifest.photos.slice(page * 100, (page + 1) * 100) };
        if (!await ensurePublicJson(env.GALLERY_PUBLIC, pageKey(publicationId, revision, page), shard)) {
            return failure(409, 'manifest_conflict', 'A public page differs from the reviewed revision');
        }
    }
    for (const [shard, ids] of publicIdShards(current.manifest.photos)) {
        if (!await ensurePublicJson(env.GALLERY_PUBLIC, idsKey(publicationId, revision, shard), ids)) {
            return failure(409, 'manifest_conflict', 'A public lookup differs from the reviewed revision');
        }
    }
    if (!await ensurePublicJson(env.GALLERY_PUBLIC, indexKey(publicationId, revision), index)) {
        return failure(409, 'manifest_conflict', 'Public manifest differs from the reviewed revision');
    }
    const pointerKey = activeKey(publicationId);
    const pointer = await env.GALLERY_PUBLIC.head(pointerKey);
    const previousRevision = await publicRevision(env, publicationId);
    if (previousRevision === revision) return status(env, publicationId);
    if ((pointer?.httpEtag ?? null) !== current.expectedEtag) {
        return failure(409, 'publication_changed', 'The public gallery changed after this review');
    }
    const queued = await queueCleanup(env, publicationId, previousRevision);
    const written = await env.GALLERY_PUBLIC.put(pointerKey, JSON.stringify({ revision }), {
        onlyIf: new Headers(pointer ? { 'If-Match': pointer.httpEtag } : { 'If-None-Match': '*' }),
        httpMetadata: { contentType: 'application/json' },
    });
    if (!written) {
        if (queued && previousRevision === await publicRevision(env, publicationId)) {
            await env.GALLERY_FILES.delete(cleanupKey(publicationId, previousRevision!));
        }
        return failure(409, 'publication_changed', 'The public gallery changed after this review');
    }
    return status(env, publicationId);
}

async function unpublish(env: PublicationEnv, publicationId: string): Promise<Response> {
    const key = activeKey(publicationId);
    const current = await env.GALLERY_PUBLIC.head(key);
    if (current && await publicRevision(env, publicationId) === null) return status(env, publicationId);
    const previousRevision = await publicRevision(env, publicationId);
    const queued = await queueCleanup(env, publicationId, previousRevision);
    const written = await env.GALLERY_PUBLIC.put(key, JSON.stringify({ revision: null }), {
        onlyIf: new Headers(current ? { 'If-Match': current.httpEtag } : { 'If-None-Match': '*' }),
        httpMetadata: { contentType: 'application/json' },
    });
    if (!written) {
        if (queued && previousRevision === await publicRevision(env, publicationId)) {
            await env.GALLERY_FILES.delete(cleanupKey(publicationId, previousRevision!));
        }
        return failure(409, 'publication_changed', 'The public gallery changed; refresh and retry');
    }
    return status(env, publicationId);
}

async function cleanupRevision(env: StorageEnv, publicationId: string, revision: string): Promise<Response> {
    const marker = cleanupKey(publicationId, revision);
    if (!await env.GALLERY_FILES.head(marker)) return failure(404, 'cleanup_not_found', 'No retired revision needs cleanup');
    const pointerKey = activeKey(publicationId);
    const pointer = await env.GALLERY_PUBLIC.head(pointerKey);
    if (!pointer) return failure(409, 'publication_changed', 'Refresh the public gallery status before cleanup');
    const activeRevision = await publicRevision(env, publicationId);
    if (activeRevision === revision) return failure(409, 'revision_active', 'An active public revision cannot be cleaned');
    // A conditional rewrite is a barrier against a stale activation racing deletion.
    const barrier = await env.GALLERY_PUBLIC.put(pointerKey, JSON.stringify({ revision: activeRevision }), {
        onlyIf: new Headers({ 'If-Match': pointer.httpEtag }),
        httpMetadata: { contentType: 'application/json' },
    });
    if (!barrier) return failure(409, 'publication_changed', 'The public gallery changed; retry cleanup');
    const prefix = `v1/galleries/${publicationId}/revisions/${revision}/`;
    const page = await env.GALLERY_PUBLIC.list({ prefix, limit: 1000 });
    if (page.objects.length) await env.GALLERY_PUBLIC.delete(page.objects.map((object) => object.key));
    const remaining = page.truncated || page.objects.length === 1000;
    if (!remaining) {
        await deleteChunkMarkers(env, publicationId, revision);
        await env.GALLERY_FILES.delete(marker);
    }
    return json({ revision, deleted: page.objects.length, remaining });
}

/** A retired revision cannot resume, so its per-chunk progress markers have no further use. */
async function deleteChunkMarkers(env: Pick<StorageEnv, 'GALLERY_FILES'>, publicationId: string, revision: string): Promise<void> {
    for (;;) {
        const page = await env.GALLERY_FILES.list({ prefix: markerPrefix(publicationId, revision), limit: 1000 });
        if (page.objects.length === 0) return;
        await env.GALLERY_FILES.delete(page.objects.map((object) => object.key));
    }
}

/** Deletes a retired revision's public files in batches, as the browser does. */
async function drainCleanup(env: StorageEnv, publicationId: string, revision: string): Promise<void> {
    for (let batch = 0; batch < 100; batch += 1) {
        const result = await cleanupRevision(env, publicationId, revision);
        if (!result.ok || !(await result.json() as { remaining?: boolean }).remaining) return;
    }
}

/** True when nothing under a revision's public prefix was written for the abandoned period. */
async function isAbandoned(env: StorageEnv, revisionPrefix: string, now: number): Promise<boolean> {
    const page = await env.GALLERY_PUBLIC.list({ prefix: revisionPrefix, limit: 1000 });
    if (page.objects.length === 0) return false;
    return now - Math.max(...page.objects.map((object) => object.uploaded.getTime())) > ABANDONED_AFTER_MS;
}

/** Puts an abandoned revision in the cleanup queue, behind a pointer a stale activation cannot beat. */
async function retireAbandoned(env: StorageEnv, publicationId: string, revision: string): Promise<boolean> {
    const pointerKey = activeKey(publicationId);
    if (!await env.GALLERY_PUBLIC.head(pointerKey)) {
        // A first publish that never finished: tombstone first, so cleanup has a pointer to guard and the stale review cannot activate.
        await env.GALLERY_PUBLIC.put(pointerKey, JSON.stringify({ revision: null }), {
            onlyIf: new Headers({ 'If-None-Match': '*' }),
            httpMetadata: { contentType: 'application/json' },
        });
    }
    await queueCleanup(env, publicationId, revision);
    return Boolean(await env.GALLERY_FILES.head(cleanupKey(publicationId, revision)));
}

async function sweepPublication(env: StorageEnv, publicationId: string, now: number): Promise<number> {
    const queued = await cleanupRevisions(env, publicationId);
    for (const revision of queued) await drainCleanup(env, publicationId, revision);
    const active = await publicRevision(env, publicationId);
    const skipped = new Set([...queued, ...(active ? [active] : [])]);
    const prefix = `v1/galleries/${publicationId}/revisions/`;
    let swept = queued.length;
    let cursor: string | undefined;
    do {
        const page = await env.GALLERY_PUBLIC.list({ prefix, delimiter: '/', limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const directory of page.delimitedPrefixes) {
            const revision = directory.slice(prefix.length, -1);
            if (!UUID.test(revision) || skipped.has(revision) || !await isAbandoned(env, directory, now)) continue;
            if (!await retireAbandoned(env, publicationId, revision)) continue;
            await drainCleanup(env, publicationId, revision);
            swept += 1;
        }
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return swept;
}

/**
 * Scheduled housekeeping: finishes interrupted cleanups and removes public files
 * of revisions that were reviewed and never activated. Each run takes a bounded
 * share of the publications and the next run continues after it.
 */
export async function sweepGalleryPublications(env: StorageEnv, now = Date.now()): Promise<{ publications: number; revisions: number }> {
    const stored = await readJson<{ after?: unknown }>(env.GALLERY_FILES, SWEEP_CURSOR_KEY);
    const after = typeof stored?.after === 'string' && UUID.test(stored.after) ? stored.after : null;
    // '0' sorts after '/', so this skips every key of the publication that ended the last run.
    const page = await env.GALLERY_FILES.list({
        prefix: PUBLICATIONS_PREFIX, delimiter: '/', limit: SWEEP_PUBLICATIONS_PER_RUN,
        ...(after ? { startAfter: `${PUBLICATIONS_PREFIX}${after}0` } : {}),
    });
    const ids = page.delimitedPrefixes.map((directory) => directory.slice(PUBLICATIONS_PREFIX.length, -1)).filter((id) => UUID.test(id));
    let revisions = 0;
    for (const publicationId of ids) revisions += await sweepPublication(env, publicationId, now);
    const finished = !page.truncated;
    await env.GALLERY_FILES.put(SWEEP_CURSOR_KEY, JSON.stringify(finished || ids.length === 0 ? {} : { after: ids[ids.length - 1] }), {
        httpMetadata: { contentType: 'application/json' },
    });
    return { publications: ids.length, revisions };
}

export async function handleGalleryPublicationRequest(
    request: Request,
    env: PublicationEnv,
    authorize: Authorizer = authorizeStorRequest,
): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(ROOT) ?? url.pathname.match(REVISION) ?? url.pathname.match(CHUNK)
        ?? url.pathname.match(ACTIVATE) ?? url.pathname.match(CLEANUP) ?? url.pathname.match(UNPUBLISH);
    if (!match) return failure(404, 'route_not_found', 'Publication route not found');
    const [, logId, publicationId] = match;
    const revision = url.pathname.match(REVISION)?.[3] ?? url.pathname.match(CHUNK)?.[3] ?? url.pathname.match(ACTIVATE)?.[3] ?? url.pathname.match(CLEANUP)?.[3];
    const chunk = url.pathname.match(CHUNK)?.[4];
    if (!env.GALLERY_FILES || !env.GALLERY_PUBLIC || !env.IMAGES || !env.LEDGER_AUTH_TOKEN || !env.GALLERY_PUBLIC_ORIGIN) {
        return failure(503, 'publication_unconfigured', 'Gallery publishing is not configured');
    }
    if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) {
        return failure(403, 'origin_not_allowed', 'Cross-origin publication requests are not allowed');
    }
    try { await authorize(request, env); }
    catch (cause) {
        return cause instanceof LedgerAdminConfigurationError
            ? failure(503, 'publication_unconfigured', 'Gallery publishing is not configured')
            : failure(403, 'publication_forbidden', 'Hearthlog access is required');
    }
    let appId: string;
    try { appId = await verifyLogAppId(logId, env); }
    catch (cause) {
        return cause instanceof LedgerScopeError
            ? failure(cause.status, cause.code, cause.message)
            : failure(503, 'ledger_verification_failed', 'Source log could not be verified');
    }
    if (request.method === 'PUT' && url.pathname.match(REVISION) && revision) {
        return putDraft(request, env, appId, logId, publicationId, revision);
    }
    if (!await getOwner(env, publicationId, appId, logId)) return failure(404, 'publication_not_found', 'Publication not found');
    if (request.method === 'GET' && url.pathname.match(ROOT)) return status(env, publicationId);
    if (request.method === 'GET' && url.pathname.match(REVISION) && revision) return reviewedRevision(env, publicationId, revision);
    if (request.method === 'POST' && chunk !== undefined && revision) return processChunk(env, appId, logId, publicationId, revision, Number(chunk));
    if (request.method === 'POST' && url.pathname.match(ACTIVATE) && revision) return activate(env, publicationId, revision);
    if (request.method === 'POST' && url.pathname.match(CLEANUP) && revision) return cleanupRevision(env, publicationId, revision);
    if (request.method === 'POST' && url.pathname.match(UNPUBLISH)) return unpublish(env, publicationId);
    return failure(404, 'route_not_found', 'Publication route not found');
}
