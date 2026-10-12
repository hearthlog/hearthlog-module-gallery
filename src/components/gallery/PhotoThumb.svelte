<script lang="ts">
    import type { GalleryPhoto } from '@hearthlog/sdk/data';
    import { galleryRendition } from '../../gallery/file-store.js';

    let { photo, tenantId, logId }: { photo: GalleryPhoto; tenantId: string; logId: string } = $props();

    let url = $state('');

    $effect(() => {
        if (!tenantId || !logId) return;
        let cancelled = false;
        let objectUrl = '';
        void galleryRendition({ tenantId, logId, photoId: photo.id, fileVersionId: photo.file_version_id }, 'thumbnail').then((blob) => {
            if (cancelled) return;
            objectUrl = URL.createObjectURL(blob);
            url = objectUrl;
        }).catch(() => undefined);
        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            url = '';
        };
    });
</script>

{#if url}<img src={url} alt="" draggable="false" class="h-full w-full object-cover" />{/if}
