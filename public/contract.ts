export const PUBLIC_GALLERY_PREFIX = 'v1/galleries';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Photo details an owner chose to share in the review. Each is absent when its
 * switch is off; the public copies themselves never carry embedded metadata.
 */
export interface PublicGalleryPhotoDetails {
    /** When the photo was taken, by the camera's own clock: `yyyy-MM-dd` or `yyyy-MM-ddTHH:mm`. */
    takenAt?: string;
    camera?: string;
    lens?: string;
    fNumber?: number;
    exposureTime?: number;
    iso?: number;
    focalLength?: number;
    latitude?: number;
    longitude?: number;
}

export interface PublicGalleryPhoto extends PublicGalleryPhotoDetails {
    assetId: string;
    caption: string;
    alt: string;
    width: number;
    height: number;
}

/** A month of a dated gallery in time order, with the position of its first photo. */
export interface PublicGalleryMonth {
    month: string;
    photos: number;
    position: number;
}

export interface PublicGalleryManifest {
    version: 1;
    title: string;
    description: string;
    photos: PublicGalleryPhoto[];
}

export interface PublicGalleryIndex {
    version: 2;
    title: string;
    description: string;
    photoCount: number;
    /** Present when every photo shares its date and the photos run in time order. */
    months?: PublicGalleryMonth[];
    /** Set when the revision has `ids/` lookup shards, so a photo address can name its asset alone. */
    ids?: true;
}

/** Positions of the photos whose asset ID starts with one shard prefix, in the reviewed order. */
export interface PublicGalleryIds {
    version: 2;
    positions: Record<string, number>;
}

export interface PublicGalleryPage {
    version: 2;
    photos: PublicGalleryPhoto[];
}

export function activeKey(publicationId: string): string {
    return `${PUBLIC_GALLERY_PREFIX}/${publicationId}/active.json`;
}

/** Whole v1 manifest of revisions activated before sharding; new revisions no longer write one. */
export function manifestKey(publicationId: string, revision: string): string {
    return `${PUBLIC_GALLERY_PREFIX}/${publicationId}/revisions/${revision}/manifest.json`;
}

export function indexKey(publicationId: string, revision: string): string {
    return `${PUBLIC_GALLERY_PREFIX}/${publicationId}/revisions/${revision}/index.json`;
}

export function pageKey(publicationId: string, revision: string, page: number): string {
    return `${PUBLIC_GALLERY_PREFIX}/${publicationId}/revisions/${revision}/pages/${page}.json`;
}

export function idsKey(publicationId: string, revision: string, shard: string): string {
    return `${PUBLIC_GALLERY_PREFIX}/${publicationId}/revisions/${revision}/ids/${shard}.json`;
}

/** The lookup shard of an asset: the first two hex digits of its ID. */
export function idShard(assetId: string): string {
    return assetId.slice(0, 2).toLowerCase();
}

/** Lookup shards for a revision: asset ID to position, 256 shards at most. */
export function publicIdShards(photos: readonly { assetId: string }[]): Map<string, PublicGalleryIds> {
    const shards = new Map<string, PublicGalleryIds>();
    photos.forEach((photo, position) => {
        const shard = idShard(photo.assetId);
        let ids = shards.get(shard);
        if (!ids) shards.set(shard, ids = { version: 2, positions: {} });
        ids.positions[photo.assetId.toLowerCase()] = position;
    });
    return shards;
}

export function assetKey(publicationId: string, revision: string, assetId: string, variant: 'thumbnail' | 'display'): string {
    return `${PUBLIC_GALLERY_PREFIX}/${publicationId}/revisions/${revision}/assets/${assetId}/${variant}.webp`;
}

const TAKEN_AT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
const MONTH = /^\d{4}-\d{2}$/;

function optionalText(value: unknown): boolean {
    return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= 120);
}

function optionalMeasure(value: unknown): boolean {
    return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1_000_000);
}

/** Shared details are optional; present ones must be well formed. */
export function validPhotoDetails(photo: PublicGalleryPhotoDetails): boolean {
    const hasLatitude = photo.latitude !== undefined;
    if (hasLatitude !== (photo.longitude !== undefined)) return false;
    if (hasLatitude && !(typeof photo.latitude === 'number' && Math.abs(photo.latitude) <= 90
        && typeof photo.longitude === 'number' && Math.abs(photo.longitude) <= 180)) return false;
    return (photo.takenAt === undefined || (typeof photo.takenAt === 'string' && TAKEN_AT.test(photo.takenAt)))
        && optionalText(photo.camera) && optionalText(photo.lens)
        && optionalMeasure(photo.fNumber) && optionalMeasure(photo.exposureTime)
        && optionalMeasure(photo.iso) && optionalMeasure(photo.focalLength);
}

function validPhoto(photo: PublicGalleryPhoto | undefined, ids: Set<string>): boolean {
    if (!photo || !UUID.test(photo.assetId) || ids.has(photo.assetId)
        || typeof photo.caption !== 'string' || photo.caption.length > 500
        || typeof photo.alt !== 'string' || photo.alt.length > 500
        || !Number.isSafeInteger(photo.width) || photo.width <= 0
        || !Number.isSafeInteger(photo.height) || photo.height <= 0
        || !validPhotoDetails(photo)) return false;
    ids.add(photo.assetId);
    return true;
}

/**
 * Months for the spine, when every photo has a date and they run in time
 * order; otherwise none, and the page shows no month headings or spine.
 */
export function publicMonths(photos: readonly PublicGalleryPhotoDetails[]): PublicGalleryMonth[] | undefined {
    const months: PublicGalleryMonth[] = [];
    for (let position = 0; position < photos.length; position += 1) {
        const month = photos[position].takenAt?.slice(0, 7);
        if (!month) return undefined;
        const last = months[months.length - 1];
        if (last && month < last.month) return undefined;
        if (last?.month === month) last.photos += 1;
        else months.push({ month, photos: 1, position });
    }
    return months.length ? months : undefined;
}

export function parsePublicManifest(value: unknown): PublicGalleryManifest | null {
    if (!value || typeof value !== 'object') return null;
    const manifest = value as Partial<PublicGalleryManifest>;
    if (manifest.version !== 1 || typeof manifest.title !== 'string' || manifest.title.length > 120
        || typeof manifest.description !== 'string' || manifest.description.length > 500
        || !Array.isArray(manifest.photos) || manifest.photos.length === 0 || manifest.photos.length > 10_000) return null;
    const ids = new Set<string>();
    for (const photo of manifest.photos) if (!validPhoto(photo, ids)) return null;
    return manifest as PublicGalleryManifest;
}

export function parsePublicIndex(value: unknown): PublicGalleryIndex | null {
    if (!value || typeof value !== 'object') return null;
    const index = value as Partial<PublicGalleryIndex>;
    if (!(index.version === 2 && typeof index.title === 'string' && index.title.length <= 120
        && typeof index.description === 'string' && index.description.length <= 500
        && Number.isSafeInteger(index.photoCount) && index.photoCount! > 0 && index.photoCount! <= 10_000)) return null;
    if (index.ids !== undefined && index.ids !== true) return null;
    if (index.months !== undefined) {
        if (!Array.isArray(index.months) || index.months.length === 0) return null;
        let previous = '';
        let covered = 0;
        for (const month of index.months) {
            if (!month || typeof month.month !== 'string' || !MONTH.test(month.month) || month.month <= previous
                || !Number.isSafeInteger(month.photos) || month.photos <= 0
                || month.position !== covered) return null;
            previous = month.month;
            covered += month.photos;
        }
        if (covered !== index.photoCount) return null;
    }
    return index as PublicGalleryIndex;
}

export function parsePublicPage(value: unknown): PublicGalleryPage | null {
    if (!value || typeof value !== 'object') return null;
    const page = value as Partial<PublicGalleryPage>;
    if (page.version !== 2 || !Array.isArray(page.photos) || page.photos.length < 1 || page.photos.length > 100) return null;
    const ids = new Set<string>();
    for (const photo of page.photos) if (!validPhoto(photo, ids)) return null;
    return page as PublicGalleryPage;
}

export function parsePublicIds(value: unknown): PublicGalleryIds | null {
    if (!value || typeof value !== 'object') return null;
    const ids = value as Partial<PublicGalleryIds>;
    if (ids.version !== 2 || !ids.positions || typeof ids.positions !== 'object') return null;
    const entries = Object.entries(ids.positions);
    if (entries.length === 0 || entries.length > 10_000) return null;
    for (const [assetId, position] of entries) {
        if (!UUID.test(assetId) || !Number.isSafeInteger(position) || position < 0 || position >= 10_000) return null;
    }
    return ids as PublicGalleryIds;
}
