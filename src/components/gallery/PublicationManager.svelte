<script lang="ts">
    import { queryDatabase } from '@hearthlog/sdk/data';
    import type { GalleryPhoto, GalleryPublication } from '@hearthlog/sdk/data';
    import { galleryPublicationCommands } from '@hearthlog/sdk/data';
    import { refreshPageData } from '@hearthlog/sdk/runtime';
    import { syncAndWait } from '@hearthlog/sdk/runtime';
    import { notify } from '@hearthlog/sdk/runtime';
    import {
        cleanupPublicRevision, publicationRevision, publicationStatus, publishGallery, unpublishGallery,
        type PublicationReview, type PublicationReviewPhoto, type PublicationStatus,
    } from '../../gallery/publication-api.js';
    import { Button } from "@hearthlog/sdk/ui";
    import { Input } from "@hearthlog/sdk/ui";
    import { Textarea } from "@hearthlog/sdk/ui";
    import { Checkbox } from "@hearthlog/sdk/ui";
    import JustifiedRows from './view/JustifiedRows.svelte';
    import { tileRatio } from '../../gallery/layout.js';
    import { galleryGeometry } from '../../gallery/timeline.js';
    import {
        detailSwitchesFrom, publicPhotoDetails, SHARE_ALL_DETAILS, type PublicDetailSwitches,
    } from '../../gallery/public-details.js';
    import { CommandDrawer } from "@hearthlog/sdk/ui";
    import { CommandConfirmDialog } from "@hearthlog/sdk/ui";
    import { CommandOnly } from "@hearthlog/sdk/ui";
    import { EmptyState } from "@hearthlog/sdk/ui";
    import PublicationPreviewPhoto from './PublicationPreviewPhoto.svelte';
    import IconImage from '~icons/mdi/image-multiple-outline';
    import IconLink from '~icons/mdi/link-variant';
    import IconArrowUp from '~icons/mdi/arrow-up';
    import IconArrowDown from '~icons/mdi/arrow-down';
    import IconClose from '~icons/mdi/close';

    export interface PublicationSource {
        albumId?: string;
        photoIds?: string[];
        title: string;
        description: string;
    }

    interface DraftPhoto extends PublicationReviewPhoto {
        filename: string;
        /** The private photo, whose details the switches publish. */
        source: GalleryPhoto;
    }
    interface PendingPublish { publicationId: string; revision: string; review: PublicationReview }

    let { tenantId, logId, revision, source, showList, onCloseSource }: {
        tenantId: string;
        logId: string;
        revision: number;
        source: PublicationSource | null;
        showList: boolean;
        onCloseSource: () => void;
    } = $props();

    let publications = $state<GalleryPublication[]>([]);
    let statuses = $state<Record<string, PublicationStatus>>({});
    let draftOpen = $state(false);
    let draftLoading = $state(false);
    let draftError = $state('');
    let draftTitle = $state('');
    let draftDescription = $state('');
    let draftPhotos = $state<DraftPhoto[]>([]);
    let targetId = $state('');
    let pending = $state<PendingPublish | null>(null);
    let busy = $state(false);
    let progress = $state('');
    let unpublishId = $state('');
    let existingTitle = $state('');
    let previewMode = $state<'desktop' | 'phone'>('desktop');
    let previewWidth = $state(0);
    let shareDetails = $state<PublicDetailSwitches>({ ...SHARE_ALL_DETAILS });
    const previewGeometry = $derived(galleryGeometry(previewWidth, 1));
    let reviewPage = $state(0);
    const reviewPageSize = 60;
    const reviewPages = $derived(Math.ceil(draftPhotos.length / reviewPageSize));
    const visibleReviewPhotos = $derived(draftPhotos.slice(reviewPage * reviewPageSize, (reviewPage + 1) * reviewPageSize));

    $effect(() => {
        if (!tenantId || !logId) return;
        void revision;
        let cancelled = false;
        void queryDatabase((repositories) => repositories.gallery.publications()).then(async (rows) => {
            if (cancelled) return;
            publications = rows;
            const resolved = await Promise.allSettled(rows.map((row) => publicationStatus(logId, row.id)));
            if (cancelled) return;
            const next: Record<string, PublicationStatus> = {};
            resolved.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    next[rows[index].id] = result.value;
                    if (!draftOpen && !busy) void cleanRetired(result.value);
                }
            });
            statuses = next;
        }).catch(() => { if (!cancelled) notify.error('Could not load shared galleries'); });
        return () => { cancelled = true; };
    });

    $effect(() => {
        const requested = source;
        if (!requested || !tenantId || !logId) return;
        let cancelled = false;
        draftOpen = true;
        draftLoading = true;
        draftError = '';
        draftTitle = requested.title;
        draftDescription = requested.description;
        draftPhotos = [];
        shareDetails = { ...SHARE_ALL_DETAILS };
        previewMode = typeof window !== 'undefined' && window.innerWidth < 640 ? 'phone' : 'desktop';
        reviewPage = 0;
        targetId = '';
        pending = null;
        void queryDatabase((repositories) => requested.albumId
            ? repositories.gallery.publicationAlbumPhotos(requested.albumId)
            : repositories.gallery.publicationSelectedPhotos(requested.photoIds ?? [], 'time')).then((photos) => {
            if (cancelled) return;
            if (photos.length === 0) throw new Error('Choose at least one photo to share.');
            if (photos.length > 10_000) throw new Error('A public gallery can contain up to 10,000 photos.');
            if (requested.photoIds && photos.length !== requested.photoIds.length) throw new Error('Some selected photos are no longer in this log.');
            draftPhotos = photos.map(toDraftPhoto);
            draftLoading = false;
        }).catch((cause) => {
            if (cancelled) return;
            draftLoading = false;
            draftError = cause instanceof Error ? cause.message : 'Photos could not be loaded.';
        });
        return () => { cancelled = true; };
    });

    function toDraftPhoto(photo: GalleryPhoto): DraftPhoto {
        return {
            photoId: photo.id, fileVersionId: photo.file_version_id,
            filename: photo.filename, caption: '', alt: 'Photo',
            width: Math.max(1, photo.width), height: Math.max(1, photo.height),
            source: photo,
        };
    }

    function closeDraft() {
        if (busy) return;
        draftOpen = false;
        draftError = '';
        pending = null;
        onCloseSource();
    }

    function movePhoto(index: number, direction: -1 | 1) {
        if (pending) return;
        const destination = index + direction;
        if (destination < 0 || destination >= draftPhotos.length) return;
        const next = [...draftPhotos];
        [next[index], next[destination]] = [next[destination], next[index]];
        draftPhotos = next;
    }

    function removePhoto(index: number) {
        if (pending) return;
        draftPhotos = draftPhotos.filter((_, position) => position !== index);
        if (reviewPage > 0 && reviewPage * reviewPageSize >= draftPhotos.length) reviewPage -= 1;
    }

    async function editPublication(row: GalleryPublication) {
        draftOpen = true;
        draftLoading = true;
        draftError = '';
        pending = null;
        targetId = row.id;
        onCloseSource();
        try {
            const review = await publicationRevision(logId, row.id, row.revision_id);
            const photos = await queryDatabase((repositories) => repositories.gallery.publicationSelectedPhotos(review.photos.map((photo) => photo.photoId)));
            if (photos.length !== review.photos.length) throw new Error('Some shared photos are no longer in this log. Start a new review from an album.');
            draftTitle = review.title;
            draftDescription = review.description;
            shareDetails = detailSwitchesFrom(review.photos);
            draftPhotos = photos.map((photo, index) => ({
                photoId: review.photos[index].photoId, fileVersionId: review.photos[index].fileVersionId,
                caption: review.photos[index].caption, alt: review.photos[index].alt,
                width: review.photos[index].width, height: review.photos[index].height,
                filename: photo.filename, source: photo,
            }));
            reviewPage = 0;
        } catch (cause) { draftError = cause instanceof Error ? cause.message : 'This review could not be loaded.'; }
        finally { draftLoading = false; }
    }

    async function publish() {
        if (busy || draftLoading) return;
        if (!navigator.onLine) { draftError = 'Connect to the internet before publishing.'; return; }
        if (!draftTitle.trim()) { draftError = 'Enter a public title.'; return; }
        if (draftPhotos.length === 0) { draftError = 'Choose at least one photo.'; return; }
        if (draftPhotos.some((photo) => !photo.alt.trim())) { draftError = 'Add a description for every photo.'; return; }
        busy = true;
        draftError = '';
        try {
            if (!pending) {
                const publicationId = targetId || crypto.randomUUID();
                const nextRevision = crypto.randomUUID();
                const review: PublicationReview = {
                    title: draftTitle.trim(), description: draftDescription.trim(),
                    photos: draftPhotos.map((photo) => ({
                        photoId: photo.photoId, fileVersionId: photo.fileVersionId,
                        caption: photo.caption.trim(), alt: photo.alt.trim(), width: photo.width, height: photo.height,
                        ...publicPhotoDetails(photo.source, shareDetails),
                    })),
                };
                const intent = {
                    id: publicationId, ownerLogId: logId, title: review.title,
                    description: review.description, revisionId: nextRevision,
                    requestedAt: new Date().toISOString(), lastOperation: 'publish',
                };
                if (targetId) await galleryPublicationCommands.update(intent, { submissionId: crypto.randomUUID() });
                else await galleryPublicationCommands.create(intent, { submissionId: crypto.randomUUID() });
                pending = { publicationId, revision: nextRevision, review };
            }
            progress = 'Syncing review…';
            await syncAndWait();
            const attempt = pending;
            if (!attempt) throw new Error('The review changed while publishing. Retry from Shared galleries.');
            const status = await publishGallery(logId, attempt.publicationId, attempt.revision, attempt.review,
                (completed, total) => progress = `Preparing photos ${completed} of ${total}…`);
            statuses = { ...statuses, [attempt.publicationId]: status };
            void cleanRetired(status);
            progress = '';
            pending = null;
            draftOpen = false;
            onCloseSource();
            await refreshPageData('app:gallery');
            notify.success('Public gallery is ready');
        } catch (cause) {
            progress = '';
            draftError = cause instanceof Error ? cause.message : 'The gallery could not be published.';
        } finally { busy = false; }
    }

    async function unpublish() {
        const id = unpublishId;
        if (!id || busy) return;
        if (!navigator.onLine) { notify.error('Connect to the internet before unpublishing'); return; }
        busy = true;
        try {
            await galleryPublicationCommands.update({
                id, lastOperation: 'unpublish', requestedAt: new Date().toISOString(),
            }, { submissionId: crypto.randomUUID() });
            await syncAndWait();
            const status = await unpublishGallery(logId, id);
            statuses = { ...statuses, [id]: status };
            void cleanRetired(status);
            unpublishId = '';
            await refreshPageData('app:gallery');
            notify.success('Gallery unpublished');
        } catch (cause) { notify.error(cause instanceof Error ? cause.message : 'Gallery could not be unpublished'); }
        finally { busy = false; }
    }

    async function copyLink(url: string) {
        try { await navigator.clipboard.writeText(url); notify.success('Link copied'); }
        catch { notify.error('Could not copy the link'); }
    }

    async function cleanRetired(status: PublicationStatus) {
        for (const revisionId of status.cleanupRevisions ?? []) {
            try {
                for (let batch = 0; batch < 100; batch += 1) {
                    const result = await cleanupPublicRevision(logId, status.publicationId, revisionId);
                    if (!result.remaining) break;
                }
            } catch {
                // The marker remains durable. The Shared tab retries cleanup later.
            }
        }
    }
</script>

{#if showList}
    {#if publications.length === 0}
        <EmptyState icon={IconImage} title="No shared galleries" description="Select photos or open an album to prepare an unlisted public gallery." />
    {:else}
        <div class="stor-panel divide-y divide-[var(--stor-border)] px-3 sm:px-4">
            {#each publications as item (item.id)}
                <div class="flex flex-wrap items-center gap-3 py-4">
                    <div class="min-w-0 flex-1">
                        <h2 class="truncate font-medium text-[var(--stor-ink)]">{item.title}</h2>
                        <p class="text-sm text-[var(--stor-muted-text)]">{statuses[item.id]?.activeRevision ? 'Anyone with link' : statuses[item.id] ? 'Unpublished' : 'Checking status…'}</p>
                    </div>
                    <CommandOnly><Button variant="secondary" onclick={() => void editPublication(item)}>Review update</Button></CommandOnly>
                    {#if statuses[item.id]?.activeRevision}
                        <Button variant="ghost" onclick={() => void copyLink(statuses[item.id].publicUrl)}><IconLink class="h-4 w-4" /> Copy link</Button>
                        <a class="inline-flex h-11 items-center rounded-xl px-3 text-sm text-[var(--stor-ink)] hover:bg-[var(--stor-surface-muted)] sm:h-9" href={statuses[item.id].publicUrl} target="_blank" rel="noopener noreferrer">View</a>
                        <CommandOnly><Button variant="ghost" onclick={() => { unpublishId = item.id; existingTitle = item.title; }}>Unpublish</Button></CommandOnly>
                    {/if}
                </div>
            {/each}
        </div>
    {/if}
{/if}

<CommandDrawer show={draftOpen} title={targetId ? 'Review public update' : 'Publish gallery'} description="Anyone with the link can view and save these photos." size="lg" onClose={closeDraft}>
    <div class="space-y-5 text-sm text-[var(--stor-ink)]">
        {#if draftLoading}<p role="status">Loading review…</p>{/if}
        {#if !draftLoading && draftPhotos.length > 0}
            <div class="space-y-3">
                <label class="block font-medium">Public title<Input bind:value={draftTitle} maxlength={120} class="mt-1" disabled={busy || Boolean(pending)} /></label>
                <label class="block font-medium">Description<Textarea bind:value={draftDescription} maxlength={500} class="mt-1" disabled={busy || Boolean(pending)} /></label>
                <fieldset class="space-y-1">
                    <legend class="font-medium">Photo details</legend>
                    <p class="text-[var(--stor-muted-text)]">Visitors see these in the photo viewer. Location is where the camera recorded each photo.</p>
                    <label class="flex min-h-11 items-center gap-3 sm:min-h-9"><Checkbox checked={shareDetails.camera} disabled={busy || Boolean(pending)} onCheckedChange={(checked) => shareDetails.camera = checked === true} /> Camera and exposure</label>
                    <label class="flex min-h-11 items-center gap-3 sm:min-h-9"><Checkbox checked={shareDetails.date} disabled={busy || Boolean(pending)} onCheckedChange={(checked) => shareDetails.date = checked === true} /> Date taken</label>
                    <label class="flex min-h-11 items-center gap-3 sm:min-h-9"><Checkbox checked={shareDetails.location} disabled={busy || Boolean(pending)} onCheckedChange={(checked) => shareDetails.location = checked === true} /> Location</label>
                </fieldset>
                {#if !targetId && publications.length > 0}
                    <label class="block font-medium">Publish as
                        <select bind:value={targetId} disabled={busy || Boolean(pending)} class="mt-1 h-11 w-full rounded-xl border border-[var(--stor-field-border)] bg-[var(--stor-surface-muted)] px-3 text-[var(--stor-ink)] sm:h-9">
                            <option value="">New public gallery</option>
                            {#each publications as item (item.id)}<option value={item.id}>Update {item.title}</option>{/each}
                        </select>
                    </label>
                {/if}
            </div>
            <div>
                <div class="flex flex-wrap items-center justify-between gap-2">
                    <h3 class="font-medium">Public preview · {draftPhotos.length} {draftPhotos.length === 1 ? 'photo' : 'photos'}</h3>
                    <div class="flex gap-1 rounded-full bg-[var(--stor-surface-muted)] p-1" role="group" aria-label="Preview width">
                        <button type="button" class={`rounded-full px-3 py-1 text-xs text-[var(--stor-ink)] ${previewMode === 'desktop' ? 'bg-[var(--stor-surface-raised)]' : ''}`} aria-pressed={previewMode === 'desktop'} onclick={() => previewMode = 'desktop'}>Desktop</button>
                        <button type="button" class={`rounded-full px-3 py-1 text-xs text-[var(--stor-ink)] ${previewMode === 'phone' ? 'bg-[var(--stor-surface-raised)]' : ''}`} aria-pressed={previewMode === 'phone'} onclick={() => previewMode = 'phone'}>Phone</button>
                    </div>
                </div>
                <p class="mt-1 text-[var(--stor-muted-text)]">Only these resized copies, the text below, and the photo details you keep will be public. The copies carry no embedded metadata; people and places in the pictures stay recognizable.</p>
                {#if reviewPages > 1}
                    <div class="mt-3 flex items-center justify-between gap-2 text-xs text-[var(--stor-muted-text)]">
                        <Button variant="ghost" size="sm" disabled={reviewPage === 0} onclick={() => reviewPage -= 1}>Previous</Button>
                        <span>Review page {reviewPage + 1} of {reviewPages}</span>
                        <Button variant="ghost" size="sm" disabled={reviewPage + 1 >= reviewPages} onclick={() => reviewPage += 1}>Next</Button>
                    </div>
                {/if}
                <div class="preview mt-3" class:phone-preview={previewMode === 'phone'} bind:clientWidth={previewWidth}>
                    {#if reviewPage === 0 && draftPhotos[0]}
                        <div class="preview-cover" style:aspect-ratio={tileRatio(draftPhotos[0])}>
                            <PublicationPreviewPhoto {tenantId} {logId} photoId={draftPhotos[0].photoId} fileVersionId={draftPhotos[0].fileVersionId} alt={draftPhotos[0].alt} />
                            <span class="sr-only">Cover photo</span>
                        </div>
                    {/if}
                    <JustifiedRows items={reviewPage === 0 ? visibleReviewPhotos.slice(1) : visibleReviewPhotos} key={(photo) => photo.photoId} width={previewWidth} rowHeight={previewGeometry.rowHeight} gap={previewGeometry.gap}>
                        {#snippet tile(photo, size)}
                            <div class="preview-photo" style:width={size ? `${size.width}px` : '100%'} style:height={size ? `${size.height}px` : '100%'}>
                                <PublicationPreviewPhoto {tenantId} {logId} photoId={photo.photoId} fileVersionId={photo.fileVersionId} alt={photo.alt} />
                            </div>
                        {/snippet}
                    </JustifiedRows>
                </div>
            </div>
            <div class="space-y-3">
                <h3 class="font-medium">Order and public text</h3>
                {#each visibleReviewPhotos as photo, localIndex (photo.photoId)}
                    {@const index = reviewPage * reviewPageSize + localIndex}
                    <div class="rounded-xl bg-[var(--stor-surface-muted)] p-3">
                        <div class="mb-2 flex items-center gap-2">
                            <span class="min-w-0 flex-1 truncate font-medium">{index + 1}. {photo.filename}{index === 0 ? ' · Cover' : ''}</span>
                            <Button variant="ghost" size="icon" aria-label={`Move ${photo.filename} earlier`} disabled={index === 0 || busy || Boolean(pending)} onclick={() => movePhoto(index, -1)}><IconArrowUp class="h-4 w-4" /></Button>
                            <Button variant="ghost" size="icon" aria-label={`Move ${photo.filename} later`} disabled={index === draftPhotos.length - 1 || busy || Boolean(pending)} onclick={() => movePhoto(index, 1)}><IconArrowDown class="h-4 w-4" /></Button>
                            <Button variant="ghost" size="icon" aria-label={`Exclude ${photo.filename}`} disabled={busy || Boolean(pending)} onclick={() => removePhoto(index)}><IconClose class="h-4 w-4" /></Button>
                        </div>
                        <label class="block text-xs">Public caption<Input bind:value={photo.caption} maxlength={500} class="mt-1" disabled={busy || Boolean(pending)} /></label>
                        <label class="mt-2 block text-xs">Image description<Input bind:value={photo.alt} maxlength={500} class="mt-1" disabled={busy || Boolean(pending)} /></label>
                    </div>
                {/each}
            </div>
            {#if pending && !busy}<Button variant="ghost" onclick={() => { pending = null; draftError = ''; }}>Change review</Button>{/if}
            <div class="flex justify-end"><Button disabled={busy || draftPhotos.length === 0} onclick={() => void publish()}>{busy ? 'Publishing…' : pending ? 'Retry publishing' : targetId ? 'Publish update' : 'Publish unlisted gallery'}</Button></div>
        {/if}
        {#if progress}<p role="status" class="text-[var(--stor-muted-text)]">{progress}</p>{/if}
        {#if draftError}<p role="alert" class="text-[var(--stor-negative)]">{draftError}</p>{/if}
    </div>
</CommandDrawer>

<CommandConfirmDialog show={Boolean(unpublishId)} title="Unpublish gallery?" message={`The public page and its images will stop opening from this link. Copies already saved by visitors remain outside Hearthlog's control.`} confirmLabel="Unpublish" onConfirm={() => void unpublish()} onCancel={() => unpublishId = ''} />

<style>
    .preview { display: grid; gap: 5px; }
    .preview-cover { width: 100%; max-height: 360px; overflow: hidden; border-radius: 8px; }
    .preview-photo { flex: none; overflow: hidden; border-radius: 8px; }
    .preview.phone-preview { max-width: 390px; }
</style>
