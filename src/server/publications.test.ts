import { describe, expect, it } from 'vitest';
import { sweepGalleryPublications } from './publications.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-01T00:00:00Z');
const PUBLICATION = '11111111-1111-4111-8111-111111111111';
const ACTIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ABANDONED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RECENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RETIRED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** The parts of an R2 bucket the publication code uses, in memory. */
class FakeBucket {
    objects = new Map<string, { body: string; uploaded: Date; etag: string }>();
    private version = 0;

    seed(key: string, body = 'x', uploaded = new Date(NOW)): void {
        this.objects.set(key, { body, uploaded, etag: `etag-${this.version += 1}` });
    }

    keys(prefix = ''): string[] {
        return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    }

    async head(key: string) {
        const object = this.objects.get(key);
        return object ? { key, httpEtag: object.etag, uploaded: object.uploaded } : null;
    }

    async get(key: string) {
        const object = this.objects.get(key);
        return object ? { key, json: async () => JSON.parse(object.body) } : null;
    }

    async put(key: string, body: string, options?: { onlyIf?: Headers }) {
        const existing = this.objects.get(key);
        if (options?.onlyIf?.get('If-None-Match') === '*' && existing) return null;
        const match = options?.onlyIf?.get('If-Match');
        if (match && existing?.etag !== match) return null;
        this.seed(key, body);
        return this.head(key);
    }

    async delete(keys: string | string[]): Promise<void> {
        for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
    }

    async list({ prefix = '', delimiter, limit = 1000, cursor, startAfter }: {
        prefix?: string; delimiter?: string; limit?: number; cursor?: string; startAfter?: string;
    } = {}) {
        const objects: { key: string; uploaded: Date }[] = [];
        const delimitedPrefixes: string[] = [];
        let last = '';
        let truncated = false;
        for (const key of this.keys(prefix)) {
            if ((cursor && key <= cursor) || (startAfter && key <= startAfter)) continue;
            const rest = key.slice(prefix.length);
            const cut = delimiter ? rest.indexOf(delimiter) : -1;
            const directory = cut >= 0 ? prefix + rest.slice(0, cut + 1) : null;
            if (directory && delimitedPrefixes.includes(directory)) continue;
            if (objects.length + delimitedPrefixes.length >= limit) { truncated = true; break; }
            if (directory) { delimitedPrefixes.push(directory); last = `${directory}￿`; }
            else { objects.push({ key, uploaded: this.objects.get(key)!.uploaded }); last = key; }
        }
        return { objects, delimitedPrefixes, truncated, cursor: truncated ? last : undefined };
    }
}

function setup() {
    const files = new FakeBucket();
    const pub = new FakeBucket();
    files.seed(`v1/publications/${PUBLICATION}/owner.json`);
    return { files, pub, env: { GALLERY_FILES: files, GALLERY_PUBLIC: pub } as never };
}

const publicFile = (revision: string, name = 'assets/one/thumbnail.webp') => `v1/galleries/${PUBLICATION}/revisions/${revision}/${name}`;
const pointer = `v1/galleries/${PUBLICATION}/active.json`;
const ago = (days: number) => new Date(NOW - days * DAY);

describe('gallery publication sweep', () => {
    it('deletes abandoned revisions and keeps the live and the recent ones', async () => {
        const { files, pub, env } = setup();
        pub.seed(pointer, JSON.stringify({ revision: ACTIVE }), ago(40));
        pub.seed(publicFile(ACTIVE), 'live', ago(40));
        pub.seed(publicFile(ABANDONED), 'old', ago(20));
        pub.seed(publicFile(RECENT), 'new', ago(1));
        files.seed(`v1/publications/${PUBLICATION}/revisions/${ABANDONED}/draft.json`, '{}', ago(20));

        await sweepGalleryPublications(env, NOW);

        expect(pub.keys(`v1/galleries/${PUBLICATION}/revisions/${ABANDONED}/`)).toEqual([]);
        expect(pub.keys(`v1/galleries/${PUBLICATION}/revisions/${ACTIVE}/`)).toEqual([publicFile(ACTIVE)]);
        expect(pub.keys(`v1/galleries/${PUBLICATION}/revisions/${RECENT}/`)).toEqual([publicFile(RECENT)]);
        expect(JSON.parse(pub.objects.get(pointer)!.body)).toEqual({ revision: ACTIVE });
        // The review stays available for a later update; only public files and queue entries go.
        expect(files.keys(`v1/publications/${PUBLICATION}/revisions/${ABANDONED}/draft.json`)).toHaveLength(1);
        expect(files.keys(`v1/publications/${PUBLICATION}/cleanup/`)).toEqual([]);
    });

    it('tombstones a never-published gallery so the stale review cannot activate', async () => {
        const { pub, env } = setup();
        pub.seed(publicFile(ABANDONED), 'old', ago(20));

        await sweepGalleryPublications(env, NOW);

        expect(pub.keys(`v1/galleries/${PUBLICATION}/revisions/`)).toEqual([]);
        expect(JSON.parse(pub.objects.get(pointer)!.body)).toEqual({ revision: null });
    });

    it('finishes a queued cleanup and drops the retired revision progress markers', async () => {
        const { files, pub, env } = setup();
        pub.seed(pointer, JSON.stringify({ revision: ACTIVE }), ago(1));
        pub.seed(publicFile(ACTIVE), 'live', ago(1));
        pub.seed(publicFile(RETIRED), 'retired', ago(1));
        files.seed(`v1/publications/${PUBLICATION}/cleanup/${RETIRED}.json`);
        files.seed(`v1/publications/${PUBLICATION}/revisions/${RETIRED}/chunks/0.json`);
        files.seed(`v1/publications/${PUBLICATION}/revisions/${RETIRED}/chunks/1.json`);
        files.seed(`v1/publications/${PUBLICATION}/revisions/${RETIRED}/draft.json`);

        const result = await sweepGalleryPublications(env, NOW);

        expect(result).toEqual({ publications: 1, revisions: 1 });
        expect(pub.keys(`v1/galleries/${PUBLICATION}/revisions/${RETIRED}/`)).toEqual([]);
        expect(pub.keys(`v1/galleries/${PUBLICATION}/revisions/${ACTIVE}/`)).toHaveLength(1);
        expect(files.keys(`v1/publications/${PUBLICATION}/`)).toEqual([
            `v1/publications/${PUBLICATION}/owner.json`,
            `v1/publications/${PUBLICATION}/revisions/${RETIRED}/draft.json`,
        ]);
    });
});
