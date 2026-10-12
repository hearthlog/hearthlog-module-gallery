<script lang="ts">
    import { onMount, tick, untrack } from 'svelte';
    import GalleryTile from '../../src/components/gallery/view/GalleryTile.svelte';
    import JustifiedRows from '../../src/components/gallery/view/JustifiedRows.svelte';
    import MonthHeading from '../../src/components/gallery/view/MonthHeading.svelte';
    import GallerySpine from '../../src/components/gallery/view/GallerySpine.svelte';
    import ViewerFrame, { type ViewerFilmItem } from '../../src/components/gallery/view/ViewerFrame.svelte';
    import { formatPhotoCount, formatPhotoDate, formatTileDay, photoDetailRows } from '../../src/gallery/format.js';
    import { tileRatio } from '../../src/gallery/layout.js';
    import { galleryGeometry } from '../../src/gallery/timeline.js';
    import { publicDetailSource } from '../../src/gallery/public-details.js';
    import {
        PAGE_SIZE, assetPath, galleryPath, openedAsset, pagePath, photoPath,
        type PublicGalleryData, type PublicPageResponse, type PublicPhoto,
    } from './types.js';

    let { data }: { data: PublicGalleryData } = $props();

    // One page load shows one revision; a newer one reloads the page.
    const gallery = untrack(() => data);
    const id = gallery.publicationId;
    const revision = gallery.revision;
    const months = gallery.months;
    const lastPage = Math.ceil(gallery.photoCount / PAGE_SIZE) - 1;
    const monthPhotos = new Map((months ?? []).map((month) => [month.month, month.photos]));
    const spineMonths = months ? months.map((month) => ({ month: month.month, photos: month.photos, peak: Math.max(...months.map((each) => each.photos)) })) : [];

    let photos = $state.raw<PublicPhoto[]>(gallery.photos);
    let firstPage = $state(gallery.firstPage);
    let open = $state<number | null>(gallery.open);
    let width = $state(0);
    let detailsOpen = $state(false);
    let scrolling = $state(false);
    let inView = $state({ first: '', last: '' });
    let more = $state<HTMLElement>();
    let loading = false;

    const loadedLastPage = $derived(firstPage + Math.ceil(photos.length / PAGE_SIZE) - 1);
    const showCover = $derived(firstPage === 0 && photos.length > 0);
    const geometry = $derived(galleryGeometry(width, 1));
    /** Consecutive photos of one month share a heading; undated galleries are one run. */
    const groups = $derived.by(() => {
        const listed = showCover ? photos.slice(1) : photos;
        if (!months) return listed.length ? [{ key: 'all', month: '', photos: listed }] : [];
        const runs: Array<{ key: string; month: string; photos: PublicPhoto[] }> = [];
        for (const photo of listed) {
            const month = photo.takenAt?.slice(0, 7) ?? '';
            const run = runs[runs.length - 1];
            if (run?.month === month) run.photos.push(photo);
            else runs.push({ key: `${month}:${photo.position}`, month, photos: [photo] });
        }
        return runs;
    });

    const photoAt = (position: number) => photos[position - firstPage * PAGE_SIZE] ?? null;
    const asset = (photo: PublicPhoto, variant: 'thumbnail' | 'display') => assetPath(id, revision, photo, variant);
    const pageOf = (position: number) => Math.floor(position / PAGE_SIZE);

    const current = $derived(open === null ? null : photoAt(open));
    const currentTitle = $derived(current ? (current.takenAt ? formatPhotoDate(publicDetailSource(current)) : current.caption || gallery.title) : '');
    const currentDetails = $derived(current ? photoDetailRows(publicDetailSource(current), { file: false }) : []);
    const film = $derived.by<ViewerFilmItem[]>(() => {
        if (!current) return [];
        const from = Math.max(0, current.position - firstPage * PAGE_SIZE - 8);
        return photos.slice(from, from + 17).map((photo) => ({
            id: String(photo.position), ratio: tileRatio(photo), label: `photo ${photo.position + 1}`, href: photoPath(id, photo),
        }));
    });
    const step = (position: number) => (position >= 0 && position < gallery.photoCount
        ? { id: String(position), href: photoAt(position) ? photoPath(id, photoAt(position)!) : undefined }
        : null);

    // ---------------------------------------------------------------- pages

    async function readPage(page: number): Promise<PublicPhoto[]> {
        const response = await fetch(pagePath(id, page), { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('Page unavailable');
        const value = await response.json() as PublicPageResponse;
        // The owner published a newer version; show it from the start.
        if (value.revision !== revision) { location.reload(); throw new Error('Revision changed'); }
        return value.photos;
    }

    async function loadNext(): Promise<void> {
        if (loading || loadedLastPage >= lastPage) return;
        loading = true;
        try { photos = [...photos, ...await readPage(loadedLastPage + 1)]; }
        catch { /* The link below still leads to the next page. */ }
        finally { loading = false; }
    }

    async function loadPrevious(): Promise<void> {
        if (loading || firstPage === 0) return;
        loading = true;
        try {
            const earlier = await readPage(firstPage - 1);
            const before = document.documentElement.scrollHeight;
            photos = [...earlier, ...photos];
            firstPage -= 1;
            await tick();
            // Keep what was on screen in place as the earlier photos arrive above it.
            window.scrollBy(0, document.documentElement.scrollHeight - before);
        } catch { /* The link above still leads to the earlier page. */ }
        finally { loading = false; }
    }

    /** Shows one page on its own, for a jump far from what is loaded. */
    async function showPage(page: number): Promise<void> {
        loading = true;
        try {
            photos = await readPage(page);
            firstPage = page;
            await tick();
        } finally { loading = false; }
    }

    /** Loads the page holding a photo next to what is already shown. */
    async function ensureLoaded(position: number): Promise<void> {
        const page = pageOf(position);
        if (page === firstPage - 1) await loadPrevious();
        else if (page === loadedLastPage + 1) await loadNext();
        else if (page < firstPage || page > loadedLastPage) await showPage(page);
    }

    // ---------------------------------------------------------------- the viewer

    let returnFocus: number | null = null;

    function openPhoto(event: MouseEvent, position: number): void {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        returnFocus = position;
        open = position;
        history.pushState({ publicGallery: 'photo' }, '', photoPath(id, photoAt(position)!));
    }

    async function navigate(target: string): Promise<void> {
        const position = Number(target);
        await ensureLoaded(position);
        const photo = photoAt(position);
        if (!photo) return;
        open = position;
        returnFocus = position;
        history.replaceState(history.state, '', photoPath(id, photo));
    }

    async function closeViewer(): Promise<void> {
        const position = open;
        open = null;
        if (history.state?.publicGallery === 'photo') history.back();
        else history.replaceState(null, '', galleryPath(id, firstPage));
        await tick();
        const tile = position === null ? null : document.getElementById(`photo-${position}`);
        if (tile) {
            const rect = tile.getBoundingClientRect();
            if (rect.top < 60 || rect.bottom > innerHeight) tile.scrollIntoView({ block: 'center' });
            tile.focus({ preventScroll: true });
        }
    }

    // ---------------------------------------------------------------- the spine

    async function jumpToMonth(month: string): Promise<void> {
        const target = months?.find((entry) => entry.month === month);
        if (!target) return;
        const page = pageOf(target.position);
        if (page < firstPage || page > loadedLastPage) await showPage(page);
        await tick();
        const group = document.querySelector<HTMLElement>(`[data-month="${month}"]`);
        if (group) window.scrollTo({ top: group.getBoundingClientRect().top + scrollY - 4 });
        else if (target.position === 0) window.scrollTo({ top: 0 });
    }

    async function jumpToLatest(): Promise<void> {
        if (loadedLastPage < lastPage) await showPage(lastPage);
        await tick();
        window.scrollTo({ top: document.documentElement.scrollHeight });
    }

    let frame = 0;
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    function followScroll(): void {
        scrolling = true;
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => scrolling = false, 1400);
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
            const shown = [...document.querySelectorAll<HTMLElement>('[data-month]')]
                .filter((group) => { const rect = group.getBoundingClientRect(); return rect.bottom > 60 && rect.top < innerHeight; })
                .map((group) => group.dataset.month ?? '');
            const top = scrollY < 40 && showCover && months ? months[0].month : shown[0];
            inView = { first: top ?? '', last: shown[shown.length - 1] ?? top ?? '' };
        });
    }

    onMount(() => {
        detailsOpen = matchMedia('(min-width: 1024px)').matches;
        followScroll();
        const popped = () => {
            const asset = openedAsset(location.pathname);
            if (asset === null) { open = null; return; }
            const shown = photos.find((photo) => photo.assetId === asset);
            // A photo outside the loaded pages comes from the server, which renders its address.
            if (shown) open = shown.position;
            else location.reload();
        };
        addEventListener('popstate', popped);
        const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) void loadNext(); }, { rootMargin: '1200px 0px' });
        if (more) observer.observe(more);
        return () => {
            removeEventListener('popstate', popped);
            observer.disconnect();
            cancelAnimationFrame(frame);
            clearTimeout(scrollTimer);
        };
    });

    // The page behind stays put while a photo is open.
    $effect(() => {
        if (open === null) return;
        const root = document.documentElement;
        const previous = root.style.overflow;
        root.style.overflow = 'hidden';
        return () => { root.style.overflow = previous; };
    });

    function keydown(event: KeyboardEvent): void {
        if (event.key === 'Escape' && open !== null) {
            event.preventDefault();
            void closeViewer();
        }
    }
</script>

<svelte:window onscroll={followScroll} onresize={followScroll} onkeydown={keydown} />

<div class="public" class:dated={Boolean(months)}>
    {#if firstPage === 0}
        <header class="public-head">
            <h1>{gallery.title}</h1>
            <div class="public-intro">
                {#if gallery.description}<p class="public-dek">{gallery.description}</p>{/if}
                <p class="public-meta">{formatPhotoCount(gallery.photoCount)}{' · '}Shared with a link</p>
            </div>
        </header>
        {#if showCover}
            {@const cover = photos[0]}
            <a
                id="photo-0"
                class="public-cover"
                href={photoPath(id, cover)}
                style:--r={tileRatio(cover)}
                aria-label={cover.caption || cover.alt}
                onclick={(event) => openPhoto(event, 0)}
            ><img src={asset(cover, 'display')} alt={cover.alt} /></a>
        {/if}
    {:else}
        <header class="public-head compact">
            <a class="public-title-link" href={galleryPath(id)}>{gallery.title}</a>
            <p class="public-meta">Photos {firstPage * PAGE_SIZE + 1}–{firstPage * PAGE_SIZE + photos.length} of {gallery.photoCount}</p>
            <a class="public-more-link" href={galleryPath(id, firstPage - 1)} onclick={(event) => { event.preventDefault(); void loadPrevious(); }}>Show earlier photos</a>
        </header>
    {/if}

    <div class="public-body" bind:clientWidth={width}>
        {#each groups as group (group.key)}
            <section class="public-group" data-month={group.month || undefined}>
                {#if group.month}<MonthHeading month={group.month} count={monthPhotos.get(group.month) ?? group.photos.length} />{/if}
                <JustifiedRows items={group.photos} key={(photo) => photo.assetId} width={width} rowHeight={geometry.rowHeight} gap={geometry.gap}>
                    {#snippet tile(photo, size)}
                        <GalleryTile
                            id={`photo-${photo.position}`}
                            href={photoPath(id, photo)}
                            src={asset(photo, 'thumbnail')}
                            alt={photo.alt}
                            label={photo.caption || photo.alt}
                            {size}
                            day={photo.takenAt ? formatTileDay(photo.takenAt) : ''}
                            onOpen={(event) => openPhoto(event, photo.position)}
                        />
                    {/snippet}
                </JustifiedRows>
            </section>
        {/each}
        <nav bind:this={more} class="public-pages" aria-label="More photos">
            {#if loadedLastPage < lastPage}
                <a class="public-more-link" href={galleryPath(id, loadedLastPage + 1)} onclick={(event) => { event.preventDefault(); void loadNext(); }}>More photos</a>
            {/if}
        </nav>
    </div>

    <footer class="public-foot"><span>Shared with a link</span><span>{formatPhotoCount(gallery.photoCount)}</span></footer>

    {#if months}
        <div class="public-spine">
            <GallerySpine months={spineMonths} first={inView.first} last={inView.last} active={scrolling} onJump={(month) => void jumpToMonth(month)} onLatest={() => void jumpToLatest()} />
        </div>
    {/if}
</div>

{#if current}
    <div class="public-viewer" role="dialog" aria-modal="true" aria-label={currentTitle}>
        <ViewerFrame
            title={currentTitle}
            subtitle={`${current.position + 1} of ${gallery.photoCount}`}
            imageKey={String(current.position)}
            imageUrl={asset(current, 'display')}
            backdropUrl={asset(current, 'thumbnail')}
            alt={current.alt}
            caption={current.takenAt ? current.caption : ''}
            older={step(current.position - 1)}
            newer={step(current.position + 1)}
            {film}
            currentId={String(current.position)}
            details={currentDetails}
            bind:detailsOpen
            closeHref={`${galleryPath(id, pageOf(current.position))}#photo-${current.position}`}
            onClose={() => void closeViewer()}
            onNavigate={(target) => void navigate(target)}
        >
            {#snippet thumb(item)}
                {@const shown = photoAt(Number(item.id))}
                {#if shown}<img src={asset(shown, 'thumbnail')} alt="" loading="lazy" />{/if}
            {/snippet}
        </ViewerFrame>
    </div>
{/if}

<style>
    :global(:root) {
        color-scheme: light dark;
        --stor-font-sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
        --stor-font-serif: ui-serif, 'New York', 'Iowan Old Style', Charter, 'Bitstream Charter', Georgia, serif;
        --stor-bg: #f4f4f1;
        --stor-surface: #f4f4f1;
        --stor-surface-muted: #e4e4df;
        --stor-surface-raised: #ffffff;
        --stor-ink: #1c1d1b;
        --stor-muted-text: #6b6d67;
        --stor-border: #d9d9d3;
        --stor-accent: #1c1d1b;
        --stor-accent-soft: #e4e4df;
        --stor-accent-strong: #1c1d1b;
        --stor-action-text: #ffffff;
        --stor-focus: #1c1d1b;
        --stor-shadow-sm: 0 1px 2px rgb(0 0 0 / 0.06);
        --stor-shadow-md: 0 2px 6px rgb(0 0 0 / 0.04), 0 12px 36px rgb(0 0 0 / 0.1);
    }
    @media (prefers-color-scheme: dark) {
        :global(:root) {
            --stor-bg: #121311;
            --stor-surface: #121311;
            --stor-surface-muted: #20211e;
            --stor-surface-raised: #2a2b28;
            --stor-ink: #ebe9e3;
            --stor-muted-text: #9b9992;
            --stor-border: #2b2c29;
            --stor-accent: #ebe9e3;
            --stor-accent-soft: #2b2c29;
            --stor-accent-strong: #ebe9e3;
            --stor-action-text: #121311;
            --stor-focus: #ebe9e3;
        }
    }
    :global(body) {
        margin: 0;
        background: var(--stor-bg);
        color: var(--stor-ink);
        font: 400 15px/1.5 var(--stor-font-sans);
        -webkit-font-smoothing: antialiased;
    }
    :global(*), :global(*::before), :global(*::after) { box-sizing: border-box; }
    .public { max-width: 1440px; margin: 0 auto; padding: clamp(22px, 4vw, 56px) clamp(16px, 4vw, 56px) 0; }
    .public.dated { padding-right: clamp(26px, 4vw, 56px); }
    .public-head {
        display: grid;
        grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
        gap: 16px 48px;
        align-items: end;
        margin-bottom: 36px;
        padding-bottom: 28px;
        border-bottom: 1px solid var(--stor-border);
    }
    h1 {
        margin: 0;
        font: 500 clamp(44px, 6.4vw, 96px) / 0.96 var(--stor-font-serif);
        letter-spacing: -0.035em;
        text-wrap: balance;
    }
    .public-dek { max-width: 40ch; margin: 0; color: var(--stor-muted-text); font: 400 19px/1.5 var(--stor-font-serif); }
    .public-meta { margin: 14px 0 0; color: var(--stor-muted-text); font-size: 11px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; }
    .public-head.compact { grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
    .public-head.compact .public-meta { margin: 0; }
    .public-title-link { color: inherit; font: 500 28px/1.1 var(--stor-font-serif); letter-spacing: -0.02em; text-decoration: none; }
    .public-head.compact .public-more-link { grid-column: 1 / -1; justify-self: start; }
    .public-cover {
        display: block;
        width: min(100%, calc(min(78vh, 860px) * var(--r)));
        aspect-ratio: var(--r);
        margin: 0 auto 48px;
        overflow: hidden;
        border-radius: 8px;
        background: var(--stor-surface-muted);
    }
    .public-cover img { display: block; width: 100%; height: 100%; object-fit: cover; }
    .public-cover:focus-visible { outline: 2px solid var(--stor-focus); outline-offset: 3px; }
    .public-body { display: grid; gap: 28px; }
    .public-group { display: grid; gap: 4px; --gallery-header: 60px; }
    .public-pages { display: flex; min-height: 44px; justify-content: center; }
    .public-more-link {
        display: inline-flex;
        min-height: 44px;
        align-items: center;
        border-radius: 999px;
        padding: 0 18px;
        background: var(--stor-surface-raised);
        box-shadow: inset 0 0 0 1px var(--stor-border);
        color: var(--stor-ink);
        font-size: 13px;
        font-weight: 600;
        text-decoration: none;
    }
    .public-more-link:focus-visible, .public-title-link:focus-visible { outline: 2px solid var(--stor-focus); outline-offset: 2px; }
    .public-foot {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        margin-top: 48px;
        padding: 18px 0 40px;
        border-top: 1px solid var(--stor-border);
        color: var(--stor-muted-text);
        font-size: 12px;
    }
    .public-spine { position: fixed; top: 0; right: 0; bottom: 0; z-index: 3; width: 22px; }
    .public-viewer { position: fixed; inset: 0; z-index: 10; }
    @media (min-width: 900px) {
        .public.dated { padding-right: 104px; }
        .public-spine { width: 72px; }
    }
    @media (max-width: 700px) {
        .public-head { grid-template-columns: 1fr; gap: 12px; margin-bottom: 24px; padding-bottom: 22px; }
        h1 { font-size: 46px; }
        .public-dek { font-size: 17px; }
        .public-cover { margin-bottom: 32px; }
        .public-body { gap: 20px; }
        .public-group { --gallery-header: 52px; }
    }
</style>
