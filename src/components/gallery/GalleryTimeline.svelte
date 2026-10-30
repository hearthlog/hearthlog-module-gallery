<script lang="ts" module>
    import type { GalleryFilter, GallerySummary } from '../../data/gallery.js';

    /** A summary with the filter it was read under; the timeline lists exactly these blocks. */
    export interface GalleryTimelineSource {
        filter: GalleryFilter;
        summary: GallerySummary;
    }

    /** Where a timeline opens: the top of the list (newest), its bottom (oldest), or a `yyyy-MM` month. */
    export type GalleryOpening = 'end' | 'start' | string;
</script>

<script lang="ts">
    import { untrack } from 'svelte';
    import { EndlessList, type EndlessBlock, type EndlessPosition, type EndlessTarget } from '@hearthlog/sdk/endless';
    import { listAxis, nearestKey } from '@hearthlog/sdk/axis';
    import { queryDatabase } from '@hearthlog/sdk/data';
    import type { GalleryBlockSummary } from '../../data/gallery.js';
    import type { GalleryPhoto } from '@hearthlog/sdk/data';
    import {
        compareGalleryBlockKeys, estimateGalleryBlock, galleryBlockKey, galleryBlockMonth, galleryBlockPart, galleryGeometry, type GalleryDensity,
    } from '../../gallery/timeline.js';
    import { GalleryBlocks } from './gallery-blocks.svelte.js';
    import { formatMonthParts, formatPhotoCount } from '../../gallery/format.js';
    import GalleryMonthBlock from './GalleryMonthBlock.svelte';
    import GallerySpine from './view/GallerySpine.svelte';

    let {
        source,
        tenantId,
        logId,
        revision,
        density,
        opening = 'start',
        chips = true,
        showLatest = true,
        beginning = '',
        selecting = false,
        selectedIds,
        onOpen,
        onSelect,
        onSelectMonth,
        onOpenAlbum,
        onMonthChange,
    }: {
        source: GalleryTimelineSource;
        tenantId: string;
        logId: string;
        /** Changes after a save or a sync; the blocks on screen then read again. */
        revision: number;
        density: GalleryDensity;
        /** Read when the timeline opens and when its filter changes. */
        opening?: GalleryOpening;
        /** Month headers name the albums they hold. */
        chips?: boolean;
        /** A Latest button returns to the newest photo. */
        showLatest?: boolean;
        beginning?: string;
        selecting?: boolean;
        selectedIds: Set<string>;
        onOpen: (id: string) => void;
        onSelect: (id: string) => void;
        onSelectMonth: (month: string, select: boolean) => void;
        onOpenAlbum?: (id: string) => void;
        /** The month at the top of the list, as the list scrolls. */
        onMonthChange?: (month: string) => void;
    } = $props();

    const blocks = $derived(source.summary.blocks);
    const keys = $derived(blocks.map((block) => block.key));
    const axis = $derived(listAxis(keys, { descending: true, compare: compareGalleryBlockKeys }));
    const shapes = $derived(new Map(blocks.map((block) => [block.key, block])));
    const topKey = $derived(keys[0] ?? '');
    const lastKey = $derived(keys[keys.length - 1] ?? '');

    let root = $state<HTMLDivElement>();
    let width = $state(0);
    // Rows follow the width a frame later, so relaying them never feeds back into the same resize.
    $effect(() => {
        if (!root) return;
        let frame = 0;
        const observer = new ResizeObserver(([entry]) => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => width = Math.round(entry.contentRect.width));
        });
        observer.observe(root);
        return () => {
            observer.disconnect();
            cancelAnimationFrame(frame);
        };
    });
    const inset = $derived(width >= 640 ? { start: 24, end: 88 } : { start: 10, end: 24 });
    const geometry = $derived(galleryGeometry(Math.max(0, width - inset.start - inset.end), density));
    const estimate = $derived((key: string) => estimateGalleryBlock(shapes.get(key), geometry));

    let list = $state<ReturnType<typeof EndlessList>>();
    let position = $state<EndlessPosition | null>(null);

    /**
     * The list keeps its keys while it is open, so it opens again when they
     * change: at the filter's opening place for a new filter, or where it was
     * when a month appears or leaves in the middle. Keys are newest first, so
     * a month added or removed at the top keeps it open. Blocks are read again
     * only for a new filter.
     */
    const tracked = { keys: [] as string[], filter: '', filterEpoch: 0, listEpoch: 0, opening: { key: '' } as EndlessTarget };
    const epochs = $derived.by(() => {
        const filter = JSON.stringify(source.filter);
        const previous = tracked.keys;
        const common = Math.min(previous.length, keys.length);
        let kept = true;
        for (let index = 1; index <= common; index++) {
            if (previous[previous.length - index] !== keys[keys.length - index]) { kept = false; break; }
        }
        if (filter !== tracked.filter || !kept || previous.length === 0) {
            const was = untrack(() => position);
            if (filter !== tracked.filter || !was) {
                tracked.filterEpoch += filter !== tracked.filter ? 1 : 0;
                const wanted = untrack(() => opening);
                tracked.opening = wanted === 'start' ? { key: keys[0] ?? '' }
                    : wanted === 'end' ? { key: keys[keys.length - 1] ?? '' }
                    : { key: nearestKey(axis, galleryBlockKey(wanted)) };
            } else {
                tracked.opening = was.at === previous[previous.length - 1] ? { key: keys[keys.length - 1] ?? '' } : { key: nearestKey(axis, was.key) };
            }
            tracked.listEpoch += 1;
        }
        tracked.keys = keys;
        tracked.filter = filter;
        return { filter: tracked.filterEpoch, list: tracked.listEpoch };
    });
    const store = $derived.by(() => {
        void epochs.filter;
        return untrack(() => new GalleryBlocks(source.filter, chips));
    });

    const home = $derived(showLatest && !selecting && topKey ? { key: topKey, at: topKey, label: 'Latest' } : undefined);

    /** The block at the top edge names the month; the last block on screen closes the spine's band. */
    function pick(onScreen: EndlessBlock[]): EndlessPosition {
        return { key: onScreen[0].key, at: onScreen[onScreen.length - 1].key };
    }

    function follow(next: EndlessPosition): void {
        position = next;
        onMonthChange?.(galleryBlockMonth(next.key));
    }

    /** A big month's later blocks have no header of their own; this one stands in while they pass. */
    const continued = $derived(position && galleryBlockPart(position.key) > 0 ? shapes.get(position.key) : undefined);

    function monthSelected(block: GalleryBlockSummary): boolean {
        if (!selecting || selectedIds.size === 0) return false;
        for (let part = 0; part < block.parts; part++) {
            const data = store.get(galleryBlockKey(block.month, part));
            if (!data || !data.photos.every((photo) => selectedIds.has(photo.id))) return false;
        }
        return true;
    }

    // Phones show the spine while the list moves.
    let scrolling = $state(false);
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    function moved(): void {
        scrolling = true;
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => scrolling = false, 1400);
    }
    $effect(() => () => clearTimeout(scrollTimer));

    export function scrollToMonth(month: string): void {
        if (keys.length) list?.scrollTo({ key: nearestKey(axis, galleryBlockKey(month)) });
    }

    export function scrollToLatest(): void {
        if (topKey) list?.scrollTo({ key: topKey, at: topKey });
    }

    /** Brings a photo's tile into view, loading its block when it is far away, and focuses it. */
    export async function revealPhoto(photo: GalleryPhoto): Promise<void> {
        const selector = `[data-photo-id="${CSS.escape(photo.id)}"]`;
        const scroller = root?.querySelector<HTMLElement>('[data-gallery-scroll]');
        const tile = root?.querySelector<HTMLElement>(selector);
        if (tile && scroller) {
            const box = scroller.getBoundingClientRect();
            const rect = tile.getBoundingClientRect();
            if (rect.top >= box.top + geometry.header && rect.bottom <= box.bottom) {
                tile.focus({ preventScroll: true });
                return;
            }
        }
        const key = await queryDatabase((repositories) => repositories.gallery.photoBlock(photo, source.filter));
        list?.scrollTo({ key, at: key, find: (block) => block.querySelector<HTMLElement>(selector), ratio: 0.35 });
        let frames = 90;
        const focus = () => {
            const shown = root?.querySelector<HTMLElement>(selector);
            if (shown) shown.focus({ preventScroll: true });
            else if (--frames > 0) requestAnimationFrame(focus);
        };
        requestAnimationFrame(focus);
    }
</script>

<div
    bind:this={root}
    class="gallery-timeline"
    style:--gallery-inset-start={`${inset.start}px`}
    style:--gallery-inset-end={`${inset.end}px`}
    onscrollcapture={moved}
>
    {#if keys.length && width > 0}
        {#key epochs.list}
            <EndlessList
                bind:this={list}
                {axis}
                {store}
                opening={tracked.opening}
                {estimate}
                {revision}
                {home}
                {pick}
                onVisibleChange={follow}
                class="gallery-scroller"
                data-gallery-scroll
                aria-label="Photos by month"
            >
                {#snippet item(key, data)}
                    {@const block = shapes.get(key)}
                    {#if block}
                        <GalleryMonthBlock
                            {block}
                            {data}
                            {geometry}
                            {tenantId}
                            {logId}
                            beginning={key === keys[0] ? beginning : ''}
                            last={key === lastKey}
                            {selecting}
                            {selectedIds}
                            monthSelected={block.part === 0 && monthSelected(block)}
                            {onOpen}
                            {onSelect}
                            {onSelectMonth}
                            onOpenAlbum={chips ? onOpenAlbum : undefined}
                        />
                    {/if}
                {/snippet}
            </EndlessList>
        {/key}
        {#if continued}
            {@const month = formatMonthParts(continued.month)}
            <div class="gallery-continued" aria-hidden="true">
                <span class="gallery-continued-title stor-serif-title">{month.name} <span>{month.year}</span></span>
                <span class="gallery-continued-count">{formatPhotoCount(continued.month_photos)}</span>
            </div>
        {/if}
        <GallerySpine
            months={source.summary.months}
            first={position ? galleryBlockMonth(position.key) : ''}
            last={position ? galleryBlockMonth(position.at) : ''}
            active={scrolling}
            onJump={scrollToMonth}
            onLatest={scrollToLatest}
        />
    {/if}
</div>

<style>
    .gallery-timeline { position: relative; height: 100%; min-height: 0; }
    .gallery-timeline :global(.gallery-scroller) { scrollbar-width: none; }
    .gallery-timeline :global(.gallery-scroller::-webkit-scrollbar) { display: none; }
    .gallery-continued {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        z-index: 2;
        display: flex;
        min-height: 52px;
        align-items: center;
        gap: 10px;
        padding-inline: var(--gallery-inset-start) var(--gallery-inset-end);
        background: var(--stor-bg);
        pointer-events: none;
    }
    .gallery-continued-title { font-size: 20px; line-height: 1.1; color: var(--stor-ink); }
    .gallery-continued-title span { font-weight: 400; color: var(--stor-muted-text); }
    .gallery-continued-count { margin-left: auto; color: var(--stor-muted-text); font-size: 12px; font-variant-numeric: tabular-nums; }
    @media (min-width: 640px) {
        .gallery-continued { min-height: 60px; }
        .gallery-continued-title { font-size: 23px; }
    }
</style>
