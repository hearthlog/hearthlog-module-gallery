import { addDays, parseISO } from 'date-fns';
import type { AttentionContribution, NavFigure } from '@hearthlog/contracts';
import { queryDatabase } from '@hearthlog/sdk/data';
import { formatNumber } from '@hearthlog/sdk/format';

/** Photos added today, counted by SQL; no figure on a day without imports. */
export function importedTodayFigure(count: number): NavFigure[] {
    if (count <= 0) return [];
    const photos = `${formatNumber(count)} ${count === 1 ? 'photo' : 'photos'}`;
    return [{ id: 'gallery', text: `+${formatNumber(count)} new`, label: `${photos} added today` }];
}

/** Today's imports beside Gallery in the sidebar. */
export const attention: AttentionContribution = {
    async figures({ today }) {
        // `imported_at` is an ISO instant; today is the local day, from its midnight to the next.
        const start = parseISO(today);
        const count = await queryDatabase((repositories) =>
            repositories.gallery.countImported(start.toISOString(), addDays(start, 1).toISOString()));
        return importedTodayFigure(count);
    },
};
