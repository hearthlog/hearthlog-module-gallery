<script lang="ts">
    import type { GalleryAlbumSummary } from '../../data/gallery.js';
    import { galleryRendition } from '../../gallery/file-store.js';
    import IconImage from '~icons/mdi/image-multiple-outline';

    let { album, tenantId, logId, onOpen }: {
        album: GalleryAlbumSummary;
        tenantId: string;
        logId: string;
        onOpen: () => void;
    } = $props();

    let imageUrl = $state('');
    $effect(() => {
        imageUrl = '';
        if (!album.effective_cover_photo_id || !album.cover_file_version_id || !tenantId || !logId) return;
        let cancelled = false;
        let objectUrl = '';
        void galleryRendition({
            tenantId, logId, photoId: album.effective_cover_photo_id,
            fileVersionId: album.cover_file_version_id,
        }, 'thumbnail').then((blob) => {
            if (cancelled) return;
            objectUrl = URL.createObjectURL(blob);
            imageUrl = objectUrl;
        }).catch(() => undefined);
        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    });
</script>

<button type="button" onclick={onOpen} class="group min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] rounded-xl">
    <span class="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl bg-[var(--stor-surface-muted)] text-[var(--stor-muted-text)]">
        {#if imageUrl}<img src={imageUrl} alt="" class="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.025] motion-reduce:transition-none" />
        {:else}<IconImage class="h-8 w-8" />{/if}
    </span>
    <span class="mt-2 block truncate text-sm font-semibold text-[var(--stor-ink)]">{album.title}</span>
    <span class="block text-xs text-[var(--stor-muted-text)]">{album.photo_count} {album.photo_count === 1 ? 'photo' : 'photos'}</span>
</button>
