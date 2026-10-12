<script lang="ts">
    import { onMount } from 'svelte';
    import type { GalleryPhoto } from '@hearthlog/sdk/data';
    import { formatTileDay } from '../../gallery/format.js';
    import GalleryTile from './view/GalleryTile.svelte';
    import {
        galleryRendition,
        galleryUploadState,
        type GalleryFileScope,
    } from '../../gallery/file-store.js';
    import IconImage from '~icons/mdi/image-outline';
    import IconCloudUpload from '~icons/mdi/cloud-upload-outline';
    import IconHeart from '~icons/mdi/heart';

    let {
        photo,
        tenantId,
        logId,
        width,
        height,
        onOpen,
        onSelect,
        selected = false,
        selectable = false,
    }: {
        photo: GalleryPhoto;
        tenantId: string;
        logId: string;
        /** The tile's size in its row. */
        width: number;
        height: number;
        onOpen: () => void;
        /** The check in the corner selects the photo, and starts selecting. */
        onSelect: () => void;
        selected?: boolean;
        selectable?: boolean;
    } = $props();

    let target = $state<HTMLElement>();
    let visible = $state(false);
    let url = $state('');
    let status = $state<'pending' | 'needs_attention' | 'remote' | 'unavailable'>('remote');
    let transferRevision = $state(0);
    let offline = $state(false);
    const scope = $derived<GalleryFileScope>({ tenantId, logId, photoId: photo.id, fileVersionId: photo.file_version_id });
    const statusId = $derived(`gallery-status-${photo.id}`);

    onMount(() => {
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) { visible = true; observer.disconnect(); }
        }, { rootMargin: '400px' });
        if (target) observer.observe(target);
        const transferred = (event: Event) => {
            if ((event as CustomEvent<string>).detail === photo.id) transferRevision += 1;
        };
        // Another device may finish uploading after this tile first asked.
        const retry = () => {
            if (status === 'unavailable') transferRevision += 1;
        };
        window.addEventListener('stor:gallery-transfer', transferred);
        window.addEventListener('online', retry);
        window.addEventListener('focus', retry);
        return () => {
            observer.disconnect();
            window.removeEventListener('stor:gallery-transfer', transferred);
            window.removeEventListener('online', retry);
            window.removeEventListener('focus', retry);
        };
    });

    $effect(() => {
        if (!visible || !scope.tenantId || !scope.logId) return;
        void transferRevision;
        let cancelled = false;
        let objectUrl = '';
        void Promise.all([galleryUploadState(scope), galleryRendition(scope, 'thumbnail')]).then(([upload, blob]) => {
            if (cancelled) return;
            objectUrl = URL.createObjectURL(blob);
            url = objectUrl;
            status = upload?.state ?? 'remote';
        }).catch(() => {
            if (!cancelled) {
                status = 'unavailable';
                offline = !navigator.onLine;
            }
        });
        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            url = '';
        };
    });
</script>

<GalleryTile
    bind:element={target}
    data-photo-id={photo.id}
    src={url}
    alt={photo.caption || photo.filename}
    label={`${selectable ? 'Select' : 'Open'} ${photo.filename}`}
    size={{ width, height }}
    day={formatTileDay(photo.timeline_day)}
    checkable
    {selectable}
    {selected}
    aria-describedby={status === 'pending' || status === 'needs_attention' || status === 'unavailable' ? statusId : undefined}
    onOpen={() => onOpen()}
    {onSelect}
>
    {#snippet overlay()}
        {#if !url && status === 'unavailable'}<span class="gallery-missing"><IconImage /></span>{/if}
        {#if photo.favorite}<span class="gallery-favorite" aria-hidden="true"><IconHeart /></span>{/if}
        {#if status === 'pending'}
            <span id={statusId} title="Saved on this device" class="gallery-badge">
                <IconCloudUpload /><span class="sr-only">Saved on this device</span><span aria-hidden="true" class="gallery-badge-text">Saved on this device</span>
            </span>
        {:else if status === 'needs_attention' || status === 'unavailable'}
            <span id={statusId} class="gallery-badge">
                {status === 'needs_attention' ? 'Needs attention' : offline ? 'Available when online' : 'Not uploaded yet'}
            </span>
        {/if}
    {/snippet}
</GalleryTile>

<style>
    .gallery-missing { position: absolute; inset: 0; display: grid; place-items: center; color: var(--stor-muted-text); }
    .gallery-missing :global(svg) { width: 24px; height: 24px; }
    .gallery-favorite {
        position: absolute;
        right: 7px;
        bottom: 6px;
        z-index: 1;
        color: #fff;
        filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.45));
    }
    .gallery-favorite :global(svg) { display: block; width: 16px; height: 16px; }
    .gallery-badge {
        position: absolute;
        bottom: 6px;
        left: 6px;
        z-index: 1;
        display: inline-flex;
        max-width: calc(100% - 12px);
        height: 24px;
        align-items: center;
        gap: 4px;
        overflow: hidden;
        border-radius: 999px;
        background: var(--stor-surface-raised);
        padding: 0 7px;
        box-shadow: var(--stor-shadow-sm);
        color: var(--stor-ink);
        font-size: 11px;
        font-weight: 600;
        white-space: nowrap;
    }
    .gallery-badge :global(svg) { width: 16px; height: 16px; flex: none; }
    .gallery-badge-text { display: none; }
    @media (hover: hover) {
        :global(.gallery-tile:hover) .gallery-badge-text { display: inline; }
    }
    :global(.gallery-tile:focus-visible) .gallery-badge-text { display: inline; }
</style>
