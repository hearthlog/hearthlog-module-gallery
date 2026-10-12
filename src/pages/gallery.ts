import type { ModuleLoadEvent } from '@hearthlog/sdk/runtime';
import { deferPage } from '@hearthlog/sdk/runtime';
import { queryDatabase } from '@hearthlog/sdk/data';
import { requireActiveContext } from '@hearthlog/sdk/runtime';
import type { GallerySummary } from '../data/gallery.js';

export const load = (event: ModuleLoadEvent) => {
    event.depends('app:gallery');
    const query = event.url.searchParams.get('q') ?? '';
    const favoritesOnly = event.url.searchParams.get('tab') === 'favorites';
    return deferPage(event, {
        summary: { blocks: [], months: [], count: 0 } as GallerySummary, tenantId: '', logId: '',
    }, async () => {
        const [context, summary] = await Promise.all([
            requireActiveContext(),
            queryDatabase((repositories) => repositories.gallery.summary({ query, favoritesOnly })),
        ]);
        return { summary, tenantId: context.tenantId, logId: context.logId };
    });
};
