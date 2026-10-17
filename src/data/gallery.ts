import { sql } from 'kysely';
import type { GalleryPhoto, GalleryAlbum, GalleryAlbumPhoto, GalleryPublication } from '@hearthlog/sdk/data';
import type { ReadModelSession } from '@hearthlog/sdk/data';
import { withTimeout } from '@hearthlog/sdk/data';
import { shiftMonthKey } from '@hearthlog/sdk/axis';
import { MAX_TILE_RATIO, MIN_TILE_RATIO } from '../gallery/layout.js';
import { GALLERY_BLOCK_SIZE, galleryBlockKey, galleryBlockMonth, galleryBlockPart } from '../gallery/timeline.js';

const DB_TIMEOUT_MS = 5000;

export interface GalleryCursor {
    day: string;
    importedAt: string;
    id: string;
}

/** Which photos a timeline lists. */
export interface GalleryFilter {
    query?: string;
    favoritesOnly?: boolean;
    albumId?: string;
}

/** One block of the timeline: a month, or a part of a big month. */
export interface GalleryBlockSummary {
    key: string;
    month: string;
    part: number;
    /** Blocks in this month. */
    parts: number;
    photos: number;
    /** The sum of the photos' tile ratios, for estimating the block's height. */
    ratio_sum: number;
    month_photos: number;
}

export interface GalleryMonthSummary {
    month: string;
    photos: number;
    /** The most photos any month holds, for scaling the spine. */
    peak: number;
}

export interface GallerySummary {
    blocks: GalleryBlockSummary[];
    months: GalleryMonthSummary[];
    count: number;
}

export interface GalleryAlbumChip {
    id: string;
    title: string;
}

export interface GalleryAlbumSummary extends GalleryAlbum {
    photo_count: number;
    effective_cover_photo_id: string;
    cover_file_version_id: string | null;
    cover_filename: string | null;
}

type TimelinePlace = Pick<GalleryPhoto, 'id' | 'timeline_day' | 'imported_at'>;

export function createGalleryRepository(session: ReadModelSession) {
    function conditions(filter: GalleryFilter) {
        const query = (filter.query ?? '').trim();
        const favoriteFilter = filter.favoritesOnly ? sql`AND p.favorite = 1` : sql``;
        const searchFilter = query
            ? sql`AND (instr(lower(p.filename), lower(${query})) > 0
                OR instr(lower(p.caption), lower(${query})) > 0)`
            : sql``;
        const albumFilter = filter.albumId
            ? sql`AND EXISTS (
                SELECT 1 FROM ${session.table('gallery_album_photos')} AS am
                WHERE am.album_id = ${filter.albumId} AND am.photo_id = p.id)`
            : sql``;
        return sql`${favoriteFilter} ${searchFilter} ${albumFilter}`;
    }

    /** Photos in a month: a range on the timeline day keeps the index in use. */
    function inMonth(month: string) {
        return sql`p.timeline_day >= ${month} AND p.timeline_day < ${shiftMonthKey(month, 1)}`;
    }

    function before(photo: TimelinePlace) {
        return sql`(p.timeline_day < ${photo.timeline_day}
            OR (p.timeline_day = ${photo.timeline_day} AND p.imported_at < ${photo.imported_at})
            OR (p.timeline_day = ${photo.timeline_day} AND p.imported_at = ${photo.imported_at} AND p.id < ${photo.id}))`;
    }

    function after(photo: TimelinePlace) {
        return sql`(p.timeline_day > ${photo.timeline_day}
            OR (p.timeline_day = ${photo.timeline_day} AND p.imported_at > ${photo.imported_at})
            OR (p.timeline_day = ${photo.timeline_day} AND p.imported_at = ${photo.imported_at} AND p.id > ${photo.id}))`;
    }

    async function count(filter: GalleryFilter = {}): Promise<number> {
        const result = await withTimeout(
            session.execute(sql<{ count: number }>`
                SELECT COUNT(*) AS count
                FROM ${session.table('gallery_photos')} AS p
                WHERE 1 = 1 ${conditions(filter)}
            `),
            DB_TIMEOUT_MS,
            'Gallery count query timed out',
        );
        return Number(result.rows[0]?.count ?? 0);
    }

    const ratio = sql`CASE WHEN p.width > 0 AND p.height > 0
        THEN MIN(MAX(p.width / p.height, ${MIN_TILE_RATIO}), ${MAX_TILE_RATIO}) ELSE 1.0 END`;

    return {
        /** Photos imported in `[from, until)`, both ISO instants like `imported_at`. */
        async countImported(from: string, until: string): Promise<number> {
            const result = await withTimeout(session.execute(sql<{ count: number | string | null }>`
                SELECT COUNT(*) AS count
                FROM ${session.table('gallery_photos')} AS p
                WHERE p.imported_at >= ${from} AND p.imported_at < ${until}
            `), DB_TIMEOUT_MS, 'Gallery import count query timed out');
            return Number(result.rows[0]?.count ?? 0);
        },

        /**
         * The timeline's blocks, its months for the spine, and its photo count.
         * Private timelines read newest first; public publication reads keep
         * their oldest-first story order.
         */
        async summary(filter: GalleryFilter = {}): Promise<GallerySummary> {
            const blocks = await withTimeout(session.execute(sql<GalleryBlockSummary>`
                WITH ranked AS (
                    SELECT substr(p.timeline_day, 1, 7) AS month, ${ratio} AS ratio,
                        (ROW_NUMBER() OVER (
                            PARTITION BY substr(p.timeline_day, 1, 7)
                            ORDER BY p.timeline_day DESC, p.imported_at DESC, p.id DESC
                        ) - 1) / ${sql.lit(GALLERY_BLOCK_SIZE)} AS part
                    FROM ${session.table('gallery_photos')} AS p
                    WHERE 1 = 1 ${conditions(filter)}
                ), parts AS (
                    SELECT month, part, COUNT(*) AS photos, SUM(ratio) AS ratio_sum
                    FROM ranked GROUP BY month, part
                )
                SELECT month || '/' || printf('%03d', part) AS key, month, part, photos, ratio_sum,
                    COUNT(*) OVER (PARTITION BY month) AS parts,
                    SUM(photos) OVER (PARTITION BY month) AS month_photos
                FROM parts
                ORDER BY month DESC, part
            `), DB_TIMEOUT_MS, 'Gallery summary query timed out');
            const months = await withTimeout(session.execute(sql<GalleryMonthSummary>`
                SELECT substr(p.timeline_day, 1, 7) AS month, COUNT(*) AS photos, MAX(COUNT(*)) OVER () AS peak
                FROM ${session.table('gallery_photos')} AS p
                WHERE 1 = 1 ${conditions(filter)}
                GROUP BY month
                ORDER BY month DESC
            `), DB_TIMEOUT_MS, 'Gallery months query timed out');
            return {
                blocks: blocks.rows.map((block) => ({
                    ...block, part: Number(block.part), parts: Number(block.parts), photos: Number(block.photos),
                    ratio_sum: Number(block.ratio_sum), month_photos: Number(block.month_photos),
                })),
                months: months.rows.map((month) => ({ month: month.month, photos: Number(month.photos), peak: Number(month.peak) })),
                count: await count(filter),
            };
        },

        count,

        /** One block's photos, newest first. */
        async blockPhotos(key: string, filter: GalleryFilter = {}): Promise<GalleryPhoto[]> {
            const result = await withTimeout(session.execute(sql<GalleryPhoto>`
                SELECT p.* FROM ${session.table('gallery_photos')} AS p
                WHERE ${inMonth(galleryBlockMonth(key))} ${conditions(filter)}
                ORDER BY p.timeline_day DESC, p.imported_at DESC, p.id DESC
                LIMIT ${GALLERY_BLOCK_SIZE} OFFSET ${galleryBlockPart(key) * GALLERY_BLOCK_SIZE}
            `), DB_TIMEOUT_MS, 'Gallery block query timed out');
            return result.rows;
        },

        /** The two albums holding most of a month's photos. */
        async monthAlbums(month: string, filter: GalleryFilter = {}): Promise<GalleryAlbumChip[]> {
            const result = await withTimeout(session.execute(sql<GalleryAlbumChip>`
                SELECT a.id, a.title
                FROM ${session.table('gallery_albums')} AS a
                JOIN (
                    SELECT m.album_id, COUNT(DISTINCT p.id) AS photos
                    FROM ${session.table('gallery_photos')} AS p
                    JOIN ${session.table('gallery_album_photos')} AS m ON m.photo_id = p.id
                    WHERE ${inMonth(month)} ${conditions(filter)}
                    GROUP BY m.album_id
                ) AS used ON used.album_id = a.id
                ORDER BY used.photos DESC, a.title COLLATE NOCASE, a.id
                LIMIT 2
            `), DB_TIMEOUT_MS, 'Gallery month albums query timed out');
            return result.rows;
        },

        /** Every photo in a month, for selecting the month at once. */
        async monthPhotoIds(month: string, filter: GalleryFilter = {}): Promise<string[]> {
            const result = await withTimeout(session.execute(sql<{ id: string }>`
                SELECT p.id FROM ${session.table('gallery_photos')} AS p
                WHERE ${inMonth(month)} ${conditions(filter)}
                ORDER BY p.timeline_day DESC, p.imported_at DESC, p.id DESC
            `), DB_TIMEOUT_MS, 'Gallery month photos query timed out');
            return result.rows.map((row) => row.id);
        },

        /** The block that lists a photo: parts count from the month's newest photo. */
        async photoBlock(photo: TimelinePlace, filter: GalleryFilter = {}): Promise<string> {
            const month = photo.timeline_day.slice(0, 7);
            const result = await withTimeout(session.execute(sql<{ part: number }>`
                SELECT COUNT(*) / ${sql.lit(GALLERY_BLOCK_SIZE)} AS part
                FROM ${session.table('gallery_photos')} AS p
                WHERE ${inMonth(month)} AND ${after(photo)} ${conditions(filter)}
            `), DB_TIMEOUT_MS, 'Gallery photo block query timed out');
            return galleryBlockKey(month, Number(result.rows[0]?.part ?? 0));
        },

        /** Up to `span` photos either side of one, oldest first on both sides. */
        async strip(photo: TimelinePlace, filter: GalleryFilter = {}, span = 8): Promise<{ older: GalleryPhoto[]; newer: GalleryPhoto[] }> {
            const older = await withTimeout(session.execute(sql<GalleryPhoto>`
                SELECT * FROM (
                    SELECT p.* FROM ${session.table('gallery_photos')} AS p
                    WHERE ${before(photo)} ${conditions(filter)}
                    ORDER BY p.timeline_day DESC, p.imported_at DESC, p.id DESC
                    LIMIT ${span}
                ) AS older
                ORDER BY older.timeline_day, older.imported_at, older.id
            `), DB_TIMEOUT_MS, 'Gallery strip query timed out');
            const newer = await withTimeout(session.execute(sql<GalleryPhoto>`
                SELECT p.* FROM ${session.table('gallery_photos')} AS p
                WHERE ${after(photo)} ${conditions(filter)}
                ORDER BY p.timeline_day, p.imported_at, p.id
                LIMIT ${span}
            `), DB_TIMEOUT_MS, 'Gallery strip query timed out');
            return { older: older.rows, newer: newer.rows };
        },

        async get(id: string): Promise<GalleryPhoto | null> {
            const row = await withTimeout(
                session.selectFrom('gallery_photos').selectAll().where('id', '=', id).executeTakeFirst(),
                DB_TIMEOUT_MS,
                'Gallery photo query timed out',
            );
            return row ?? null;
        },

        async albums(): Promise<GalleryAlbumSummary[]> {
            const result = await withTimeout(session.execute(sql<GalleryAlbumSummary>`
                WITH summaries AS (
                SELECT a.*,
                    COUNT(DISTINCT p.id) AS photo_count,
                    COALESCE(
                        (SELECT c.id FROM ${session.table('gallery_photos')} AS c
                         JOIN ${session.table('gallery_album_photos')} AS cm ON cm.photo_id = c.id
                         WHERE cm.album_id = a.id AND c.id = a.cover_photo_id LIMIT 1),
                        (SELECT c.id FROM ${session.table('gallery_photos')} AS c
                         JOIN ${session.table('gallery_album_photos')} AS cm ON cm.photo_id = c.id
                         WHERE cm.album_id = a.id
                         ORDER BY cm.added_at DESC, cm.id DESC LIMIT 1),
                        ''
                    ) AS effective_cover_photo_id
                FROM ${session.table('gallery_albums')} AS a
                LEFT JOIN ${session.table('gallery_album_photos')} AS m ON m.album_id = a.id
                LEFT JOIN ${session.table('gallery_photos')} AS p ON p.id = m.photo_id
                GROUP BY a.id
                )
                SELECT summaries.*, cover.file_version_id AS cover_file_version_id,
                    cover.filename AS cover_filename
                FROM summaries
                LEFT JOIN ${session.table('gallery_photos')} AS cover
                    ON cover.id = summaries.effective_cover_photo_id
                ORDER BY summaries.updated_at DESC, summaries.id DESC
            `), DB_TIMEOUT_MS, 'Gallery albums query timed out');
            return result.rows;
        },

        async album(id: string): Promise<GalleryAlbum | null> {
            return await withTimeout(
                session.selectFrom('gallery_albums').selectAll().where('id', '=', id).executeTakeFirst(),
                DB_TIMEOUT_MS, 'Gallery album query timed out',
            ) ?? null;
        },

        async selectablePhotos(albumId: string, query = '', before?: GalleryCursor, limit = 100): Promise<Array<GalleryPhoto & { in_album: number }>> {
            const capped = Math.max(1, Math.min(100, Math.trunc(limit)));
            const search = query.trim();
            const searchFilter = search
                ? sql`AND (instr(lower(p.filename), lower(${search})) > 0 OR instr(lower(p.caption), lower(${search})) > 0)`
                : sql``;
            const cursor = before ? sql`AND (p.timeline_day < ${before.day}
                OR (p.timeline_day = ${before.day} AND p.imported_at < ${before.importedAt})
                OR (p.timeline_day = ${before.day} AND p.imported_at = ${before.importedAt} AND p.id < ${before.id}))` : sql``;
            const result = await withTimeout(session.execute(sql<GalleryPhoto & { in_album: number }>`
                SELECT p.*, CASE WHEN EXISTS (
                    SELECT 1 FROM ${session.table('gallery_album_photos')} AS m
                    WHERE m.album_id = ${albumId} AND m.photo_id = p.id
                ) THEN 1 ELSE 0 END AS in_album
                FROM ${session.table('gallery_photos')} AS p
                WHERE 1 = 1 ${searchFilter} ${cursor}
                ORDER BY p.timeline_day DESC, p.imported_at DESC, p.id DESC
                LIMIT ${capped}
            `), DB_TIMEOUT_MS, 'Gallery selectable photos query timed out');
            return result.rows;
        },

        async membership(albumId: string, photoId: string): Promise<GalleryAlbumPhoto | null> {
            return await withTimeout(
                session.selectFrom('gallery_album_photos').selectAll()
                    .where('album_id', '=', albumId).where('photo_id', '=', photoId)
                    .orderBy('added_at', 'desc').executeTakeFirst(),
                DB_TIMEOUT_MS, 'Gallery membership query timed out',
            ) ?? null;
        },

        async memberships(albumId: string, photoId: string): Promise<GalleryAlbumPhoto[]> {
            return withTimeout(
                session.selectFrom('gallery_album_photos').selectAll()
                    .where('album_id', '=', albumId).where('photo_id', '=', photoId).execute(),
                DB_TIMEOUT_MS, 'Gallery memberships query timed out',
            );
        },

        async membershipsForPhotos(albumId: string, photoIds: string[]): Promise<GalleryAlbumPhoto[]> {
            if (photoIds.length === 0) return [];
            return withTimeout(
                session.selectFrom('gallery_album_photos').selectAll()
                    .where('album_id', '=', albumId).where('photo_id', 'in', photoIds).execute(),
                DB_TIMEOUT_MS, 'Gallery memberships query timed out',
            );
        },

        async addableAlbumPhotoIds(albumId: string, photoIds: string[]): Promise<string[]> {
            if (photoIds.length === 0 || photoIds.length > 10_000) return [];
            const result = await withTimeout(session.execute(sql<{ id: string }>`
                WITH requested AS (
                    SELECT value AS id, CAST(key AS INTEGER) AS position
                    FROM json_each(${JSON.stringify(photoIds)})
                )
                SELECT requested.id FROM requested
                JOIN ${session.table('gallery_photos')} AS p ON p.id = requested.id
                JOIN ${session.table('gallery_albums')} AS a ON a.id = ${albumId}
                WHERE NOT EXISTS (
                    SELECT 1 FROM ${session.table('gallery_album_photos')} AS m
                    WHERE m.album_id = a.id AND m.photo_id = p.id
                )
                ORDER BY requested.position
            `), DB_TIMEOUT_MS, 'Gallery album selection query timed out');
            return result.rows.map((row) => row.id);
        },

        async photoAlbums(photoId: string): Promise<GalleryAlbum[]> {
            const result = await withTimeout(session.execute(sql<GalleryAlbum>`
                SELECT DISTINCT a.* FROM ${session.table('gallery_albums')} AS a
                JOIN ${session.table('gallery_album_photos')} AS m ON m.album_id = a.id
                WHERE m.photo_id = ${photoId}
                ORDER BY a.title COLLATE NOCASE, a.id
            `), DB_TIMEOUT_MS, 'Gallery photo albums query timed out');
            return result.rows;
        },

        async exportSnapshot(): Promise<{
            photos: GalleryPhoto[];
            albums: GalleryAlbum[];
            memberships: GalleryAlbumPhoto[];
        }> {
            const [photos, albums, memberships] = await Promise.all([
                withTimeout(session.selectFrom('gallery_photos').selectAll()
                    .orderBy('timeline_day', 'desc').orderBy('imported_at', 'desc').orderBy('id', 'desc').execute(),
                DB_TIMEOUT_MS, 'Gallery export photos query timed out'),
                withTimeout(session.selectFrom('gallery_albums').selectAll().orderBy('id').execute(),
                    DB_TIMEOUT_MS, 'Gallery export albums query timed out'),
                withTimeout(session.execute(sql<GalleryAlbumPhoto>`
                    SELECT m.* FROM ${session.table('gallery_album_photos')} AS m
                    JOIN ${session.table('gallery_albums')} AS a ON a.id = m.album_id
                    JOIN ${session.table('gallery_photos')} AS p ON p.id = m.photo_id
                    ORDER BY m.added_at, m.id
                `), DB_TIMEOUT_MS, 'Gallery export memberships query timed out'),
            ]);
            return { photos, albums, memberships: memberships.rows };
        },

        async publications(): Promise<GalleryPublication[]> {
            return withTimeout(session.selectFrom('gallery_publications').selectAll()
                .where('owner_log_id', '=', session.scope.logId)
                .orderBy('requested_at', 'desc').orderBy('id', 'desc').execute(),
            DB_TIMEOUT_MS, 'Gallery publications query timed out');
        },

        async publication(id: string): Promise<GalleryPublication | null> {
            return await withTimeout(session.selectFrom('gallery_publications').selectAll()
                .where('owner_log_id', '=', session.scope.logId).where('id', '=', id).executeTakeFirst(),
            DB_TIMEOUT_MS, 'Gallery publication query timed out') ?? null;
        },

        async publicationAlbumPhotos(albumId: string): Promise<GalleryPhoto[]> {
            const result = await withTimeout(session.execute(sql<GalleryPhoto>`
                SELECT p.* FROM ${session.table('gallery_photos')} AS p
                WHERE EXISTS (
                    SELECT 1 FROM ${session.table('gallery_album_photos')} AS m
                    WHERE m.album_id = ${albumId} AND m.photo_id = p.id
                )
                ORDER BY p.timeline_day, p.imported_at, p.id
                LIMIT 10001
            `), DB_TIMEOUT_MS, 'Gallery publication album query timed out');
            return result.rows;
        },

        /** Handpicked photos, in the order asked for, or oldest first like the public page. */
        async publicationSelectedPhotos(photoIds: string[], order: 'request' | 'time' = 'request'): Promise<GalleryPhoto[]> {
            if (photoIds.length === 0 || photoIds.length > 10_000) return [];
            const result = await withTimeout(session.execute(sql<GalleryPhoto>`
                WITH requested AS (
                    SELECT value AS id, CAST(key AS INTEGER) AS position
                    FROM json_each(${JSON.stringify(photoIds)})
                )
                SELECT p.* FROM requested
                JOIN ${session.table('gallery_photos')} AS p ON p.id = requested.id
                ORDER BY ${order === 'time' ? sql`p.timeline_day, p.imported_at, p.id` : sql`requested.position`}
            `), DB_TIMEOUT_MS, 'Gallery publication selection query timed out');
            return result.rows;
        },
    };
}
