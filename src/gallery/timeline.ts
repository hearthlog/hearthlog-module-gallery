/**
 * The gallery timeline lists blocks of photos in time order. A block is a
 * month, and a big month splits into parts of `GALLERY_BLOCK_SIZE` photos so
 * the endless list only keeps what is on screen. Keys sort in time order:
 * `2024-06/000`, `2024-06/001`, `2024-07/000`.
 */
export const GALLERY_BLOCK_SIZE = 240;

export function galleryBlockKey(month: string, part = 0): string {
    return `${month}/${String(part).padStart(3, '0')}`;
}

export function galleryBlockMonth(key: string): string {
    return key.slice(0, 7);
}

export function galleryBlockPart(key: string): number {
    return Number(key.slice(8)) || 0;
}

/**
 * Orders block keys the way the timeline lists them: newest month first, and
 * within a month the newest part (part 0) first.
 */
export function compareGalleryBlockKeys(left: string, right: string): number {
    const leftMonth = left.slice(0, 7);
    const rightMonth = right.slice(0, 7);
    if (leftMonth !== rightMonth) return leftMonth < rightMonth ? 1 : -1;
    return galleryBlockPart(left) - galleryBlockPart(right);
}

/** Photo size, from small to large; each device keeps its own. */
export type GalleryDensity = 0 | 1 | 2;
export const GALLERY_DENSITY_KEY = 'gallery:density';

export function parseGalleryDensity(value: unknown): GalleryDensity {
    return value === 0 || value === 1 || value === 2 ? value : 1;
}

export interface GalleryGeometry {
    /** The width rows fill. */
    width: number;
    rowHeight: number;
    gap: number;
    /** A month header's height. */
    header: number;
    /** Space after a month's last block. */
    monthGap: number;
}

/** Rows grow with the list: phones get shorter rows and narrower gaps. */
export function galleryGeometry(width: number, density: GalleryDensity): GalleryGeometry {
    const wide = width >= 600;
    return {
        width,
        rowHeight: (wide ? [150, 220, 310] : [96, 132, 184])[density],
        gap: wide ? 5 : 3,
        header: wide ? 60 : 52,
        monthGap: wide ? 24 : 16,
    };
}

export interface GalleryBlockShape {
    part: number;
    parts: number;
    photos: number;
    ratio_sum: number;
}

/** A block's height before it renders, from its photo count and the sum of their shapes. */
export function estimateGalleryBlock(block: GalleryBlockShape | undefined, geometry: GalleryGeometry): number {
    if (!block || geometry.width <= 0) return geometry.header + geometry.rowHeight;
    const rows = (block.ratio_sum * geometry.rowHeight + block.photos * geometry.gap) / (geometry.width + geometry.gap);
    return (block.part === 0 ? geometry.header : 0)
        + Math.max(1, Math.round(rows + 0.4)) * (geometry.rowHeight + geometry.gap)
        + (block.part === block.parts - 1 ? geometry.monthGap : 0);
}
