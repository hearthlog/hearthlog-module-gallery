<script lang="ts">
    import { untrack } from 'svelte';
    import { queryDatabase } from '@hearthlog/sdk/data';
    import type { GalleryAlbumSummary, GalleryFilter } from '../../data/gallery.js';
    import type { GalleryAlbum, GalleryPhoto } from '@hearthlog/sdk/data';
    import type { AddGalleryAlbumPhotoEvent, RemoveGalleryAlbumPhotoEvent } from '@hearthlog/sdk/data';
    import { galleryAlbumCommands } from '@hearthlog/sdk/data';
    import { executeLocalCommand } from '@hearthlog/sdk/data';
    import { refreshPageData } from '@hearthlog/sdk/runtime';
    import { notify } from '@hearthlog/sdk/runtime';
    import { Button } from "@hearthlog/sdk/ui";
    import { Input } from "@hearthlog/sdk/ui";
    import { CommandOnly } from "@hearthlog/sdk/ui";
    import { CommandModal } from "@hearthlog/sdk/ui";
    import { CommandConfirmDialog } from "@hearthlog/sdk/ui";
    import { EmptyState } from "@hearthlog/sdk/ui";
    import AlbumCard from './AlbumCard.svelte';
    import GalleryTimeline, { type GalleryTimelineSource } from './GalleryTimeline.svelte';
    import type { GalleryDensity } from '../../gallery/timeline.js';
    import IconPlus from '~icons/mdi/plus';
    import IconArrowLeft from '~icons/mdi/arrow-left';
    import IconImage from '~icons/mdi/image-multiple-outline';

    let {
        tenantId, logId, revision, albumId, density, onOpenAlbum, onOpenPhoto,
        openCreate, onCloseCreate, onCreate, onPublish,
    }: {
        tenantId: string;
        logId: string;
        revision: number;
        albumId: string;
        density: GalleryDensity;
        onOpenAlbum: (id: string) => void;
        onOpenPhoto: (id: string, filter: GalleryFilter) => void;
        openCreate: boolean;
        onCloseCreate: () => void;
        onCreate: () => void;
        onPublish: (album: GalleryAlbum) => void;
    } = $props();

    let albums = $state<GalleryAlbumSummary[]>([]);
    let album = $state<GalleryAlbum | null>(null);
    /** The album's own timeline, newest first like Photos. */
    let source = $state.raw<GalleryTimelineSource | null>(null);
    let timeline = $state<ReturnType<typeof GalleryTimeline>>();
    const photoCount = $derived(source?.summary.count ?? 0);
    let candidates = $state<Array<GalleryPhoto & { in_album: number }>>([]);
    let selectedCandidates = $state<Set<string>>(new Set());
    let selectedMembers = $state<Set<string>>(new Set());
    let selectMode = $state(false);
    let addOpen = $state(false);
    let editOpen = $state(false);
    let deleteOpen = $state(false);
    let title = $state('');
    let description = $state('');
    let chooseQuery = $state('');
    let busy = $state(false);
    let error = $state('');
    let loadingCandidates = $state(false);
    let candidatesMore = $state(false);

    $effect(() => {
        if (!tenantId || !logId) return;
        void revision;
        let cancelled = false;
        void queryDatabase((repositories) => repositories.gallery.albums()).then((result) => {
            if (!cancelled) albums = result;
        }).catch(() => { if (!cancelled) notify.error('Could not load albums'); });
        return () => { cancelled = true; };
    });

    $effect(() => {
        const id = albumId;
        if (!id || !tenantId || !logId) { album = null; source = null; return; }
        void revision;
        let cancelled = false;
        const filter: GalleryFilter = { albumId: id };
        void queryDatabase(async (repositories) => ({
            album: await repositories.gallery.album(id),
            summary: await repositories.gallery.summary(filter),
        })).then((result) => {
            if (cancelled) return;
            album = result.album;
            source = { filter, summary: result.summary };
        }).catch(() => { if (!cancelled) notify.error('Could not load album'); });
        return () => { cancelled = true; };
    });

    $effect(() => {
        if (!addOpen || !albumId) return;
        const id = albumId;
        const search = chooseQuery;
        void revision;
        let cancelled = false;
        candidates = [];
        candidatesMore = false;
        void queryDatabase((repositories) => repositories.gallery.selectablePhotos(id, search)).then((result) => {
            if (!cancelled) { candidates = result; candidatesMore = result.length === 100; }
        }).catch(() => { if (!cancelled) notify.error('Could not load photos'); });
        return () => { cancelled = true; };
    });

    function toggleCandidate(id: string) {
        const next = new Set(selectedCandidates);
        if (next.has(id)) next.delete(id); else next.add(id);
        selectedCandidates = next;
    }

    function toggleMember(id: string) {
        const next = new Set(selectedMembers);
        if (next.has(id)) next.delete(id); else next.add(id);
        selectedMembers = next;
    }

    async function selectMonth(month: string, select: boolean) {
        if (!source) return;
        const within = source.filter;
        try {
            const ids = await queryDatabase((repositories) => repositories.gallery.monthPhotoIds(month, within));
            const next = new Set(selectedMembers);
            for (const id of ids) {
                if (select) next.add(id); else next.delete(id);
            }
            selectedMembers = next;
        } catch { notify.error('Could not select the month'); }
    }

    /** Brings a photo back into view after the viewer closes. */
    export function revealPhoto(photo: GalleryPhoto): void {
        void timeline?.revealPhoto(photo);
    }

    function beginCreate() { title = ''; description = ''; error = ''; }
    $effect(() => { if (openCreate) untrack(beginCreate); });

    function beginEdit() {
        if (!album) return;
        title = album.title;
        description = album.description;
        error = '';
        editOpen = true;
    }

    async function saveAlbum(edit: boolean) {
        if (busy) return;
        const cleanTitle = title.trim();
        if (!cleanTitle) { error = 'Enter an album name.'; return; }
        busy = true;
        error = '';
        try {
            if (edit && album) {
                await galleryAlbumCommands.update({ id: album.id, title: cleanTitle, description: description.trim() }, { submissionId: crypto.randomUUID() });
                editOpen = false;
            } else {
                const id = crypto.randomUUID();
                await galleryAlbumCommands.create({ id, title: cleanTitle, description: description.trim(), coverPhotoId: '' }, { submissionId: crypto.randomUUID() });
                onCloseCreate();
                onOpenAlbum(id);
            }
            await refreshPageData('app:gallery');
            notify.success(edit ? 'Album updated' : 'Album created');
        } catch (cause) { error = cause instanceof Error ? cause.message : 'Album could not be saved.'; }
        finally { busy = false; }
    }

    async function removeAlbum() {
        if (!album || busy) return;
        busy = true;
        try {
            await galleryAlbumCommands.remove({ id: album.id }, { submissionId: crypto.randomUUID() });
            deleteOpen = false;
            onOpenAlbum('');
            await refreshPageData('app:gallery');
            notify.success('Album removed');
        } catch { notify.error('Could not remove album'); }
        finally { busy = false; }
    }

    async function addSelected() {
        if (!album || selectedCandidates.size === 0 || busy) return;
        busy = true;
        try {
            const now = Date.now();
            const events: AddGalleryAlbumPhotoEvent[] = [...selectedCandidates].map((photoId, index) => ({
                id: crypto.randomUUID(), type: 'GALLERY_ALBUM_PHOTO_ADDED', timestamp: now + index,
                payload: { id: crypto.randomUUID(), albumId: album!.id, photoId, addedAt: new Date(now + index).toISOString() },
            }));
            await executeLocalCommand(events, { submissionId: crypto.randomUUID() });
            selectedCandidates = new Set();
            addOpen = false;
            await refreshPageData('app:gallery');
            notify.success(events.length === 1 ? 'Photo added to album' : `${events.length} photos added to album`);
        } catch (cause) { notify.error(cause instanceof Error ? cause.message : 'Could not add photos to album'); }
        finally { busy = false; }
    }

    async function removeSelected() {
        if (!album || selectedMembers.size === 0 || busy) return;
        busy = true;
        try {
            const memberships = await queryDatabase((repositories) => repositories.gallery.membershipsForPhotos(album!.id, [...selectedMembers]));
            const now = Date.now();
            const events: RemoveGalleryAlbumPhotoEvent[] = memberships.map((member, index) => ({
                id: crypto.randomUUID(), type: 'GALLERY_ALBUM_PHOTO_REMOVED', timestamp: now + index,
                payload: { id: member.id },
            }));
            if (events.length) await executeLocalCommand(events, { submissionId: crypto.randomUUID() });
            selectedMembers = new Set();
            selectMode = false;
            await refreshPageData('app:gallery');
            notify.success('Removed from album');
        } catch { notify.error('Could not remove photos from album'); }
        finally { busy = false; }
    }

    async function loadMoreCandidates() {
        if (!albumId || candidates.length === 0 || loadingCandidates) return;
        const last = candidates[candidates.length - 1];
        const id = albumId;
        const search = chooseQuery;
        loadingCandidates = true;
        try {
            const next = await queryDatabase((repositories) => repositories.gallery.selectablePhotos(id, search, {
                day: last.timeline_day, importedAt: last.imported_at, id: last.id,
            }));
            if (id === albumId && search === chooseQuery) {
                candidates = [...candidates, ...next];
                candidatesMore = next.length === 100;
            }
        } catch { notify.error('Could not load more photos'); }
        finally { loadingCandidates = false; }
    }
</script>

{#if albumId}
    {#if album}
        <div class="flex shrink-0 flex-wrap items-center gap-2">
            <Button variant="ghost" size="icon" aria-label="All albums" onclick={() => onOpenAlbum('')}><IconArrowLeft class="h-5 w-5" /></Button>
            <div class="min-w-0 flex-1">
                <h2 class="stor-serif-title truncate text-2xl text-[var(--stor-ink)]">{album.title}</h2>
                <p class="text-sm text-[var(--stor-muted-text)]">{photoCount} {photoCount === 1 ? 'photo' : 'photos'}</p>
            </div>
            <CommandOnly>
                {#if photoCount > 0}<Button variant="secondary" onclick={() => onPublish(album!)}>Publish album</Button>{/if}
                <Button variant="secondary" onclick={() => { selectedCandidates = new Set(); chooseQuery = ''; addOpen = true; }}><IconPlus class="h-4 w-4" /> Add to album</Button>
                <Button variant="ghost" onclick={() => { selectMode = !selectMode; selectedMembers = new Set(); }}>{selectMode ? 'Done selecting' : 'Select'}</Button>
                <Button variant="ghost" onclick={beginEdit}>Edit</Button>
                <Button variant="ghost" onclick={() => deleteOpen = true}>Remove album</Button>
            </CommandOnly>
        </div>
        {#if selectMode && selectedMembers.size}
            <div class="stor-panel flex shrink-0 items-center justify-between p-3 text-sm text-[var(--stor-ink)]">
                <span>{selectedMembers.size} selected</span>
                <CommandOnly><Button variant="destructive" onclick={() => void removeSelected()} disabled={busy}>Remove from album</Button></CommandOnly>
            </div>
        {/if}
        {#if !source}
            <div class="stor-panel p-6 text-sm text-[var(--stor-muted-text)]" role="status">Loading album…</div>
        {:else if photoCount === 0}
            <EmptyState icon={IconImage} title="Album is empty" description="Choose photos from your private gallery to add them here." />
        {:else}
            <section class="stor-panel relative min-h-0 flex-1" aria-label={`${album.title} photos`}>
                <GalleryTimeline
                    bind:this={timeline}
                    {source}
                    {tenantId}
                    {logId}
                    {revision}
                    {density}
                    opening="start"
                    chips={false}
                    showLatest={false}
                    selecting={selectMode}
                    selectedIds={selectedMembers}
                    onOpen={(id) => selectMode ? toggleMember(id) : onOpenPhoto(id, source!.filter)}
                    onSelect={(id) => { selectMode = true; toggleMember(id); }}
                    onSelectMonth={(month, select) => void selectMonth(month, select)}
                />
            </section>
        {/if}
    {:else}
        <div class="stor-panel p-6 text-sm text-[var(--stor-muted-text)]" role="status">Loading album…</div>
    {/if}
{:else if albums.length === 0}
    <EmptyState icon={IconImage} title="No albums yet" description="Collect photos without making another copy of each file.">
        <CommandOnly><Button onclick={onCreate}>New album</Button></CommandOnly>
    </EmptyState>
{:else}
    <div class="stor-panel grid grid-cols-2 gap-4 p-3 sm:grid-cols-3 sm:p-4 xl:grid-cols-4">
        {#each albums as item (item.id)}
            <AlbumCard album={item} {tenantId} {logId} onOpen={() => onOpenAlbum(item.id)} />
        {/each}
    </div>
{/if}

<CommandModal show={openCreate || editOpen} title={editOpen ? 'Edit album' : 'New album'} onClose={() => { editOpen = false; onCloseCreate(); }}>
    <form onsubmit={(event) => { event.preventDefault(); void saveAlbum(editOpen); }} class="space-y-4">
        <label class="block text-sm font-medium text-[var(--stor-ink)]">Name<Input bind:value={title} maxlength={120} required class="mt-1" /></label>
        <label class="block text-sm font-medium text-[var(--stor-ink)]">Description<Input bind:value={description} maxlength={240} class="mt-1" /></label>
        {#if error}<p role="alert" class="text-sm text-[var(--stor-negative)]">{error}</p>{/if}
        <div class="flex justify-end"><Button type="submit" disabled={busy}>{busy ? 'Saving…' : editOpen ? 'Save album' : 'Create album'}</Button></div>
    </form>
</CommandModal>

<CommandModal show={addOpen} title="Add photos to album" onClose={() => { addOpen = false; selectedCandidates = new Set(); }}>
    <div class="space-y-3">
        <Input type="search" bind:value={chooseQuery} placeholder="Search photos" aria-label="Search photos to add" />
        <div class="max-h-[55vh] space-y-1 overflow-y-auto">
            {#each candidates as candidate (candidate.id)}
                <label class="flex min-h-11 items-center gap-3 rounded-lg px-2 text-sm text-[var(--stor-ink)] hover:bg-[var(--stor-surface-muted)]">
                    <input type="checkbox" checked={candidate.in_album ? true : selectedCandidates.has(candidate.id)} disabled={Boolean(candidate.in_album)} onchange={() => toggleCandidate(candidate.id)} />
                    <span class="min-w-0 flex-1 truncate">{candidate.filename}</span>
                    {#if candidate.in_album}<span class="text-xs text-[var(--stor-muted-text)]">Added</span>{/if}
                </label>
            {/each}
            {#if candidates.length === 0}<p class="py-4 text-sm text-[var(--stor-muted-text)]">No photos found.</p>{/if}
            {#if candidatesMore}<div class="py-2 text-center"><Button variant="secondary" disabled={loadingCandidates} onclick={() => void loadMoreCandidates()}>{loadingCandidates ? 'Loading…' : 'Load more photos'}</Button></div>{/if}
        </div>
        <div class="flex justify-end"><Button disabled={busy || selectedCandidates.size === 0} onclick={() => void addSelected()}>Add {selectedCandidates.size || ''} {selectedCandidates.size === 1 ? 'photo' : 'photos'}</Button></div>
    </div>
</CommandModal>

<CommandConfirmDialog show={deleteOpen} title="Remove album?" message="Photos stay in your gallery. This album can be recovered from log history." confirmLabel="Remove album" onConfirm={() => void removeAlbum()} onCancel={() => deleteOpen = false} />
