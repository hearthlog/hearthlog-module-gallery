<script lang="ts">
    import { galleryRendition, type GalleryFileScope } from '../../gallery/file-store.js';

    let { tenantId, logId, photoId, fileVersionId, alt }: {
        tenantId: string;
        logId: string;
        photoId: string;
        fileVersionId: string;
        alt: string;
    } = $props();
    let url = $state('');
    const scope = $derived<GalleryFileScope>({ tenantId, logId, photoId, fileVersionId });

    $effect(() => {
        if (!scope.tenantId || !scope.logId) return;
        let cancelled = false;
        let objectUrl = '';
        void galleryRendition(scope, 'thumbnail').then((blob) => {
            if (cancelled) return;
            objectUrl = URL.createObjectURL(blob);
            url = objectUrl;
        }).catch(() => { if (!cancelled) url = ''; });
        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            url = '';
        };
    });
</script>

<div class="h-full w-full overflow-hidden rounded-lg bg-[var(--stor-surface-muted)]">
    {#if url}<img src={url} {alt} class="h-full w-full object-cover" loading="lazy" />{/if}
</div>
