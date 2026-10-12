<script lang="ts" module>
    /** A neighbouring photo; with `href` it is a real link, so it works without a script. */
    export interface ViewerStep {
        id: string;
        href?: string;
    }

    export interface ViewerFilmItem extends ViewerStep {
        ratio: number;
        label: string;
    }
</script>

<script lang="ts">
    import { tick, type Snippet } from 'svelte';
    import type { PhotoDetailRow } from '../../../gallery/format.js';
    import { gallerySwipeDirection } from '../../../gallery/interaction.js';
    import IconClose from '~icons/mdi/close';
    import IconChevronLeft from '~icons/mdi/chevron-left';
    import IconChevronRight from '~icons/mdi/chevron-right';
    import IconInformation from '~icons/mdi/information-outline';

    let {
        title,
        heading,
        subtitle = '',
        status = '',
        imageKey,
        imageUrl,
        backdropUrl = '',
        alt,
        caption = '',
        message = '',
        older = null,
        newer = null,
        film = [],
        currentId,
        thumb,
        details = [],
        detailsExtra,
        detailsOpen = $bindable(false),
        actions,
        closeHref,
        onClose,
        onNavigate,
        onKey,
    }: {
        title: string;
        /** The title element, when a dialog needs its own. */
        heading?: Snippet<[title: string]>;
        subtitle?: string;
        /** A state worth announcing, such as a pending upload. */
        status?: string;
        /** Changes with the photo, so the next one fades in. */
        imageKey: string;
        imageUrl: string;
        /** A small copy of the photo that lights the stage. */
        backdropUrl?: string;
        alt: string;
        caption?: string;
        /** Shown in place of the photo while it loads or when it fails. */
        message?: string;
        older?: ViewerStep | null;
        newer?: ViewerStep | null;
        film?: ViewerFilmItem[];
        currentId: string;
        thumb?: Snippet<[item: ViewerFilmItem]>;
        details?: PhotoDetailRow[];
        detailsExtra?: Snippet;
        detailsOpen?: boolean;
        /** Buttons beside Details. */
        actions?: Snippet;
        closeHref?: string;
        onClose: () => void;
        onNavigate: (id: string) => void;
        /** Keys the frame does not handle itself. */
        onKey?: (event: KeyboardEvent) => void;
    } = $props();

    const detailsId = $props.id();
    const hasDetails = $derived(details.length > 0 || Boolean(detailsExtra));
    let strip = $state<HTMLElement>();
    let touchStart: { x: number; y: number } | null = null;

    $effect(() => {
        void film;
        void currentId;
        void tick().then(() => strip?.querySelector('[aria-current="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }));
    });

    function step(event: MouseEvent, target: ViewerStep) {
        event.preventDefault();
        onNavigate(target.id);
    }

    function close(event: MouseEvent) {
        event.preventDefault();
        onClose();
    }

    function handleKey(event: KeyboardEvent) {
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
        if ((event.target as HTMLElement | null)?.closest('input, textarea, select, [role="menu"]')) return;
        if (event.key === 'ArrowLeft' && older) { event.preventDefault(); onNavigate(older.id); }
        else if (event.key === 'ArrowRight' && newer) { event.preventDefault(); onNavigate(newer.id); }
        else if (event.key === 'i' && hasDetails) detailsOpen = !detailsOpen;
        else onKey?.(event);
    }

    function beginSwipe(event: TouchEvent) {
        const touch = event.touches[0];
        touchStart = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null;
    }

    function endSwipe(event: TouchEvent) {
        const touch = event.changedTouches[0];
        if (!touchStart || !touch) return;
        const direction = gallerySwipeDirection(touchStart.x, touchStart.y, touch.clientX, touch.clientY);
        touchStart = null;
        // Swiping left moves on in time, like turning a page.
        if (direction > 0 && newer) onNavigate(newer.id);
        if (direction < 0 && older) onNavigate(older.id);
    }
</script>

<svelte:window onkeydown={handleKey} />

<div class="viewer">
    {#if backdropUrl}<img class="viewer-backdrop" src={backdropUrl} alt="" aria-hidden="true" />{/if}
    <header class="viewer-bar">
        {#if closeHref}
            <a class="viewer-button" href={closeHref} aria-label="Close photo" onclick={close}><IconClose /></a>
        {:else}
            <button type="button" class="viewer-button" aria-label="Close photo" onclick={close}><IconClose /></button>
        {/if}
        <div class="viewer-heading">
            {#if heading}{@render heading(title)}{:else}<h2 class="viewer-title">{title}</h2>{/if}
            {#if subtitle || status}
                <p class="viewer-subtitle">
                    {#if subtitle}<span>{subtitle}</span>{/if}
                    {#if status}<span role="status">{subtitle ? ' · ' : ''}{status}</span>{/if}
                </p>
            {/if}
        </div>
        {@render actions?.()}
        {#if hasDetails}
            <button type="button" class="viewer-button" aria-label="Details" aria-expanded={detailsOpen} aria-controls={detailsId} onclick={() => detailsOpen = !detailsOpen}><IconInformation /></button>
        {/if}
    </header>

    <div class="viewer-body">
        <div data-gallery-stage class="viewer-stage" role="group" aria-label="Photo" ontouchstart={beginSwipe} ontouchend={endSwipe}>
            <div class="viewer-frame">
                {#if imageUrl}
                    {#key imageKey}<img src={imageUrl} {alt} class="viewer-image" />{/key}
                {:else}
                    <p class="viewer-message" role="status">{message || 'Loading photo…'}</p>
                {/if}
            </div>
            {#if caption}<p class="viewer-caption">{caption}</p>{/if}
            {#if older}
                <svelte:element this={older.href ? 'a' : 'button'} type={older.href ? undefined : 'button'} href={older.href} rel={older.href ? 'prev' : undefined} class="viewer-button viewer-step previous" aria-label="Older photo" onclick={(event: MouseEvent) => step(event, older!)} role={older.href ? undefined : 'button'} tabindex="0"><IconChevronLeft /></svelte:element>
            {/if}
            {#if newer}
                <svelte:element this={newer.href ? 'a' : 'button'} type={newer.href ? undefined : 'button'} href={newer.href} rel={newer.href ? 'next' : undefined} class="viewer-button viewer-step next" aria-label="Newer photo" onclick={(event: MouseEvent) => step(event, newer!)} role={newer.href ? undefined : 'button'} tabindex="0"><IconChevronRight /></svelte:element>
            {/if}
        </div>

        {#if hasDetails}
            <aside id={detailsId} class="viewer-details" aria-label="Photo details" hidden={!detailsOpen}>
                {#if details.length}
                    <dl>
                        {#each details as row (row.label)}
                            <dt>{row.label}</dt>
                            <dd>{#if row.href}<a href={row.href} target="_blank" rel="noopener noreferrer">{row.value}</a>{:else}{row.value}{/if}</dd>
                        {/each}
                    </dl>
                {/if}
                {@render detailsExtra?.()}
            </aside>
        {/if}
    </div>

    {#if film.length > 1}
        <nav bind:this={strip} class="viewer-strip" aria-label="Nearby photos">
            {#each film as item (item.id)}
                <svelte:element
                    this={item.href ? 'a' : 'button'}
                    type={item.href ? undefined : 'button'}
                    href={item.href}
                    class="viewer-thumb"
                    style:aspect-ratio={Math.min(1.6, Math.max(0.62, item.ratio))}
                    aria-label={`Show ${item.label}`}
                    aria-current={item.id === currentId ? 'true' : undefined}
                    role={item.href ? undefined : 'button'}
                    tabindex="0"
                    onclick={(event: MouseEvent) => { event.preventDefault(); if (item.id !== currentId) onNavigate(item.id); }}
                >{@render thumb?.(item)}</svelte:element>
            {/each}
        </nav>
    {/if}
</div>

<style>
    /* Photos read best on a dark stage, so the viewer stays dark in either theme. */
    .viewer {
        --viewer-ink: #eef2f6;
        --viewer-muted: rgb(238 242 246 / 0.62);
        --viewer-line: rgb(255 255 255 / 0.1);
        position: relative;
        display: flex;
        width: 100%;
        height: 100%;
        flex-direction: column;
        overflow: hidden;
        background: #0a0c10;
        color: var(--viewer-ink);
        color-scheme: dark;
        font-family: var(--stor-font-sans, ui-sans-serif, system-ui, sans-serif);
    }
    .viewer-backdrop {
        position: absolute;
        inset: -12%;
        width: 124%;
        height: 124%;
        object-fit: cover;
        filter: blur(64px) saturate(1.5) brightness(0.6);
        opacity: 0.9;
        pointer-events: none;
    }
    .viewer::after {
        content: '';
        position: absolute;
        inset: 0;
        pointer-events: none;
        background:
            radial-gradient(120% 90% at 50% 45%, transparent 40%, rgb(5 6 9 / 0.55)),
            linear-gradient(rgb(5 6 9 / 0.45), transparent 18%, transparent 78%, rgb(5 6 9 / 0.6));
    }
    .viewer-bar, .viewer-strip { position: relative; z-index: 1; }
    .viewer-bar { display: flex; min-height: 3.5rem; align-items: center; gap: 2px; padding: calc(env(safe-area-inset-top) + 6px) 8px 4px; }
    .viewer-heading { min-width: 0; flex: 1; padding: 0 6px; }
    .viewer-heading :global(.viewer-title), .viewer-title {
        margin: 0;
        overflow: hidden;
        font-family: var(--stor-font-serif, ui-serif, Georgia, serif);
        font-size: 16px;
        font-weight: 600;
        line-height: 1.2;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .viewer-subtitle { margin: 0; overflow: hidden; color: var(--viewer-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    .viewer-bar :global(.viewer-button) {
        display: grid;
        width: 44px;
        height: 44px;
        flex: none;
        place-items: center;
        border: 0;
        border-radius: 12px;
        background: transparent;
        color: rgb(238 242 246 / 0.86);
        transition: background-color 160ms ease, color 160ms ease;
    }
    .viewer :global(.viewer-button svg) { width: 20px; height: 20px; }
    .viewer :global(.viewer-button:hover) { background: rgb(255 255 255 / 0.1); color: #fff; }
    .viewer :global(.viewer-button:focus-visible) { outline: 2px solid #fff; outline-offset: 1px; }
    .viewer-body { position: relative; z-index: 1; display: flex; min-height: 0; flex: 1; }
    .viewer-stage { position: relative; display: flex; min-width: 0; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 8px 12px; }
    .viewer-frame { display: flex; min-height: 0; width: 100%; flex: 1; align-items: center; justify-content: center; }
    .viewer-image { max-width: 100%; max-height: 100%; border-radius: 3px; object-fit: contain; box-shadow: 0 30px 80px -20px rgb(0 0 0 / 0.65); animation: viewer-in 260ms ease-out; }
    @keyframes viewer-in { from { opacity: 0.4; } }
    .viewer-message { margin: 0; color: var(--viewer-muted); font-size: 14px; }
    .viewer-caption { max-width: 42rem; margin: 0; color: var(--viewer-ink); font-family: var(--stor-font-serif, ui-serif, Georgia, serif); font-size: 16px; font-style: italic; font-weight: 500; text-align: center; }
    .viewer-step {
        position: absolute;
        top: 50%;
        display: grid;
        width: 44px;
        height: 44px;
        margin-top: -22px;
        place-items: center;
        border: 0;
        border-radius: 999px;
        background: rgb(255 255 255 / 0.08);
        color: rgb(238 242 246 / 0.86);
        -webkit-backdrop-filter: blur(10px);
        backdrop-filter: blur(10px);
        cursor: pointer;
    }
    .viewer-step :global(svg) { width: 24px; height: 24px; }
    .viewer-step:hover { background: rgb(255 255 255 / 0.16); color: #fff; }
    .viewer-step:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
    .viewer-step.previous { left: 8px; }
    .viewer-step.next { right: 8px; }
    .viewer-details {
        position: absolute;
        inset: auto 8px 8px;
        z-index: 3;
        display: grid;
        max-height: 62%;
        gap: 14px;
        overflow-y: auto;
        border-radius: 22px;
        background: rgb(20 22 28 / 0.78);
        padding: 20px;
        box-shadow: inset 0 0 0 1px var(--viewer-line), 0 20px 50px rgb(0 0 0 / 0.4);
        -webkit-backdrop-filter: blur(28px) saturate(1.3);
        backdrop-filter: blur(28px) saturate(1.3);
    }
    .viewer-details[hidden] { display: none; }
    dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 9px 14px; margin: 0; }
    dt { color: rgb(238 242 246 / 0.48); font-size: 10.5px; font-weight: 600; letter-spacing: 0.07em; line-height: 1.7; text-transform: uppercase; }
    dd { margin: 0; min-width: 0; overflow-wrap: anywhere; color: rgb(238 242 246 / 0.92); font-size: 13px; line-height: 1.5; }
    dd a { color: inherit; text-decoration: underline; text-decoration-color: rgb(255 255 255 / 0.3); text-underline-offset: 3px; }
    dd a:focus-visible, .viewer-thumb:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    .viewer-strip {
        display: flex;
        height: 72px;
        align-items: center;
        gap: 4px;
        overflow-x: auto;
        padding: 8px 50% calc(env(safe-area-inset-bottom) + 12px);
        scrollbar-width: none;
        -webkit-mask: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent);
        mask: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent);
    }
    .viewer-strip::-webkit-scrollbar { display: none; }
    .viewer-thumb {
        display: block;
        height: 40px;
        flex: none;
        overflow: hidden;
        border: 0;
        border-radius: 5px;
        padding: 0;
        background: rgb(255 255 255 / 0.06);
        opacity: 0.5;
        cursor: pointer;
        transition: opacity 200ms ease, height 250ms ease, box-shadow 200ms ease;
    }
    .viewer-thumb:hover { opacity: 0.85; }
    .viewer-thumb[aria-current='true'] { height: 50px; opacity: 1; box-shadow: 0 0 0 2px #fff; }
    .viewer-thumb :global(img) { display: block; width: 100%; height: 100%; object-fit: cover; }
    @media (min-width: 640px) {
        .viewer-bar { padding: 12px 14px 6px; }
        .viewer-stage { padding: 8px 72px; }
        .viewer-step.previous { left: 16px; }
        .viewer-step.next { right: 16px; }
        .viewer-strip { height: 80px; }
        .viewer-thumb { height: 44px; }
        .viewer-thumb[aria-current='true'] { height: 56px; }
    }
    @media (min-width: 1024px) {
        .viewer-details { position: relative; inset: auto; width: 300px; max-height: none; flex: none; align-self: flex-start; margin: 6px 16px 6px 0; }
    }
    @media (prefers-reduced-motion: reduce) {
        .viewer-image { animation: none; }
        .viewer-thumb { transition: none; }
    }
</style>
