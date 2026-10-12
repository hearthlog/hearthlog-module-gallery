import { BucketStore } from '@hearthlog/sdk/endless';
import { queryDatabase } from '@hearthlog/sdk/data';
import type { GalleryAlbumChip, GalleryFilter } from '../../data/gallery.js';
import type { GalleryPhoto } from '@hearthlog/sdk/data';
import { galleryBlockMonth, galleryBlockPart } from '../../gallery/timeline.js';

export interface GalleryBlockData {
    /** SQL-ordered photos, newest first. */
    photos: GalleryPhoto[];
    /** Albums named in the month header, which only a month's first block has. */
    albums: GalleryAlbumChip[];
}

/**
 * Loaded blocks of the gallery timeline. Each batch of blocks that scroll
 * into view is one SQL session under the timeline's filter.
 */
export class GalleryBlocks extends BucketStore<GalleryBlockData> {
    constructor(filter: GalleryFilter, chips: boolean) {
        super(async (keys) => {
            const blocks = await queryDatabase((repositories) => Promise.all(keys.map(async (key) => ({
                photos: await repositories.gallery.blockPhotos(key, filter),
                albums: chips && galleryBlockPart(key) === 0
                    ? await repositories.gallery.monthAlbums(galleryBlockMonth(key), filter)
                    : [],
            }))));
            return new Map(keys.map((key, index) => [key, blocks[index]]));
        }, '[Gallery] Could not load photos');
    }
}
