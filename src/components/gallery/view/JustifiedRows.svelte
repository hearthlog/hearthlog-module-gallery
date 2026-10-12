<script lang="ts" generics="T extends { width: number; height: number }">
    import type { Snippet } from 'svelte';
    import { justifiedRows, tileRatio } from '../../../gallery/layout.js';

    let {
        items,
        key,
        width = 0,
        rowHeight,
        gap,
        tile,
    }: {
        items: readonly T[];
        key: (item: T) => string;
        /**
         * The width rows fill. Until it is known (on the server, or before the
         * first measure) rows flow in CSS, each photo growing by its ratio.
         */
        width?: number;
        rowHeight: number;
        gap: number;
        /** Draws one photo at its size in the row; `null` while CSS sizes it. */
        tile: Snippet<[item: T, size: { width: number; height: number } | null, index: number]>;
    } = $props();

    const rows = $derived(width > 0 ? justifiedRows(items.map(tileRatio), width, rowHeight, gap) : null);
</script>

{#if rows}
    <div class="rows" style:--gap={`${gap}px`}>
        {#each rows as row (row.start)}
            <div class="row" style:height={`${row.height}px`}>
                {#each items.slice(row.start, row.end) as item, offset (key(item))}
                    {@render tile(item, { width: tileRatio(item) * row.height, height: row.height }, row.start + offset)}
                {/each}
            </div>
        {/each}
    </div>
{:else}
    <div class="flow" style:--gap={`${gap}px`} style:--row={`${rowHeight}px`}>
        {#each items as item, index (key(item))}
            <div class="cell" style:--r={tileRatio(item)}>{@render tile(item, null, index)}</div>
        {/each}
    </div>
{/if}

<style>
    .rows { display: flex; flex-direction: column; gap: var(--gap); }
    .row { display: flex; gap: var(--gap); }
    .flow { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--gap); }
    /* The last row keeps the target height instead of stretching. */
    .flow::after { content: ''; flex: 1000 1 0%; }
    .cell { display: flex; min-width: 0; flex: var(--r) 1 calc(var(--r) * var(--row)); aspect-ratio: var(--r); }
</style>
