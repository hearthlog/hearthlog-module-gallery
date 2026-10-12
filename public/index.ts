import { render } from 'svelte/server';
import { activeKey, assetKey, idShard, idsKey, indexKey, manifestKey, pageKey, parsePublicIds, parsePublicIndex, parsePublicManifest, parsePublicPage, UUID, type PublicGalleryIndex, type PublicGalleryPage, type PublicGalleryPhoto } from './contract.js';
import { clientAssets } from './client-assets.js';
import { PAGE_SIZE, type PublicGalleryData, type PublicPageResponse, type PublicPhoto } from './app/types.js';
import App from './app/App.svelte';

export interface PublicGalleryEnv {
    GALLERY_PUBLIC: {
        get(key: string): Promise<{ json(): Promise<unknown>; body: ReadableStream<Uint8Array> } | null>;
    };
    PUBLIC_ORIGIN: string;
}

const PAGE = /^\/g\/([0-9a-f-]{36})\/?$/i;
const DETAIL = /^\/g\/([0-9a-f-]{36})\/photos\/([0-9a-f-]{36})\/?$/i;
/** Photo addresses shared before they dropped the revision and position; they redirect to `DETAIL`. */
const LEGACY_DETAIL = /^\/g\/([0-9a-f-]{36})\/photos\/([0-9a-f-]{36})\/(0|[1-9][0-9]{0,4})\/([0-9a-f-]{36})\/?$/i;
const ASSET = /^\/g\/([0-9a-f-]{36})\/assets\/([0-9a-f-]{36})\/(0|[1-9][0-9]{0,4})\/([0-9a-f-]{36})\/(thumbnail|display)\.webp$/i;
const PAGE_JSON = /^\/g\/([0-9a-f-]{36})\/pages\/(0|[1-9][0-9]{0,4})\.json$/i;
const BUNDLE = /^\/_app\/[A-Za-z0-9_.-]+$/;

/** Images may rest in a browser briefly; everything else is re-read so an unpublish shows at once. */
const IMAGE_CACHE_CONTROL = 'private, max-age=60';

/** Only this Worker's own bundle runs; styles may be inline for layout sizes. */
const CONTENT_SECURITY_POLICY = "default-src 'none'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function response(body: BodyInit | null, status = 200, contentType = 'text/html; charset=utf-8', cacheControl = 'no-store', extra: Record<string, string> = {}): Response {
    return new Response(body, { status, headers: {
        ...extra,
        'Content-Type': contentType,
        'Cache-Control': cacheControl,
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    } });
}

interface ActiveGallery {
    revision: string;
    index: PublicGalleryIndex;
    /** Photos of a whole v1 manifest, which has no page shards. */
    photos?: PublicGalleryPhoto[];
}

async function readJson(bucket: PublicGalleryEnv['GALLERY_PUBLIC'], key: string): Promise<unknown> {
    const object = await bucket.get(key);
    if (!object) return null;
    try { return await object.json(); } catch { return null; }
}

/**
 * Files of one revision never change, so this isolate keeps the recent ones.
 * The active pointer is not among them: it is read on every request.
 */
const revisionFiles = new Map<string, unknown>();
const REVISION_FILE_LIMIT = 256;

async function readRevisionJson(bucket: PublicGalleryEnv['GALLERY_PUBLIC'], key: string): Promise<unknown> {
    if (revisionFiles.has(key)) return revisionFiles.get(key);
    const value = await readJson(bucket, key);
    if (value !== null) {
        if (revisionFiles.size >= REVISION_FILE_LIMIT) revisionFiles.delete(revisionFiles.keys().next().value!);
        revisionFiles.set(key, value);
    }
    return value;
}

async function activeGallery(bucket: PublicGalleryEnv['GALLERY_PUBLIC'], publicationId: string): Promise<ActiveGallery | null> {
    const pointer = await readJson(bucket, activeKey(publicationId));
    if (!pointer || typeof pointer !== 'object' || !('revision' in pointer) || !UUID.test(String(pointer.revision))) return null;
    const revision = String(pointer.revision);
    const index = parsePublicIndex(await readRevisionJson(bucket, indexKey(publicationId, revision)));
    if (index) return { revision, index };
    // Revisions activated before index.json keep either a sharded index or a whole v1 manifest here.
    const legacy = await readRevisionJson(bucket, manifestKey(publicationId, revision));
    const legacyIndex = parsePublicIndex(legacy);
    if (legacyIndex) return { revision, index: legacyIndex };
    const manifest = parsePublicManifest(legacy);
    return manifest ? {
        revision, photos: manifest.photos,
        index: { version: 2, title: manifest.title, description: manifest.description, photoCount: manifest.photos.length },
    } : null;
}

async function galleryPage(bucket: PublicGalleryEnv['GALLERY_PUBLIC'], publicationId: string, gallery: ActiveGallery, page: number): Promise<PublicGalleryPage | null> {
    if (page < 0 || page >= Math.ceil(gallery.index.photoCount / PAGE_SIZE)) return null;
    if (gallery.photos) return { version: 2, photos: gallery.photos.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) };
    const shard = parsePublicPage(await readRevisionJson(bucket, pageKey(publicationId, gallery.revision, page)));
    return shard?.photos.length === Math.min(PAGE_SIZE, gallery.index.photoCount - page * PAGE_SIZE) ? shard : null;
}

async function photoAt(bucket: PublicGalleryEnv['GALLERY_PUBLIC'], publicationId: string, gallery: ActiveGallery, position: number): Promise<PublicGalleryPhoto | null> {
    if (position < 0 || position >= gallery.index.photoCount) return null;
    const shard = await galleryPage(bucket, publicationId, gallery, Math.floor(position / PAGE_SIZE));
    return shard?.photos[position % PAGE_SIZE] ?? null;
}

/**
 * Where a photo sits in the reviewed order. Revisions with lookup shards read
 * one; a revision published before them is searched page by page.
 */
async function positionOf(bucket: PublicGalleryEnv['GALLERY_PUBLIC'], publicationId: string, gallery: ActiveGallery, assetId: string): Promise<number | null> {
    if (gallery.photos) {
        const found = gallery.photos.findIndex((photo) => photo.assetId === assetId);
        return found < 0 ? null : found;
    }
    if (gallery.index.ids) {
        const ids = parsePublicIds(await readRevisionJson(bucket, idsKey(publicationId, gallery.revision, idShard(assetId))));
        return ids?.positions[assetId] ?? null;
    }
    for (let page = 0; page < Math.ceil(gallery.index.photoCount / PAGE_SIZE); page += 1) {
        const shard = await galleryPage(bucket, publicationId, gallery, page);
        const found = shard?.photos.findIndex((photo) => photo.assetId === assetId) ?? -1;
        if (found >= 0) return page * PAGE_SIZE + found;
    }
    return null;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]!);
}

/** The photos of one shard, with their positions in the reviewed order. */
function positioned(shard: PublicGalleryPage, page: number): PublicPhoto[] {
    return shard.photos.map((photo, offset) => ({ ...photo, position: page * PAGE_SIZE + offset }));
}

/**
 * The page is rendered on the server, so it reads and links without a
 * script; the browser bundle then takes over the same markup.
 */
function renderDocument(data: PublicGalleryData, documentTitle: string): string {
    const { head, body } = render(App, { props: { data } });
    // Script-free JSON for the browser, safe to embed in HTML.
    const state = JSON.stringify(data).replace(/</g, '\\u003c');
    const styles = clientAssets.styles.map((style) => `<link rel="stylesheet" href="${style.path}">`).join('');
    const script = clientAssets.script ? `<script type="module" src="${clientAssets.script.path}"></script>` : '';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex,nofollow,noarchive"><title>${escapeHtml(documentTitle)}</title>${styles}${head}${script}</head><body><div id="app">${body}</div><script type="application/json" id="gallery-data">${state}</script></body></html>`;
}

async function galleryDocument(bucket: PublicGalleryEnv['GALLERY_PUBLIC'], publicationId: string, gallery: ActiveGallery, page: number): Promise<string | null> {
    const shard = await galleryPage(bucket, publicationId, gallery, page);
    if (!shard) return null;
    return renderDocument({
        publicationId, revision: gallery.revision, title: gallery.index.title, description: gallery.index.description,
        photoCount: gallery.index.photoCount, months: gallery.index.months ?? null,
        firstPage: page, photos: positioned(shard, page), open: null,
    }, gallery.index.title);
}

/** A photo opened over its page; a photo near the page's edge brings the neighbouring page for the filmstrip. */
async function photoDocument(bucket: PublicGalleryEnv['GALLERY_PUBLIC'], publicationId: string, gallery: ActiveGallery, position: number): Promise<string | null> {
    const page = Math.floor(position / PAGE_SIZE);
    const pages = [page];
    const lastPage = Math.ceil(gallery.index.photoCount / PAGE_SIZE) - 1;
    if (position % PAGE_SIZE < 8 && page > 0) pages.unshift(page - 1);
    if (position % PAGE_SIZE > PAGE_SIZE - 9 && page < lastPage) pages.push(page + 1);
    const shards = await Promise.all(pages.map((number) => galleryPage(bucket, publicationId, gallery, number)));
    if (shards.some((shard) => !shard)) return null;
    const photos = shards.flatMap((shard, index) => positioned(shard!, pages[index]));
    const photo = photos.find((each) => each.position === position)!;
    return renderDocument({
        publicationId, revision: gallery.revision, title: gallery.index.title, description: gallery.index.description,
        photoCount: gallery.index.photoCount, months: gallery.index.months ?? null,
        firstPage: pages[0], photos, open: position,
    }, photo.caption || gallery.index.title);
}

export async function handlePublicGalleryRequest(request: Request, env: PublicGalleryEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== env.PUBLIC_ORIGIN) return response('Not found', 404, 'text/plain; charset=utf-8');
    if (request.method !== 'GET' && request.method !== 'HEAD') return response('Not found', 404, 'text/plain; charset=utf-8');
    if (url.pathname === '/robots.txt') return response(request.method === 'HEAD' ? null : 'User-agent: *\nDisallow: /\n', 200, 'text/plain; charset=utf-8');
    if (BUNDLE.test(url.pathname)) {
        // The browser bundle is named by its content, so it can be kept for good.
        const file = [clientAssets.script, ...clientAssets.styles].find((asset) => asset?.path === url.pathname);
        if (!file) return response('Not found', 404, 'text/plain; charset=utf-8');
        return response(request.method === 'HEAD' ? null : file.body, 200, file.type, 'public, max-age=31536000, immutable');
    }
    const pageMatch = url.pathname.match(PAGE);
    const detailMatch = url.pathname.match(DETAIL);
    const legacyMatch = url.pathname.match(LEGACY_DETAIL);
    const assetMatch = url.pathname.match(ASSET);
    const jsonMatch = url.pathname.match(PAGE_JSON);
    if (!pageMatch && !detailMatch && !legacyMatch && !assetMatch && !jsonMatch) return response('Not found', 404, 'text/plain; charset=utf-8');
    const publicationId = (pageMatch?.[1] ?? detailMatch?.[1] ?? legacyMatch?.[1] ?? assetMatch?.[1] ?? jsonMatch?.[1])!;
    if (!UUID.test(publicationId)) return response('Not found', 404, 'text/plain; charset=utf-8');
    let active;
    try { active = await activeGallery(env.GALLERY_PUBLIC, publicationId); }
    catch { return response('Unavailable', 503, 'text/plain; charset=utf-8'); }
    if (!active) return response('Not found', 404, 'text/plain; charset=utf-8');
    try {
        if (pageMatch) {
            const rawPage = url.searchParams.get('page') ?? '0';
            if (!/^(0|[1-9]\d{0,4})$/.test(rawPage)) return response('Not found', 404, 'text/plain; charset=utf-8');
            const html = await galleryDocument(env.GALLERY_PUBLIC, publicationId, active, Number(rawPage));
            if (!html) return response('Not found', 404, 'text/plain; charset=utf-8');
            return response(request.method === 'HEAD' ? null : html);
        }
        if (jsonMatch) {
            const page = Number(jsonMatch[2]);
            const shard = await galleryPage(env.GALLERY_PUBLIC, publicationId, active, page);
            if (!shard) return response('Not found', 404, 'text/plain; charset=utf-8');
            const body: PublicPageResponse = { revision: active.revision, page, photos: positioned(shard, page) };
            return response(request.method === 'HEAD' ? null : JSON.stringify(body), 200, 'application/json; charset=utf-8');
        }
        if (detailMatch || legacyMatch) {
            const assetId = (detailMatch?.[2] ?? legacyMatch![4]).toLowerCase();
            const position = await positionOf(env.GALLERY_PUBLIC, publicationId, active, assetId);
            if (position === null) return response('Not found', 404, 'text/plain; charset=utf-8');
            if (legacyMatch) {
                return response(null, 302, 'text/plain; charset=utf-8', 'no-store', { Location: `/g/${publicationId}/photos/${assetId}` });
            }
            const photo = await photoAt(env.GALLERY_PUBLIC, publicationId, active, position);
            if (!photo || photo.assetId !== assetId) return response('Not found', 404, 'text/plain; charset=utf-8');
            const html = await photoDocument(env.GALLERY_PUBLIC, publicationId, active, position);
            if (!html) return response('Not found', 404, 'text/plain; charset=utf-8');
            return response(request.method === 'HEAD' ? null : html);
        }
        const [, , revision, rawPosition, assetId, variant] = assetMatch!;
        if (revision !== active.revision || !UUID.test(assetId)) return response('Not found', 404, 'text/plain; charset=utf-8');
        const photo = await photoAt(env.GALLERY_PUBLIC, publicationId, active, Number(rawPosition));
        if (!photo || photo.assetId !== assetId) return response('Not found', 404, 'text/plain; charset=utf-8');
        const object = await env.GALLERY_PUBLIC.get(assetKey(publicationId, revision, assetId, variant as 'thumbnail' | 'display'));
        if (!object) return response('Not found', 404, 'text/plain; charset=utf-8');
        return response(request.method === 'HEAD' ? null : object.body, 200, 'image/webp', IMAGE_CACHE_CONTROL);
    } catch (error) {
        console.error('[Gallery] Public request failed', error);
        return response('Unavailable', 503, 'text/plain; charset=utf-8');
    }
}

export default { fetch: handlePublicGalleryRequest };
