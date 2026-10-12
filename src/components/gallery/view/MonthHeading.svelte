<script lang="ts">
    import type { Snippet } from 'svelte';
    import { formatMonthParts, formatPhotoCount } from '../../../gallery/format.js';

    let { month, count, before, after }: {
        /** A `yyyy-MM` month. */
        month: string;
        count: number;
        /** Controls ahead of the name, such as a select-all check. */
        before?: Snippet;
        /** Controls after the name, such as album chips. */
        after?: Snippet;
    } = $props();

    const parts = $derived(formatMonthParts(month));
</script>

<header class="gallery-month-header" data-gallery-month={month}>
    {@render before?.()}
    <h2 class="gallery-month-title">{parts.name} <span>{parts.year}</span></h2>
    {@render after?.()}
    <span class="gallery-month-count">{formatPhotoCount(count)}</span>
</header>

<style>
    .gallery-month-header {
        position: sticky;
        top: 0;
        z-index: 2;
        display: flex;
        min-height: var(--gallery-header, 52px);
        align-items: center;
        gap: 10px;
        margin-inline: calc(var(--gallery-inset-start, 0px) * -1) calc(var(--gallery-inset-end, 0px) * -1);
        padding-inline: var(--gallery-inset-start, 0px) var(--gallery-inset-end, 0px);
        background: var(--stor-surface);
    }
    .gallery-month-title {
        margin: 0;
        color: var(--stor-ink);
        font-family: var(--stor-font-serif, ui-serif, Georgia, serif);
        font-size: 20px;
        font-weight: 600;
        letter-spacing: -0.012em;
        line-height: 1.1;
        white-space: nowrap;
    }
    .gallery-month-title span { font-weight: 400; color: var(--stor-muted-text); }
    .gallery-month-count { margin-left: auto; color: var(--stor-muted-text); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
    @media (min-width: 640px) {
        .gallery-month-title { font-size: 23px; }
    }
</style>
