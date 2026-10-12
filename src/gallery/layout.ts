/** Tiles keep a photo's shape between these ratios; wider panoramas and taller shots are cropped to them. */
export const MIN_TILE_RATIO = 0.5;
export const MAX_TILE_RATIO = 3;

/** Width over height as a tile shows it; a photo without dimensions is square. */
export function tileRatio(photo: { width: number; height: number }): number {
    return photo.width > 0 && photo.height > 0
        ? Math.min(MAX_TILE_RATIO, Math.max(MIN_TILE_RATIO, photo.width / photo.height))
        : 1;
}

export interface GalleryRow {
    /** The first photo in the row. */
    start: number;
    /** One past the last photo in the row. */
    end: number;
    height: number;
}

/** The most photos one row holds. */
const ROW_LIMIT = 12;

/**
 * Presentation geometry for photos SQL already ordered: rows that fill the
 * width exactly. The breaks are chosen for the whole block at once, so every
 * row stays close to the target height; a short last row keeps the target
 * height instead of stretching.
 */
export function justifiedRows(ratios: readonly number[], width: number, target: number, gap: number): GalleryRow[] {
    const count = ratios.length;
    if (count === 0 || width <= 0 || target <= 0) return [];
    const cost = new Float64Array(count + 1).fill(Infinity);
    const previous = new Int32Array(count + 1);
    cost[0] = 0;
    for (let end = 1; end <= count; end++) {
        let sum = 0;
        for (let start = end - 1; start >= 0 && end - start <= ROW_LIMIT; start--) {
            sum += ratios[start];
            const size = end - start;
            const height = (width - gap * (size - 1)) / sum;
            if (height < target * 0.55 && size > 1) break;
            let penalty: number;
            if (end === count && height >= target) penalty = 0;
            else if (height > target * 1.9) continue;
            else penalty = ((height - target) / target) ** 2 * (height > target ? 1.6 : 1);
            if (cost[start] + penalty < cost[end]) {
                cost[end] = cost[start] + penalty;
                previous[end] = start;
            }
        }
        // A photo no row can hold at a sensible height stands alone.
        if (cost[end] === Infinity) {
            cost[end] = cost[end - 1] + 10;
            previous[end] = end - 1;
        }
    }
    const rows: GalleryRow[] = [];
    for (let end = count; end > 0;) {
        const start = previous[end];
        let sum = 0;
        for (let index = start; index < end; index++) sum += ratios[index];
        const height = (width - gap * (end - start - 1)) / sum;
        rows.push({ start, end, height: Math.min(end === count ? target : target * 2, height) });
        end = start;
    }
    return rows.reverse();
}
