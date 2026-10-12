import {
    authorizeStorRequest,
    LedgerAdminConfigurationError,
    type LedgerAdminIdentity,
} from '@hearthlog/sdk/server';
import {
    LedgerScopeError,
    verifyLogAppId,
} from '@hearthlog/sdk/server';
import { readBodyCapped } from '@hearthlog/sdk/server';
import { verifyGalleryPhotoReference } from './ledger.js';

const PREFIX = '/api/gallery-files/v1';
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const ROUTE = new RegExp(`^${PREFIX}/logs/(${UUID})/photos/(${UUID})/versions/(${UUID})/(original|thumbnail|display)$`);
const MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const DERIVATIVE_WIDTHS = { thumbnail: 480, display: 2048 } as const;
type Derivative = keyof typeof DERIVATIVE_WIDTHS;

export type GalleryFileEnv = Pick<Env,
    'CF_ACCESS_APP_AUD' | 'CF_ACCESS_TEAM_DOMAIN' | 'STOR_AUTHORIZED_EMAILS' |
    'LEDGER' | 'LEDGER_AUTH_TOKEN' | 'GALLERY_FILES' | 'IMAGES'
>;

type Authorizer = (request: Request, env: GalleryFileEnv) => Promise<LedgerAdminIdentity>;

export async function handleGalleryFileRequest(
    request: Request,
    env: GalleryFileEnv,
    authorize: Authorizer = authorizeStorRequest,
): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(ROUTE);
    if (!match || !['PUT', 'GET', 'HEAD'].includes(request.method)) {
        return error(404, 'gallery_file_route_not_found', 'Gallery file route not found');
    }
    if (!env.LEDGER_AUTH_TOKEN || !env.GALLERY_FILES) {
        return error(503, 'gallery_files_unconfigured', 'Gallery files are not configured');
    }
    const origin = request.headers.get('Origin');
    if (origin !== null && origin !== url.origin) {
        return error(403, 'origin_not_allowed', 'Cross-origin file requests are not allowed');
    }
    try {
        await authorize(request, env);
    } catch (cause) {
        return cause instanceof LedgerAdminConfigurationError
            ? error(503, 'gallery_files_unconfigured', 'Gallery files are not configured')
            : error(403, 'gallery_files_forbidden', 'Hearthlog access is required');
    }

    const [, logId, photoId, fileVersionId, variant] = match;
    let appId: string;
    try {
        appId = await verifyLogAppId(logId, env);
        await verifyGalleryPhotoReference(logId, photoId, fileVersionId, env);
    } catch (cause) {
        if (cause instanceof LedgerScopeError) return error(cause.status, cause.code, cause.message);
        return error(503, 'ledger_verification_failed', 'The photo reference could not be verified');
    }
    const key = `v1/${appId}/${photoId}/${fileVersionId}/${variant}`;
    if (request.method === 'PUT') {
        if (variant !== 'original') return error(405, 'method_not_allowed', 'Only originals can be uploaded');
        if (!env.IMAGES) return error(503, 'gallery_images_unconfigured', 'Gallery image processing is unavailable');
        return putOriginal(request, env.GALLERY_FILES, env.IMAGES, key);
    }
    if (variant !== 'original' && env.IMAGES) {
        const repaired = await repairDerivative(env.GALLERY_FILES, env.IMAGES, key, variant as Derivative);
        if (repaired) return repaired;
    }
    return getFile(request, env.GALLERY_FILES, key);
}

function variantKey(key: string, variant: 'original' | Derivative): string {
    return key.replace(/\/(original|thumbnail|display)$/, `/${variant}`);
}

/**
 * Rebuild a missing derivative from its stored original, so a failed or
 * misplaced derivative write never leaves other devices without a preview.
 */
async function repairDerivative(
    bucket: R2Bucket,
    images: ImagesBinding,
    key: string,
    variant: Derivative,
): Promise<Response | null> {
    if (await bucket.head(key)) return null;
    const original = await bucket.get(variantKey(key, 'original'));
    if (!original) return null;
    try {
        const bytes = new Uint8Array(await original.arrayBuffer());
        await ensureDerivative(bucket, images, key, bytes, DERIVATIVE_WIDTHS[variant]);
    } catch {
        return error(503, 'gallery_derivatives_unavailable', 'The display image could not be prepared yet');
    }
    return null;
}

async function putOriginal(request: Request, bucket: R2Bucket, images: ImagesBinding, key: string): Promise<Response> {
    const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
    if (!IMAGE_TYPES.has(contentType)) {
        return error(415, 'unsupported_image_type', 'Use a JPEG, PNG, WebP, HEIC, or HEIF photo');
    }
    const declaredSize = request.headers.get('Content-Length');
    if (declaredSize !== null && (!Number.isSafeInteger(Number(declaredSize)) || Number(declaredSize) <= 0)) {
        return error(400, 'invalid_content_length', 'Content-Length must be a positive integer');
    }
    if (declaredSize !== null && Number(declaredSize) > MAX_BYTES) {
        return error(413, 'image_too_large', 'Photos must be 20 MiB or smaller');
    }
    if (!request.body) return error(400, 'image_body_required', 'A photo body is required');

    let bytes: Uint8Array;
    try {
        const capped = await readBodyCapped(request.body, MAX_BYTES);
        if (!capped) return error(413, 'image_too_large', 'Photos must be 20 MiB or smaller');
        bytes = capped;
    } catch {
        return error(400, 'image_unreadable', 'The photo could not be read');
    }
    if (!matchesImageSignature(bytes, contentType)) {
        return error(415, 'invalid_image', 'The photo bytes do not match the selected format');
    }
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const existing = await bucket.head(key);
    if (existing && !matchesExisting(existing, sha256, contentType)) {
        return error(409, 'gallery_file_version_conflict', 'This photo version already has different bytes');
    }
    let object = existing;
    if (!object) {
        object = await bucket.put(key, bytes, {
            onlyIf: new Headers({ 'If-None-Match': '*' }),
            sha256: digest,
            httpMetadata: { contentType },
            customMetadata: { sha256 },
        });
        if (!object) {
            object = await bucket.head(key);
            if (!object) return error(503, 'gallery_file_unavailable', 'The uploaded photo could not be verified');
            if (!matchesExisting(object, sha256, contentType)) {
                return error(409, 'gallery_file_version_conflict', 'This photo version already has different bytes');
            }
        }
    }
    try {
        for (const variant of ['thumbnail', 'display'] as const) {
            await ensureDerivative(bucket, images, variantKey(key, variant), bytes, DERIVATIVE_WIDTHS[variant]);
        }
    } catch (cause) {
        if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 9412) {
            return error(415, 'invalid_image', 'The photo could not be decoded');
        }
        return error(503, 'gallery_derivatives_unavailable', 'The original was stored, but display images need a retry');
    }
    return json({ size: object.size, sha256, contentType }, existing ? 200 : 201);
}

function matchesExisting(object: R2Object, sha256: string, contentType: string): boolean {
    return object.customMetadata?.sha256 === sha256 && object.httpMetadata?.contentType === contentType;
}

async function ensureDerivative(
    bucket: R2Bucket,
    images: ImagesBinding,
    key: string,
    original: Uint8Array,
    width: number,
): Promise<void> {
    if (await bucket.head(key)) return;
    const input = new Blob([new Uint8Array(original)]).stream();
    const transformed = await images.input(input).transform({ width, fit: 'scale-down' }).output({ format: 'image/webp', quality: 80 });
    const bytes = await transformed.response().arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) throw new Error('Invalid Gallery derivative');
    const created = await bucket.put(key, bytes, {
        onlyIf: new Headers({ 'If-None-Match': '*' }),
        httpMetadata: { contentType: 'image/webp' },
    });
    if (!created && !await bucket.head(key)) throw new Error('Gallery derivative was not stored');
}

async function getFile(request: Request, bucket: R2Bucket, key: string): Promise<Response> {
    const object = request.method === 'HEAD' ? await bucket.head(key) : await bucket.get(key);
    if (!object) return error(404, 'gallery_file_not_found', 'Photo bytes are not available');
    const headers = new Headers({
        'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
        'Content-Length': String(object.size),
        ETag: object.httpEtag,
        'Content-Disposition': 'inline',
    });
    if (request.headers.get('If-None-Match') === object.httpEtag) {
        return secure(null, { status: 304, headers: { ETag: object.httpEtag } });
    }
    const body = request.method === 'HEAD' ? null : (object as R2ObjectBody).body;
    return secure(body, { headers });
}

export function matchesImageSignature(bytes: Uint8Array, contentType: string): boolean {
    if (contentType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (contentType === 'image/png') return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
    if (contentType === 'image/webp') return bytes.length >= 12 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP');
    if (contentType === 'image/heic' || contentType === 'image/heif') {
        if (bytes.length < 12 || !ascii(bytes, 4, 'ftyp')) return false;
        const brand = String.fromCharCode(...bytes.slice(8, 12));
        return ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand);
    }
    return false;
}

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
    return [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}

function json(value: unknown, status: number): Response {
    return secure(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

function error(status: number, code: string, message: string): Response {
    return json({ error: message, code }, status);
}

function secure(body: BodyInit | null, init: ResponseInit): Response {
    const headers = new Headers(init.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(body, { ...init, headers });
}
