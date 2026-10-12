<script lang="ts">
    import { Dialog, DropdownMenu } from 'bits-ui';
    import type { GalleryPhoto, GalleryAlbum } from '@hearthlog/sdk/data';
    import type { GalleryFilter } from '../../data/gallery.js';
    import { queryDatabase } from '@hearthlog/sdk/data';
    import { galleryOriginal, galleryRendition, galleryUploadState, type GalleryFileScope } from '../../gallery/file-store.js';
    import { tileRatio } from '../../gallery/layout.js';
    import { formatPhotoDate, photoDetailRows } from '../../gallery/format.js';
    import { runCommandAction } from '@hearthlog/sdk/runtime';
    import { CommandOnly } from "@hearthlog/sdk/ui";
    import PhotoThumb from './PhotoThumb.svelte';
    import ViewerFrame from './view/ViewerFrame.svelte';
    import IconDownload from '~icons/mdi/download';
    import IconHeart from '~icons/mdi/heart-outline';
    import IconHeartFilled from '~icons/mdi/heart';
    import IconPencil from '~icons/mdi/pencil-outline';
    import IconDelete from '~icons/mdi/delete-outline';
    import IconDotsVertical from '~icons/mdi/dots-vertical';

    let {
        photo, tenantId, logId, filter, revision, onClose, onNavigate, onFavorite, onEdit, onRemove, onOpenAlbum,
    }: {
        photo: GalleryPhoto;
        tenantId: string;
        logId: string;
        /** The timeline the photo was opened from; the filmstrip and arrows stay within it. */
        filter: GalleryFilter;
        revision: number;
        onClose: () => void;
        onNavigate: (id: string) => void;
        onFavorite: () => void;
        onEdit: () => void;
        onRemove: () => void;
        onOpenAlbum: (id: string) => void;
    } = $props();

    let imageUrl = $state('');
    let backdropUrl = $state('');
    let error = $state('');
    let uploadStatus = $state<'pending' | 'needs_attention' | 'remote'>('remote');
    // Details sit beside the photo on desktop and open as a sheet on phones.
    let detailsOpen = $state(typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches);
    /** The photo with its neighbours, oldest first. The last strip stays until the next one is read. */
    let film = $state.raw<GalleryPhoto[]>([]);
    let albums = $state<GalleryAlbum[]>([]);

    const scope = $derived<GalleryFileScope>({ tenantId, logId, photoId: photo.id, fileVersionId: photo.file_version_id });
    const place = $derived(film.findIndex((item) => item.id === photo.id));
    const older = $derived(place > 0 ? film[place - 1] : null);
    const newer = $derived(place >= 0 && place < film.length - 1 ? film[place + 1] : null);
    const details = $derived(photoDetailRows(photo));
    const filmItems = $derived(film.map((item) => ({ id: item.id, ratio: tileRatio(item), label: item.filename })));

    $effect(() => {
        if (!scope.tenantId || !scope.logId) return;
        let cancelled = false;
        const urls: string[] = [];
        const show = (blob: Blob) => {
            const url = URL.createObjectURL(blob);
            urls.push(url);
            return url;
        };
        error = '';
        void galleryRendition(scope, 'thumbnail').then((blob) => {
            if (cancelled) return;
            backdropUrl = show(blob);
            if (!imageUrl) imageUrl = backdropUrl;
        }).catch(() => undefined);
        void galleryRendition(scope, 'display').then((blob) => {
            if (!cancelled) imageUrl = show(blob);
        }).catch((cause) => {
            if (!cancelled && !imageUrl) error = cause instanceof Error ? cause.message : 'Photo unavailable';
        });
        return () => {
            cancelled = true;
            imageUrl = '';
            backdropUrl = '';
            // Keep the old images a moment so the next photo fades in over them.
            setTimeout(() => urls.forEach((url) => URL.revokeObjectURL(url)), 1000);
        };
    });

    $effect(() => {
        if (!scope.tenantId || !scope.logId) return;
        let cancelled = false;
        const update = () => {
            void galleryUploadState(scope).then((upload) => {
                if (!cancelled) uploadStatus = upload?.state ?? 'remote';
            }).catch(() => { if (!cancelled) uploadStatus = 'remote'; });
        };
        update();
        const transferred = (event: Event) => {
            if ((event as CustomEvent<string>).detail === photo.id) update();
        };
        window.addEventListener('stor:gallery-transfer', transferred);
        return () => { cancelled = true; window.removeEventListener('stor:gallery-transfer', transferred); };
    });

    // Neighbours for the arrows and the filmstrip, and the albums holding the photo, in SQL.
    $effect(() => {
        const current = photo;
        const within = filter;
        void revision;
        let cancelled = false;
        void queryDatabase(async (repositories) => ({
            nearby: await repositories.gallery.strip(current, within, 8),
            albums: await repositories.gallery.photoAlbums(current.id),
        })).then((result) => {
            if (cancelled) return;
            film = [...result.nearby.older, current, ...result.nearby.newer];
            albums = result.albums;
        }).catch((cause) => console.warn('[Gallery] Could not read nearby photos', cause));
        return () => { cancelled = true; };
    });

    /** F favorites the photo; the frame handles the arrows and details. */
    function handleKey(event: KeyboardEvent) {
        if (event.key === 'f') runCommandAction(onFavorite);
    }

    async function downloadOriginal() {
        try {
            const blob = await galleryOriginal(scope);
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = photo.filename;
            link.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } catch {
            error = 'The original could not be downloaded.';
        }
    }
</script>

<Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-[var(--stor-layer-sheet)] bg-black/60" />
        <Dialog.Content class="fixed inset-0 z-[var(--stor-layer-sheet-content)] overflow-hidden outline-none lg:inset-5 lg:rounded-[var(--stor-panel-radius)]">
            <ViewerFrame
                title={formatPhotoDate(photo)}
                subtitle={`${photo.filename}${photo.captured_at ? '' : ' · Imported'}`}
                status={uploadStatus === 'remote' ? '' : uploadStatus === 'pending' ? 'Saved on this device' : 'Upload needs attention'}
                imageKey={photo.id}
                {imageUrl}
                {backdropUrl}
                alt={photo.caption || photo.filename}
                caption={photo.caption}
                message={error}
                older={older ? { id: older.id } : null}
                newer={newer ? { id: newer.id } : null}
                film={filmItems}
                currentId={photo.id}
                {details}
                bind:detailsOpen
                {onClose}
                {onNavigate}
                onKey={handleKey}
            >
                {#snippet heading(title)}<Dialog.Title class="viewer-title">{title}</Dialog.Title>{/snippet}
                {#snippet actions()}
                    <CommandOnly>
                        <button type="button" class="viewer-button" class:favorite={photo.favorite} aria-pressed={Boolean(photo.favorite)} aria-label={photo.favorite ? 'Remove favorite' : 'Add favorite'} onclick={onFavorite}>
                            {#if photo.favorite}<IconHeartFilled />{:else}<IconHeart />{/if}
                        </button>
                        <button type="button" class="viewer-button desktop-only" aria-label="Edit photo" onclick={onEdit}><IconPencil /></button>
                        <button type="button" class="viewer-button desktop-only" aria-label="Remove photo" onclick={onRemove}><IconDelete /></button>
                    </CommandOnly>
                    <button type="button" class="viewer-button desktop-only" aria-label="Download original" onclick={() => void downloadOriginal()}><IconDownload /></button>
                    <DropdownMenu.Root>
                        <DropdownMenu.Trigger class="viewer-button phone-only" aria-label="Photo actions"><IconDotsVertical /></DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                            <DropdownMenu.Content side="bottom" align="end" sideOffset={4} class="stor-menu z-[var(--stor-layer-menu)] w-48 py-1">
                                <DropdownMenu.Item class="flex cursor-default items-center gap-2 px-3 py-2 text-sm text-[var(--stor-ink)] outline-none data-[highlighted]:bg-[var(--stor-surface-muted)]" onSelect={() => void downloadOriginal()}><IconDownload class="h-4 w-4" /> Download original</DropdownMenu.Item>
                                <DropdownMenu.Separator class="my-1 h-px bg-[var(--stor-border)]" />
                                <CommandOnly>
                                    <DropdownMenu.Item class="flex cursor-default items-center gap-2 px-3 py-2 text-sm text-[var(--stor-ink)] outline-none data-[highlighted]:bg-[var(--stor-surface-muted)]" onSelect={onEdit}><IconPencil class="h-4 w-4" /> Edit photo</DropdownMenu.Item>
                                    <DropdownMenu.Item class="flex cursor-default items-center gap-2 px-3 py-2 text-sm text-[var(--stor-negative)] outline-none data-[highlighted]:bg-[var(--stor-surface-muted)]" onSelect={onRemove}><IconDelete class="h-4 w-4" /> Remove photo</DropdownMenu.Item>
                                </CommandOnly>
                            </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                {/snippet}
                {#snippet thumb(item)}
                    {@const shown = film.find((photo) => photo.id === item.id)}
                    {#if shown}<PhotoThumb photo={shown} {tenantId} {logId} />{/if}
                {/snippet}
                {#snippet detailsExtra()}
                    {#if albums.length}
                        <dl class="viewer-albums">
                            <dt>Albums</dt>
                            <dd>
                                {#each albums as album (album.id)}
                                    <button type="button" class="viewer-chip" onclick={() => onOpenAlbum(album.id)}>{album.title}</button>
                                {/each}
                            </dd>
                        </dl>
                    {/if}
                {/snippet}
            </ViewerFrame>
        </Dialog.Content>
    </Dialog.Portal>
</Dialog.Root>

<style>
    .favorite { color: #ff8f8a !important; }
    .desktop-only { display: none !important; }
    :global(.viewer-button.phone-only) { display: grid; }
    @media (min-width: 640px) {
        .desktop-only { display: grid !important; }
        :global(.viewer-button.phone-only) { display: none !important; }
    }
    .viewer-albums { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 9px 14px; margin: 0; }
    .viewer-albums dt { color: rgb(238 242 246 / 0.48); font-size: 10.5px; font-weight: 600; letter-spacing: 0.07em; line-height: 1.7; text-transform: uppercase; }
    .viewer-albums dd { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; }
    .viewer-chip { border: 0; border-radius: 999px; background: rgb(255 255 255 / 0.1); padding: 5px 10px; color: #eef2f6; font-size: 11.5px; font-weight: 600; line-height: 1; }
    .viewer-chip:hover { background: rgb(255 255 255 / 0.18); }
    .viewer-chip:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
</style>
