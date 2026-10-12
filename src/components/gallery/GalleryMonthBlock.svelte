<script lang="ts">
    import type { GalleryBlockSummary } from '../../data/gallery.js';
    import type { GalleryBlockData } from './gallery-blocks.svelte.js';
    import { formatMonthParts } from '../../gallery/format.js';
    import type { GalleryGeometry } from '../../gallery/timeline.js';
    import JustifiedRows from './view/JustifiedRows.svelte';
    import MonthHeading from './view/MonthHeading.svelte';
    import PhotoTile from './PhotoTile.svelte';
    import IconCheck from '~icons/mdi/check';

    let {
        block,
        data,
        geometry,
        tenantId,
        logId,
        beginning = '',
        last = false,
        selecting = false,
        selectedIds,
        monthSelected = false,
        onOpen,
        onSelect,
        onSelectMonth,
        onOpenAlbum,
    }: {
        block: GalleryBlockSummary;
        /** Missing while the block loads. */
        data: GalleryBlockData | undefined;
        geometry: GalleryGeometry;
        tenantId: string;
        logId: string;
        /** A line above the first month of the timeline. */
        beginning?: string;
        /** The timeline's last (oldest) block; the selection bar floats past it. */
        last?: boolean;
        selecting?: boolean;
        selectedIds: Set<string>;
        monthSelected?: boolean;
        onOpen: (id: string) => void;
        onSelect: (id: string) => void;
        onSelectMonth: (month: string, select: boolean) => void;
        onOpenAlbum?: (id: string) => void;
    } = $props();

    const month = $derived(formatMonthParts(block.month));
    /** Placeholder rows shaped like the estimate, so nothing jumps when the photos arrive. */
    const placeholder = $derived.by(() => {
        const count = Math.max(1, Math.round((block.ratio_sum * geometry.rowHeight + block.photos * geometry.gap) / (geometry.width + geometry.gap) + 0.4));
        const perRow = Math.max(1, Math.ceil(block.photos / count));
        return Array.from({ length: count }, (_, row) => Math.max(1, Math.min(perRow, block.photos - row * perRow)));
    });
</script>

<div
    class="gallery-block"
    class:month-end={block.part === block.parts - 1}
    class:selection-room={last && selecting}
    style:--gallery-gap={`${geometry.gap}px`}
    style:--gallery-header={`${geometry.header}px`}
    style:--gallery-month-gap={`${geometry.monthGap}px`}
    aria-busy={!data}
>
    {#if beginning}<p class="gallery-beginning stor-serif-title">{beginning}</p>{/if}
    {#if block.part === 0}
        <MonthHeading month={block.month} count={block.month_photos}>
            {#snippet before()}
                {#if selecting}
                    <button type="button" class="gallery-month-check" aria-pressed={monthSelected} aria-label={`Select all of ${month.name} ${month.year}`} onclick={() => onSelectMonth(block.month, !monthSelected)}>
                        <IconCheck class="h-3.5 w-3.5" />
                    </button>
                {/if}
            {/snippet}
            {#snippet after()}
                {#if data?.albums.length && onOpenAlbum}
                    <span class="gallery-month-albums">
                        {#each data.albums as album (album.id)}
                            <button type="button" class="gallery-chip" onclick={() => onOpenAlbum(album.id)}>{album.title}</button>
                        {/each}
                    </span>
                {/if}
            {/snippet}
        </MonthHeading>
    {/if}
    {#if data}
        <JustifiedRows items={data.photos} key={(photo) => photo.id} width={geometry.width} rowHeight={geometry.rowHeight} gap={geometry.gap}>
            {#snippet tile(photo, size)}
                <PhotoTile
                    {photo}
                    {tenantId}
                    {logId}
                    width={size?.width ?? 0}
                    height={size?.height ?? 0}
                    selectable={selecting}
                    selected={selectedIds.has(photo.id)}
                    onOpen={() => onOpen(photo.id)}
                    onSelect={() => onSelect(photo.id)}
                />
            {/snippet}
        </JustifiedRows>
    {:else}
        <div class="gallery-rows">
            {#each placeholder as cells, row (row)}
                <div class="gallery-row" style:height={`${geometry.rowHeight}px`} role={row === 0 ? 'status' : undefined} aria-label={row === 0 ? 'Loading photos' : undefined}>
                    {#each Array.from({ length: cells }) as _, cell (cell)}
                        <span class="gallery-placeholder motion-safe:animate-pulse" style:flex-grow={1 + ((cell * 7 + row * 3) % 5) / 6}></span>
                    {/each}
                </div>
            {/each}
        </div>
    {/if}
</div>

<style>
    .gallery-block { padding-inline: var(--gallery-inset-start) var(--gallery-inset-end); }
    .gallery-block.month-end { padding-bottom: var(--gallery-month-gap); }
    /* The selection bar floats over the list's end; the last photos stay reachable above it. */
    .gallery-block.selection-room { padding-bottom: calc(var(--gallery-month-gap) + 64px); }
    .gallery-beginning {
        padding: 28px 0 6px;
        color: var(--stor-muted-text);
        font-size: 16px;
        font-style: italic;
        font-weight: 500;
        text-align: center;
    }
    .gallery-month-albums { display: flex; min-width: 0; gap: 4px; overflow: hidden; }
    .gallery-chip {
        max-width: 14em;
        flex: none;
        overflow: hidden;
        border-radius: 999px;
        background: var(--stor-surface-muted);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--stor-border) 60%, transparent);
        padding: 5px 10px;
        color: var(--stor-muted-text);
        font-size: 11.5px;
        font-weight: 600;
        line-height: 1;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .gallery-chip:hover { background: var(--stor-accent-soft); color: var(--stor-accent-strong); }
    .gallery-chip:focus-visible, .gallery-month-check:focus-visible { outline: 2px solid var(--stor-focus); outline-offset: 2px; }
    .gallery-month-check {
        display: grid;
        width: 24px;
        height: 24px;
        flex: none;
        place-items: center;
        border-radius: 999px;
        box-shadow: inset 0 0 0 1.5px var(--stor-border);
        color: transparent;
    }
    .gallery-month-check[aria-pressed='true'] { background: var(--stor-accent); box-shadow: none; color: var(--stor-action-text, #fff); }
    .gallery-rows { display: flex; flex-direction: column; gap: var(--gallery-gap); }
    .gallery-row { display: flex; gap: var(--gallery-gap); }
    .gallery-placeholder { flex-basis: 0; border-radius: 8px; background: var(--stor-surface-muted); }
</style>
