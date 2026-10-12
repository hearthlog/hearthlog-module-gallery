<script lang="ts">
    import { onMount, type Snippet } from 'svelte';
    import type { HTMLAttributes } from 'svelte/elements';
    import IconCheck from '~icons/mdi/check';

    let {
        src,
        alt,
        label,
        size,
        href,
        day = '',
        checkable = false,
        selectable = false,
        selected = false,
        element = $bindable(),
        onOpen,
        onSelect,
        overlay,
        ...attributes
    }: Omit<HTMLAttributes<HTMLElement>, 'children'> & {
        /** The image to show; empty while it loads. */
        src: string;
        alt: string;
        /** What opening the tile does, for assistive technology. */
        label: string;
        /** The tile's size in its row; `null` fills the cell CSS gives it. */
        size: { width: number; height: number } | null;
        /** A real link, so the tile opens without a script. */
        href?: string;
        /** Shown on hover. */
        day?: string;
        /** A check in the corner selects the photo. */
        checkable?: boolean;
        selectable?: boolean;
        selected?: boolean;
        element?: HTMLElement;
        onOpen?: (event: MouseEvent) => void;
        onSelect?: () => void;
        /** Markers over the photo, such as upload state. */
        overlay?: Snippet;
    } = $props();

    let shown = $state('');
    // Server-rendered photos show at once; once scripts run, a photo still loading fades in.
    let mounted = $state(false);
    onMount(() => { mounted = true; });

    /**
     * Marks the photo shown once it loads, including one that loaded before the
     * page came alive. A listener rather than an `onload` attribute keeps
     * server-rendered markup free of inline handlers, which the public CSP blocks.
     */
    function trackLoad(node: HTMLImageElement) {
        const loaded = () => { shown = node.getAttribute('src') ?? ''; };
        if (node.complete && node.naturalWidth > 0) loaded();
        node.addEventListener('load', loaded);
        return () => node.removeEventListener('load', loaded);
    }

    function activate(event: MouseEvent) {
        if (checkable && !selectable && (event.target as Element).closest('[data-gallery-check]')) {
            event.preventDefault();
            onSelect?.();
        } else onOpen?.(event);
    }
</script>

<svelte:element
    this={href ? 'a' : 'button'}
    bind:this={element}
    {...attributes}
    type={href ? undefined : 'button'}
    {href}
    class="gallery-tile"
    class:fill={!size}
    class:selectable
    class:selected
    style:width={size ? `${size.width}px` : undefined}
    style:height={size ? `${size.height}px` : undefined}
    aria-label={label}
    aria-pressed={selectable ? selected : undefined}
    onclick={activate}
>
    {#if src}<img {src} {alt} class:waiting={mounted && shown !== src} draggable="false" {@attach trackLoad} />{/if}
    {#if checkable}<span class="gallery-check" data-gallery-check aria-hidden="true"><IconCheck /></span>{/if}
    {#if day}<span class="gallery-day" aria-hidden="true">{day}</span>{/if}
    {@render overlay?.()}
</svelte:element>

<style>
    .gallery-tile {
        position: relative;
        flex: none;
        display: block;
        overflow: hidden;
        border: 0;
        border-radius: 8px;
        padding: 0;
        background: var(--stor-surface-muted);
        color: inherit;
        text-align: left;
        transition: background-color 180ms ease;
    }
    .gallery-tile.fill { width: 100%; height: 100%; }
    .gallery-tile:focus-visible { outline: 2px solid var(--stor-focus); outline-offset: 2px; }
    img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        transition: opacity 400ms ease, transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1), border-radius 220ms ease;
    }
    img.waiting { opacity: 0; }
    .selected { background: var(--stor-accent-soft); }
    .selected img { transform: scale(0.86); border-radius: 6px; }
    .gallery-check {
        position: absolute;
        top: 7px;
        left: 7px;
        z-index: 1;
        display: grid;
        width: 22px;
        height: 22px;
        place-items: center;
        border-radius: 999px;
        background: rgb(0 0 0 / 0.18);
        box-shadow: inset 0 0 0 1.5px rgb(255 255 255 / 0.95), 0 1px 4px rgb(0 0 0 / 0.25);
        color: transparent;
        opacity: 0;
        transition: opacity 150ms ease, background-color 150ms ease;
    }
    .gallery-check :global(svg) { width: 14px; height: 14px; }
    .selectable .gallery-check, .gallery-tile:focus-visible .gallery-check { opacity: 1; }
    .selected .gallery-check { background: var(--stor-accent); box-shadow: 0 0 0 2px var(--stor-surface); color: var(--stor-action-text, #fff); }
    .gallery-day {
        position: absolute;
        inset: auto 0 0;
        padding: 18px 9px 7px;
        background: linear-gradient(transparent, rgb(0 0 0 / 0.42));
        color: #fff;
        font-size: 11px;
        font-weight: 600;
        line-height: 1;
        opacity: 0;
        pointer-events: none;
        transition: opacity 180ms ease;
    }
    @media (hover: hover) {
        .gallery-tile:hover .gallery-check, .gallery-tile:hover .gallery-day { opacity: 1; }
        .gallery-tile:not(.selected):hover img { transform: scale(1.015); }
    }
    @media (prefers-reduced-motion: reduce) {
        img, .gallery-check, .gallery-day { transition: none; }
    }
</style>
