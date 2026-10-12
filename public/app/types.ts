import type { PublicGalleryMonth, PublicGalleryPhoto } from '../contract.js';

/** Photos per page shard in the public bucket. */
export const PAGE_SIZE = 100;

/** A published photo and its place in the reviewed order. */
export interface PublicPhoto extends PublicGalleryPhoto {
    position: number;
}

/** What the Worker renders and the browser picks up from. */
export interface PublicGalleryData {
    publicationId: string;
    revision: string;
    title: string;
    description: string;
    photoCount: number;
    months: PublicGalleryMonth[] | null;
    /** The first page shard loaded; later ones follow without gaps. */
    firstPage: number;
    photos: PublicPhoto[];
    /** The photo the address opens. */
    open: number | null;
}

export interface PublicPageResponse {
    revision: string;
    page: number;
    photos: PublicPhoto[];
}

export function galleryPath(publicationId: string, page = 0): string {
    return page > 0 ? `/g/${publicationId}?page=${page}` : `/g/${publicationId}`;
}

/** A photo's address names its asset alone, so it outlives republishing. */
export function photoPath(publicationId: string, photo: Pick<PublicPhoto, 'assetId'>): string {
    return `/g/${publicationId}/photos/${photo.assetId}`;
}

export function assetPath(publicationId: string, revision: string, photo: Pick<PublicPhoto, 'position' | 'assetId'>, variant: 'thumbnail' | 'display'): string {
    return `/g/${publicationId}/assets/${revision}/${photo.position}/${photo.assetId}/${variant}.webp`;
}

export function pagePath(publicationId: string, page: number): string {
    return `/g/${publicationId}/pages/${page}.json`;
}

/** The asset a photo address names, or null. */
export function openedAsset(pathname: string): string | null {
    const match = pathname.match(/^\/g\/[0-9a-f-]{36}\/photos\/([0-9a-f-]{36})\/?$/i);
    return match ? match[1].toLowerCase() : null;
}
