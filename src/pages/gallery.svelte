<script lang="ts">
    import { onMount, tick } from 'svelte';
    import { page } from '$app/state';
    import { goto } from '$app/navigation';
    import { DropdownMenu, Tabs } from 'bits-ui';
    import { tabIndicator } from '@hearthlog/sdk/ui';
    import { PageHeader } from "@hearthlog/sdk/ui";
    import { PageDataStatus } from "@hearthlog/sdk/ui";
    import { MobilePageAction } from "@hearthlog/sdk/ui";
    import { EmptyState } from "@hearthlog/sdk/ui";
    import { CommandOnly } from "@hearthlog/sdk/ui";
    import { CommandModal } from "@hearthlog/sdk/ui";
    import { CommandConfirmDialog } from "@hearthlog/sdk/ui";
    import { Button } from "@hearthlog/sdk/ui";
    import { Select } from "@hearthlog/sdk/ui";
    import { Textarea } from "@hearthlog/sdk/ui";
    import { DataPlaceholder } from "@hearthlog/sdk/ui";
    import GalleryTimeline, { type GalleryOpening, type GalleryTimelineSource } from '../components/gallery/GalleryTimeline.svelte';
    import { formatMonthParts, formatPhotoCount } from '../gallery/format.js';
    import PhotoViewer from '../components/gallery/PhotoViewer.svelte';
    import AlbumSection from '../components/gallery/AlbumSection.svelte';
    import PublicationManager, { type PublicationSource } from '../components/gallery/PublicationManager.svelte';
    import { providePageResource } from '@hearthlog/sdk/runtime';
    import { refreshPageData } from '@hearthlog/sdk/runtime';
    import { runCommandAction } from '@hearthlog/sdk/runtime';
    import { queryDatabase } from '@hearthlog/sdk/data';
    import { requireActiveContext } from '@hearthlog/sdk/runtime';
    import { galleryPhotoCommands } from '@hearthlog/sdk/data';
    import { executeLocalCommand } from '@hearthlog/sdk/data';
    import type { AddGalleryAlbumPhotoEvent } from '@hearthlog/sdk/data';
    import { notify } from '@hearthlog/sdk/runtime';
    import { appClock } from '@hearthlog/sdk/runtime';
    import { tenant } from '@hearthlog/sdk/runtime';
    import {
        stageGalleryOriginal, discardStagedGalleryOriginal, triggerGalleryTransfers,
        type GalleryFileScope,
    } from '../gallery/file-store.js';
    import { readPhotoMetadata } from '../gallery/exif.js';
    import { exportGalleryBackup, restoreGalleryBackup } from '../gallery/backup.js';
    import { readGalleryArchive } from '../gallery/backup-archive.js';
    import { GALLERY_DENSITY_KEY, parseGalleryDensity, type GalleryDensity } from '../gallery/timeline.js';
    import { getDeviceSetting as kvGet, setDeviceSetting as kvSet } from '@hearthlog/sdk/runtime';
    import { gallerySelectionToken, readGallerySelection, writeGallerySelection } from '../gallery/selection.js';
    import type { GalleryAlbumSummary, GalleryFilter } from '../data/gallery.js';
    import type { GalleryPhoto } from '@hearthlog/sdk/data';
    import IconPlus from '~icons/mdi/plus';
    import IconImage from '~icons/mdi/image-multiple-outline';
    import IconSearch from '~icons/mdi/magnify';
    import IconArchive from '~icons/mdi/archive-arrow-down-outline';
    import IconDotsVertical from '~icons/mdi/dots-vertical';
    import IconMinus from '~icons/mdi/minus';

    let { data: routeData } = $props();
    const resource = $derived(routeData.pageResource);
    providePageResource(() => resource);
    const data = $derived(resource.data);

    let tab = $state<'photos' | 'favorites' | 'albums' | 'shared'>(page.url.searchParams.get('tab') === 'shared' ? 'shared' : page.url.searchParams.get('tab') === 'albums' ? 'albums' : page.url.searchParams.get('tab') === 'favorites' ? 'favorites' : 'photos');
    let albumId = $state(page.url.searchParams.get('album') ?? '');
    let createAlbumOpen = $state(false);
    let publishSource = $state<PublicationSource | null>(null);
    let selectionToken = $state(gallerySelectionToken(page.url.searchParams));
    const selectMode = $derived(Boolean(selectionToken));
    let selectedPhotoIds = $state<Set<string>>(new Set());
    let albumChoices = $state<GalleryAlbumSummary[]>([]);
    let selectedAlbumId = $state('');
    let addAlbumOpen = $state(false);
    let addAlbumLoading = $state(false);
    let selectionBusy = $state(false);
    let selectionError = $state('');
    let pendingAlbumEvents: AddGalleryAlbumPhotoEvent[] | null = null;
    let pendingAlbumSubmissionId = '';
    let query = $state(page.url.searchParams.get('q') ?? '');
    let selectedId = $state(page.url.searchParams.get('photo') ?? '');
    let selected = $state<GalleryPhoto | null>(null);
    /** The timeline a photo was opened from; the viewer's arrows stay within it. */
    let viewerFilter = $state<GalleryFilter>({});
    let busy = $state(false);
    let importError = $state('');
    let editOpen = $state(false);
    let editingPhoto = $state<GalleryPhoto | null>(null);
    let removeOpen = $state(false);
    let captionDraft = $state('');
    let editError = $state('');
    let backupOpen = $state(false);
    let backupBusy = $state(false);
    let backupStatus = $state('');
    let backupError = $state('');
    let restoreFile = $state<File | null>(null);
    let restoreCounts = $state<{ photos: number; albums: number } | null>(null);
    let fileInput: HTMLInputElement;

    // ---------------------------------------------------------------- the timeline

    /** Photos and Favorites read one timeline, narrowed by search. */
    const filter = $derived<GalleryFilter>({ query: query.trim(), favoritesOnly: tab === 'favorites' });
    let source = $state.raw<GalleryTimelineSource | null>(null);
    let timeline = $state<ReturnType<typeof GalleryTimeline>>();
    let albumSection = $state<ReturnType<typeof AlbumSection>>();
    /** Where the timeline opens: the month in the address on load, the newest photos after a new filter. */
    let opening = $state<GalleryOpening>(page.url.searchParams.get('month') ?? 'start');
    let density = $state<GalleryDensity>(1);
    /** A photo to bring into view once the timeline lists it, after an import. */
    let revealAfterLoad: GalleryPhoto | null = null;

    onMount(() => {
        void kvGet<unknown>(GALLERY_DENSITY_KEY).then((stored) => density = parseGalleryDensity(stored)).catch(() => undefined);
    });

    function changeDensity(next: GalleryDensity) {
        density = next;
        void kvSet(GALLERY_DENSITY_KEY, next).catch(() => undefined);
    }

    // The summary for the view, read after every load and whenever the view changes.
    $effect(() => {
        if (resource.loading || tab === 'albums' || tab === 'shared') return;
        const current = filter;
        void resource.revision;
        let cancelled = false;
        void queryDatabase((repositories) => repositories.gallery.summary(current)).then((summary) => {
            if (!cancelled) source = { filter: current, summary };
        }).catch(() => {
            if (!cancelled) notify.error('Could not load photos');
        });
        return () => { cancelled = true; };
    });

    $effect(() => {
        if (!source || !revealAfterLoad) return;
        const photo = revealAfterLoad;
        revealAfterLoad = null;
        void tick().then(() => timeline?.revealPhoto(photo));
    });

    const beginning = $derived.by(() => {
        const oldest = source?.summary.months[source.summary.months.length - 1];
        if (!source || !oldest) return '';
        const { name, year } = formatMonthParts(oldest.month);
        if (source.filter.query) return `${formatPhotoCount(source.summary.count)} match “${source.filter.query}”`;
        return `${source.filter.favoritesOnly ? `${source.summary.count} ${source.summary.count === 1 ? 'favorite' : 'favorites'}` : formatPhotoCount(source.summary.count)} since ${name} ${year}`;
    });

    // The address follows the month in view quietly, so a reload opens there.
    let addressTimer: ReturnType<typeof setTimeout> | undefined;
    function followMonth(month: string) {
        clearTimeout(addressTimer);
        addressTimer = setTimeout(() => {
                const url = new URL(window.location.href);
                if (url.searchParams.get('month') === month || (url.searchParams.get('tab') ?? 'photos') !== (tab === 'photos' ? 'photos' : tab)) return;
                url.searchParams.set('month', month);
                goto(url, { shallow: true, replace: true, state: page.state });
            },
            250
        );
    }
    $effect(() => () => clearTimeout(addressTimer));

    onMount(() => {
        const sync = () => {
            const url = new URL(window.location.href);
            tab = url.searchParams.get('tab') === 'shared' ? 'shared' : url.searchParams.get('tab') === 'albums' ? 'albums' : url.searchParams.get('tab') === 'favorites' ? 'favorites' : 'photos';
            albumId = url.searchParams.get('album') ?? '';
            query = url.searchParams.get('q') ?? '';
            selectedId = url.searchParams.get('photo') ?? '';
            selectionToken = gallerySelectionToken(url.searchParams);
        };
        window.addEventListener('popstate', sync);
        return () => window.removeEventListener('popstate', sync);
    });

    function updateUrl(name: string, value: string, history: 'push' | 'replace' = 'push') {
        const url = new URL(window.location.href);

        if (value) url.searchParams.set(name, value); else url.searchParams.delete(name);
        if (history === 'push') goto(url, { shallow: true, state: page.state }); else goto(url, { shallow: true, replace: true, state: page.state });
    }

    function selectTab(value: 'photos' | 'favorites' | 'albums' | 'shared') {
        tab = value;
        selectionToken = '';
        selectedPhotoIds = new Set();
        opening = 'start';
        const url = new URL(window.location.href);
        if (value === 'photos') url.searchParams.delete('tab');
        else url.searchParams.set('tab', value);
        url.searchParams.delete('selection');
        url.searchParams.delete('month');
        goto(url, { shallow: true, state: page.state });
    }

    function openAlbum(id: string) {
        albumId = id;
        updateUrl('album', id);
    }

    function openAlbumFromTimeline(id: string) {
        selectTab('albums');
        openAlbum(id);
    }

    function toggleSelectedPhoto(id: string) {
        const next = new Set(selectedPhotoIds);
        if (next.has(id)) next.delete(id); else next.add(id);
        selectedPhotoIds = next;
        if (selectionToken) writeGallerySelection(sessionStorage, data.tenantId, data.logId, selectionToken, next);
    }

    function beginSelection() {
        const token = crypto.randomUUID();
        selectionToken = token;
        selectedPhotoIds = new Set();
        writeGallerySelection(sessionStorage, data.tenantId, data.logId, token, selectedPhotoIds);
        updateUrl('selection', token);
    }

    /** The corner check selects a photo, starting a selection when none is open. */
    function selectPhoto(id: string) {
        if (!selectMode) beginSelection();
        toggleSelectedPhoto(id);
    }

    async function selectMonth(month: string, select: boolean) {
        const within = source?.filter ?? filter;
        try {
            const ids = await queryDatabase((repositories) => repositories.gallery.monthPhotoIds(month, within));
            const next = new Set(selectedPhotoIds);
            for (const id of ids) {
                if (select) next.add(id); else next.delete(id);
            }
            selectedPhotoIds = next;
            if (selectionToken) writeGallerySelection(sessionStorage, data.tenantId, data.logId, selectionToken, next);
        } catch { notify.error('Could not select the month'); }
    }

    function cancelSelection() {
        selectionToken = '';
        selectedPhotoIds = new Set();
        updateUrl('selection', '');
    }

    function reviewSelected() {
        if (selectedPhotoIds.size === 0) return;
        publishSource = { photoIds: [...selectedPhotoIds], title: 'My photos', description: '' };
        cancelSelection();
    }

    $effect(() => {
        const token = selectionToken;
        const tenantId = data.tenantId;
        const logId = data.logId;
        if (!token || !tenantId || !logId) return;
        selectedPhotoIds = readGallerySelection(sessionStorage, tenantId, logId, token);
    });

    async function openAddToAlbum() {
        if (!selectedPhotoIds.size) return;
        addAlbumOpen = true;
        selectionError = '';
        selectedAlbumId = '';
        albumChoices = [];
        addAlbumLoading = true;
        pendingAlbumEvents = null;
        pendingAlbumSubmissionId = '';
        try { albumChoices = await queryDatabase((repositories) => repositories.gallery.albums()); }
        catch { selectionError = 'Albums could not be loaded.'; }
        finally { addAlbumLoading = false; }
    }

    async function addSelectionToAlbum() {
        if (!selectedAlbumId || !selectedPhotoIds.size || selectionBusy) return;
        selectionBusy = true;
        selectionError = '';
        try {
            const photoIds = pendingAlbumEvents
                ? pendingAlbumEvents.map((event) => event.payload.photoId)
                : await queryDatabase((repositories) => repositories.gallery.addableAlbumPhotoIds(selectedAlbumId, [...selectedPhotoIds]));
            if (photoIds.length === 0) {
                notify.info('These photos are already in the album');
            } else {
                const now = Date.now();
                pendingAlbumEvents ??= photoIds.map((photoId, index) => ({
                    id: crypto.randomUUID(), type: 'GALLERY_ALBUM_PHOTO_ADDED', timestamp: now + index,
                    payload: { id: crypto.randomUUID(), albumId: selectedAlbumId, photoId, addedAt: new Date(now + index).toISOString() },
                }));
                pendingAlbumSubmissionId ||= crypto.randomUUID();
                await executeLocalCommand(pendingAlbumEvents, { submissionId: pendingAlbumSubmissionId });
                await refreshPageData('app:gallery');
                notify.success(photoIds.length === 1 ? 'Photo added to album' : `${photoIds.length} photos added to album`);
            }
            addAlbumOpen = false;
            pendingAlbumEvents = null;
            pendingAlbumSubmissionId = '';
            cancelSelection();
        } catch (cause) { selectionError = cause instanceof Error ? cause.message : 'Photos could not be added.'; }
        finally { selectionBusy = false; }
    }

    function setQuery(value: string) {
        query = value;
        opening = 'start';
        updateUrl('q', value.trim(), 'replace');
    }

    function openPhoto(id: string, within: GalleryFilter = source?.filter ?? filter) {
        viewerFilter = within;
        selectedId = id;
        updateUrl('photo', id);
    }

    function closePhoto() {
        const photo = selected;
        selectedId = '';
        updateUrl('photo', '', 'replace');
        // Back in the timeline, the photo last shown is in view and focused.
        if (photo) void tick().then(() => (tab === 'albums' ? albumSection : timeline)?.revealPhoto(photo));
    }

    $effect(() => {
        if (!selectedId || resource.loading) { if (!selectedId) selected = null; return; }
        const id = selectedId;
        void resource.revision;
        let cancelled = false;
        void queryDatabase((repositories) => repositories.gallery.get(id)).then((photo) => {
            if (!cancelled) selected = photo;
        });
        return () => { cancelled = true; };
    });

    async function imageDimensions(file: File): Promise<{ width: number; height: number }> {
        try {
            const image = await createImageBitmap(file);
            const dimensions = { width: image.width, height: image.height };
            image.close();
            return dimensions;
        } catch {
            // Keep the original when a browser cannot decode HEIC/HEIF.
            return { width: 0, height: 0 };
        }
    }

    async function addPhotos(files: FileList | null) {
        if (!files?.length || busy) return;
        busy = true;
        importError = '';
        let added = 0;
        let first: GalleryPhoto | null = null;
        try {
            for (const file of Array.from(files)) {
                if (!['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(file.type) || file.size === 0 || file.size > 20 * 1024 * 1024) {
                    throw new Error(`${file.name}: use a supported photo up to 20 MiB.`);
                }
                const context = await requireActiveContext();
                const photoId = crypto.randomUUID();
                const fileVersionId = crypto.randomUUID();
                const scope: GalleryFileScope = { tenantId: context.tenantId, logId: context.logId, photoId, fileVersionId };
                const dimensions = await imageDimensions(file);
                const { capturedDay, ...metadata } = readPhotoMetadata(new Uint8Array(await file.arrayBuffer()));
                const now = await appClock.ready();
                const importedAt = now.toISOString();
                // The camera's capture day places the photo; the import day is the fallback.
                const timelineDay = capturedDay || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
                await stageGalleryOriginal(scope, file);
                try {
                    await galleryPhotoCommands.create({
                        id: photoId, fileVersionId, filename: file.name, contentType: file.type,
                        byteSize: file.size, ...dimensions, ...metadata, importedAt,
                        timelineDay, caption: '', favorite: false,
                    }, { submissionId: crypto.randomUUID() });
                    first ??= { id: photoId, timeline_day: timelineDay, imported_at: importedAt } as GalleryPhoto;
                } catch (cause) {
                    await discardStagedGalleryOriginal(scope);
                    throw cause;
                }
                added += 1;
            }
            // New photos land at their capture month; the timeline turns to the first one.
            if (tab !== 'photos' || query.trim()) {
                if (query.trim()) setQuery('');
                if (tab !== 'photos') selectTab('photos');
            }
            revealAfterLoad = first;
            await refreshPageData('app:gallery');
            notify.success(added === 1 ? 'Photo saved on this device' : `${added} photos saved on this device`);
            triggerGalleryTransfers();
        } catch (cause) {
            importError = cause instanceof Error ? cause.message : 'Photos could not be saved.';
            if (added) await refreshPageData('app:gallery');
        } finally {
            busy = false;
            if (fileInput) fileInput.value = '';
        }
    }

    async function toggleFavorite() {
        if (!selected || busy) return;
        busy = true;
        try {
            await galleryPhotoCommands.update({ id: selected.id, favorite: !selected.favorite }, { submissionId: crypto.randomUUID() });
            selected = { ...selected, favorite: selected.favorite ? 0 : 1 };
            await refreshPageData('app:gallery');
        } catch { notify.error('Could not update favorite'); }
        finally { busy = false; }
    }

    function editPhoto() {
        if (!selected) return;
        editingPhoto = selected;
        captionDraft = selected.caption;
        editError = '';
        closePhoto();
        selected = null;
        editOpen = true;
    }

    function closeEdit() {
        editOpen = false;
        if (editingPhoto) openPhoto(editingPhoto.id);
        editingPhoto = null;
    }

    async function savePhoto() {
        if (!editingPhoto || busy) return;
        busy = true;
        editError = '';
        try {
            const caption = captionDraft.trim();
            await galleryPhotoCommands.update({ id: editingPhoto.id, caption }, { submissionId: crypto.randomUUID() });
            await refreshPageData('app:gallery');
            closeEdit();
            notify.success('Photo updated');
        } catch (cause) { editError = cause instanceof Error ? cause.message : 'Photo could not be updated.'; }
        finally { busy = false; }
    }

    async function removePhoto() {
        if (!selected || busy) return;
        busy = true;
        try {
            await galleryPhotoCommands.remove({ id: selected.id }, { submissionId: crypto.randomUUID() });
            removeOpen = false;
            closePhoto();
            selected = null;
            await refreshPageData('app:gallery');
            notify.success('Photo removed');
        } catch { notify.error('Could not remove photo'); }
        finally { busy = false; }
    }

    async function previewBackup(file: File | undefined) {
        restoreFile = null;
        restoreCounts = null;
        backupError = '';
        if (!file) return;
        try {
            const { manifest } = await readGalleryArchive(file);
            restoreFile = file;
            restoreCounts = { photos: manifest.photos.length, albums: manifest.albums.length };
        } catch (cause) { backupError = cause instanceof Error ? cause.message : 'Backup could not be read.'; }
    }

    async function downloadBackup() {
        if (backupBusy) return;
        backupBusy = true;
        backupError = '';
        try {
            const count = await exportGalleryBackup((message) => backupStatus = message);
            backupStatus = '';
            notify.success(`${count} ${count === 1 ? 'photo' : 'photos'} backed up`);
        } catch (cause) {
            backupStatus = '';
            if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
                backupError = cause instanceof Error ? cause.message : 'Backup could not be downloaded.';
            }
        } finally { backupBusy = false; }
    }

    async function restoreBackup() {
        if (!restoreFile || backupBusy) return;
        backupBusy = true;
        backupError = '';
        try {
            const result = await restoreGalleryBackup(restoreFile, (message) => backupStatus = message);
            await refreshPageData('app:gallery');
            backupOpen = false;
            backupStatus = '';
            notify.success(`${result.photos} ${result.photos === 1 ? 'photo' : 'photos'} and ${result.albums} ${result.albums === 1 ? 'album' : 'albums'} restored`);
        } catch (cause) {
            await refreshPageData('app:gallery');
            backupStatus = '';
            backupError = cause instanceof Error ? cause.message : 'Backup could not be restored.';
        } finally { backupBusy = false; }
    }
</script>

<svelte:head><title>Gallery | {tenant.title}</title></svelte:head>
<PageDataStatus resource={resource} />

<div class="flex min-h-0 flex-col lg:h-full">
    {#snippet galleryTabs()}
        <Tabs.Root value={tab} onValueChange={(value) => selectTab(value as 'photos' | 'favorites' | 'albums' | 'shared')}>
            <Tabs.List class="stor-page-tabs stor-primary-tabs flex max-w-full items-center" aria-label="Gallery sections" {@attach tabIndicator}>
                <Tabs.Trigger value="photos" class="stor-page-tab">Photos</Tabs.Trigger>
                <Tabs.Trigger value="favorites" class="stor-page-tab">Favorites</Tabs.Trigger>
                <Tabs.Trigger value="albums" class="stor-page-tab">Albums</Tabs.Trigger>
                <Tabs.Trigger value="shared" class="stor-page-tab">Shared</Tabs.Trigger>
            </Tabs.List>
        </Tabs.Root>
    {/snippet}
    <PageHeader title="Gallery" tabs={galleryTabs} class="shrink-0 px-3 pt-4 pb-2">
        <Button variant="ghost" class="hidden sm:inline-flex" onclick={() => backupOpen = true}><IconArchive class="h-4 w-4" /> Backup</Button>
        <CommandOnly>
            {#if tab === 'albums'}
                <Button class="hidden lg:inline-flex" onclick={() => createAlbumOpen = true}><IconPlus class="h-4 w-4" /> New album</Button>
            {:else if tab === 'photos' || tab === 'favorites'}
                <Button variant="secondary" class="hidden lg:inline-flex" aria-pressed={selectMode} onclick={() => selectMode ? cancelSelection() : beginSelection()}>{selectMode ? 'Cancel selection' : 'Select'}</Button>
                <Button class="hidden lg:inline-flex" onclick={() => fileInput?.click()} disabled={busy}><IconPlus class="h-4 w-4" /> Add photos</Button>
            {/if}
        </CommandOnly>
    </PageHeader>
    <input bind:this={fileInput} type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" class="sr-only" aria-label="Choose photos" onchange={(event) => void addPhotos(event.currentTarget.files)} />
    {#if importError}<p role="alert" class="mx-3 mb-3 text-sm text-[var(--stor-negative)]">{importError}</p>{/if}
    {#if tab === 'albums'}
        <div class={albumId ? 'gallery-view flex min-h-0 flex-col gap-3 px-3 pb-3 lg:flex-1' : 'min-h-0 px-3 pb-3 lg:flex-1 lg:overflow-y-auto'}>
            {#if !albumId}<Button variant="ghost" class="mb-3 sm:hidden" onclick={() => backupOpen = true}><IconArchive class="h-4 w-4" /> Backup</Button>{/if}
            {#if data.tenantId && data.logId}
                <AlbumSection
                    bind:this={albumSection}
                    tenantId={data.tenantId}
                    logId={data.logId}
                    revision={resource.revision}
                    albumId={albumId}
                    density={density}
                    onOpenAlbum={openAlbum}
                    onOpenPhoto={openPhoto}
                    openCreate={createAlbumOpen}
                    onCloseCreate={() => createAlbumOpen = false}
                    onCreate={() => createAlbumOpen = true}
                    onPublish={(album) => publishSource = {
                        albumId: album.id,
                        title: album.title,
                        description: album.description
                    }}
                />
            {/if}
        </div>
    {:else if tab === 'shared'}
        <div class="min-h-0 px-3 pb-3 lg:flex-1 lg:overflow-y-auto">
            <Button variant="ghost" class="mb-3 sm:hidden" onclick={() => backupOpen = true}><IconArchive class="h-4 w-4" /> Backup</Button>
            {#if data.tenantId && data.logId}<PublicationManager tenantId={data.tenantId} logId={data.logId} revision={resource.revision} source={publishSource} showList={true} onCloseSource={() => publishSource = null} />{/if}
        </div>
    {:else}
        <div class="gallery-view flex min-h-0 flex-col gap-3 px-3 pb-3 lg:flex-1">
            <div class="stor-panel flex shrink-0 items-center gap-1 p-1.5 sm:p-2">
                <label class="flex min-w-0 flex-1 items-center gap-2 px-2 text-[var(--stor-muted-text)]">
                    <IconSearch class="h-5 w-5" />
                    <input type="search" value={query} oninput={(event) => setQuery(event.currentTarget.value)} placeholder="Search photos" aria-label="Search photos" class="h-11 min-w-0 flex-1 bg-transparent text-sm text-[var(--stor-ink)] outline-none placeholder:text-[var(--stor-muted-text)] sm:h-9" />
                </label>

                <div
                    class="hidden shrink-0 items-center gap-0.5 rounded-xl bg-[var(--stor-surface-muted)] p-0.5 sm:flex"
                    role="group"
                    aria-label="Photo size"
                >
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Smaller photos"
                        disabled={density === 0}
                        onclick={() => changeDensity(density - 1 as GalleryDensity)}
                    ><IconMinus class="h-4 w-4" /></Button>

                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Larger photos"
                        disabled={density === 2}
                        onclick={() => changeDensity(density + 1 as GalleryDensity)}
                    ><IconPlus class="h-4 w-4" /></Button>
                </div>
                {#if source && source.summary.count > 0}
                    <CommandOnly><Button variant="ghost" class="lg:hidden" aria-pressed={selectMode} onclick={() => selectMode ? cancelSelection() : beginSelection()}>{selectMode ? 'Cancel' : 'Select'}</Button></CommandOnly>
                {/if}
                <DropdownMenu.Root>
                    <DropdownMenu.Trigger class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--stor-muted-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] sm:hidden" aria-label="Gallery actions"><IconDotsVertical class="h-5 w-5" /></DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                        <DropdownMenu.Content side="bottom" align="end" sideOffset={4} class="stor-menu z-[var(--stor-layer-menu)] w-44 py-1">
                            <DropdownMenu.Item class="flex cursor-default items-center gap-2 px-3 py-2 text-sm text-[var(--stor-ink)] outline-none data-[highlighted]:bg-[var(--stor-surface-muted)]" onSelect={() => backupOpen = true}><IconArchive class="h-4 w-4" /> Backup</DropdownMenu.Item>
                        </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                </DropdownMenu.Root>
            </div>
            {#if !source}
                <section class="stor-panel p-4 lg:flex-1" aria-label="Photos"><DataPlaceholder rows={6} label="Loading photos" /></section>
            {:else if source.summary.count === 0}
                <EmptyState
                    icon={IconImage}
                    title={source.filter.query ? 'No photos match' : tab === 'favorites' ? 'No favorites yet' : 'Your gallery starts here'}
                    description={source.filter.query ? 'Search looks at captions and file names.' : tab === 'favorites' ? 'Mark a photo as a favorite in the viewer.' : 'Add photos to keep them in your private library.'}
                >
                    {#if tab === 'photos' && !source.filter.query}<CommandOnly><Button onclick={() => fileInput?.click()}><IconPlus class="h-4 w-4" /> Add photos</Button></CommandOnly>{/if}
                </EmptyState>
            {:else}
                <section class="stor-panel relative min-h-0 flex-1" aria-label="Photos">
                    <GalleryTimeline
                        bind:this={timeline}
                        source={source}
                        tenantId={data.tenantId}
                        logId={data.logId}
                        revision={resource.revision}
                        density={density}
                        opening={opening}
                        beginning={beginning}
                        selecting={selectMode}
                        selectedIds={selectedPhotoIds}
                        onOpen={(id) => selectMode ? toggleSelectedPhoto(id) : openPhoto(id)}
                        onSelect={selectPhoto}
                        onSelectMonth={(month, select) => void selectMonth(month, select)}
                        onOpenAlbum={openAlbumFromTimeline}
                        onMonthChange={followMonth}
                    />
                    {#if selectMode}
                        <div class="absolute inset-x-2 bottom-2 z-10 flex flex-wrap items-center gap-2 rounded-2xl bg-[var(--stor-surface-raised)] p-1.5 pl-4 text-sm text-[var(--stor-ink)] shadow-[var(--stor-elevation-3)] sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 sm:flex-nowrap sm:rounded-full">
                            <span role="status" class="mr-auto whitespace-nowrap font-semibold">{selectedPhotoIds.size} selected</span>
                            <CommandOnly>
                                <Button variant="secondary" disabled={selectedPhotoIds.size === 0} onclick={() => void openAddToAlbum()}>Add to album</Button>
                                <Button disabled={selectedPhotoIds.size === 0} onclick={reviewSelected}>Prepare public gallery</Button>
                            </CommandOnly>
                            <Button variant="ghost" onclick={cancelSelection}>Cancel</Button>
                        </div>
                    {/if}
                </section>
            {/if}
        </div>
    {/if}
</div>

<MobilePageAction hidden={selectMode}>
    {#if tab === 'albums'}
        <Button onclick={() => runCommandAction(() => createAlbumOpen = true)}><IconPlus class="h-4 w-4" /> New album</Button>
    {:else if tab === 'photos' || tab === 'favorites'}
        <Button onclick={() => runCommandAction(() => fileInput?.click())} disabled={busy}><IconPlus class="h-4 w-4" /> Add photos</Button>
    {/if}
</MobilePageAction>

{#if tab !== 'shared' && data.tenantId && data.logId}
    <PublicationManager tenantId={data.tenantId} logId={data.logId} revision={resource.revision} source={publishSource} showList={false} onCloseSource={() => publishSource = null} />
{/if}

{#if selected && data.tenantId && data.logId}
    <PhotoViewer
        photo={selected}
        tenantId={data.tenantId}
        logId={data.logId}
        filter={viewerFilter}
        revision={resource.revision}
        onClose={closePhoto}
        onNavigate={(id) => openPhoto(id, viewerFilter)}
        onFavorite={() => void toggleFavorite()}
        onEdit={editPhoto}
        onRemove={() => removeOpen = true}
        onOpenAlbum={(id) => { closePhoto(); openAlbumFromTimeline(id); }}
    />
{/if}

<CommandModal show={editOpen} title="Edit photo" onClose={closeEdit}>
    <form class="space-y-4" onsubmit={(event) => { event.preventDefault(); void savePhoto(); }}>
        <label class="block text-sm font-medium text-[var(--stor-ink)]">Caption<Textarea bind:value={captionDraft} maxlength={500} class="mt-1" /></label>
        {#if editError}<p role="alert" class="text-sm text-[var(--stor-negative)]">{editError}</p>{/if}
        <div class="flex justify-end"><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save caption'}</Button></div>
    </form>
</CommandModal>

<CommandConfirmDialog
    show={removeOpen}
    title="Remove photo?"
    message="The photo leaves this log and its albums. Its original remains available to accepted history and other logs."
    confirmLabel="Remove photo"
    onConfirm={() => void removePhoto()}
    onCancel={() => removeOpen = false}
/>

<CommandModal
    show={addAlbumOpen}
    title="Add photos to album"
    onClose={() => {
        if (!selectionBusy) addAlbumOpen = false;
    }}
>
    <form
        class="space-y-4"
        onsubmit={(event) => {
            event.preventDefault();
            void addSelectionToAlbum();
        }}
    >
        <p class="text-sm text-[var(--stor-muted-text)]">{selectedPhotoIds.size} {selectedPhotoIds.size === 1 ? 'photo' : 'photos'} selected</p>
        {#if addAlbumLoading}
            <p role="status" class="text-sm text-[var(--stor-muted-text)]">Loading albums…</p>
        {:else if albumChoices.length > 0}
            <Select value={selectedAlbumId} options={albumChoices.map((album) => ({ value: album.id, label: album.title }))} ariaLabel="Album" placeholder="Choose an album" disabled={selectionBusy} onValueChange={(value) => { selectedAlbumId = value; pendingAlbumEvents = null; pendingAlbumSubmissionId = ''; }} />
        {:else if !selectionError}
            <p class="text-sm text-[var(--stor-muted-text)]">No albums yet. Create one in Albums first.</p>
        {/if}
        {#if selectionError}<p role="alert" class="text-sm text-[var(--stor-negative)]">{selectionError}</p>{/if}
        <div class="flex justify-end"><Button type="submit" disabled={selectionBusy || addAlbumLoading || !selectedAlbumId}>{selectionBusy ? 'Adding…' : 'Add to album'}</Button></div>
    </form>
</CommandModal>

<CommandModal show={backupOpen} title="Gallery backup" onClose={() => { if (!backupBusy) backupOpen = false; }}>
    <div class="space-y-4 text-sm text-[var(--stor-ink)]">
        <p>Save your original photos and albums to a private archive. It includes filenames and camera location data when present.</p>
        <Button variant="secondary" disabled={backupBusy} onclick={() => void downloadBackup()}><IconArchive class="h-4 w-4" /> Download backup</Button>
        <div class="border-t border-[var(--stor-border)] pt-4">
            <label class="block font-medium" for="gallery-restore-file">Restore into this log</label>
            <input id="gallery-restore-file" type="file" accept=".tar,application/x-tar" class="mt-2 block w-full text-sm" disabled={backupBusy} onchange={(event) => void previewBackup(event.currentTarget.files?.[0])} />
            {#if restoreCounts}
                <p class="mt-2 text-[var(--stor-muted-text)]">{restoreCounts.photos} {restoreCounts.photos === 1 ? 'photo' : 'photos'} · {restoreCounts.albums} {restoreCounts.albums === 1 ? 'album' : 'albums'}. Restored items receive new IDs.</p>
                <div class="mt-3"><Button disabled={backupBusy || !restoreCounts.photos} onclick={() => runCommandAction(() => void restoreBackup())}>Restore backup</Button></div>
            {/if}
        </div>
        {#if backupStatus}<p role="status" class="text-[var(--stor-muted-text)]">{backupStatus}</p>{/if}
        {#if backupError}<p role="alert" class="text-[var(--stor-negative)]">{backupError}</p>{/if}
    </div>
</CommandModal>

<style>
    /* On smaller screens the page scrolls: the timeline fills what the header and navigation leave. */
    .gallery-view {
        height: calc(100dvh - var(--stor-mobile-header-height) - var(--stor-mobile-bottom-inset) - var(--stor-mobile-nav-height) - var(--stor-mobile-stack-gap) - var(--stor-mobile-action-height) - 24px);
        min-height: 24rem;
        flex-shrink: 0;
    }
    @media (min-width: 1024px) {
        .gallery-view { height: auto; min-height: 0; flex-shrink: 1; }
    }
</style>
