import { queryDatabase } from '@hearthlog/sdk/data';
import { requireActiveContext } from '@hearthlog/sdk/runtime';
import { galleryPhotoCommands, galleryAlbumCommands, galleryAlbumPhotoCommands } from '@hearthlog/sdk/data';
import { galleryOriginal, stageGalleryOriginal, discardStagedGalleryOriginal, triggerGalleryTransfers } from './file-store.js';
import { createGalleryArchive, readGalleryArchive, type GalleryBackupManifest, type GalleryBackupPhoto } from './backup-archive.js';

const BLOB_DOWNLOAD_LIMIT = 512 * 1024 * 1024;

interface ArchiveWriter {
    write(part: Blob): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
}

interface SaveHandle { createWritable(): Promise<ArchiveWriter> }

function backupName(): string { return `stor-gallery-${new Date().toISOString().slice(0, 10)}.tar`; }

/** Invoked directly from a click so the browser's file picker keeps user activation. */
export async function exportGalleryBackup(onProgress: (message: string) => void): Promise<number> {
    const picker = (window as Window & {
        showSaveFilePicker?: (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<SaveHandle>;
    }).showSaveFilePicker;
    const handlePromise = picker?.call(window, {
        suggestedName: backupName(),
        types: [{ description: 'Gallery backup', accept: { 'application/x-tar': ['.tar'] } }],
    });
    const writer = handlePromise ? await (await handlePromise).createWritable() : null;
    try {
        const context = await requireActiveContext();
        const snapshot = await queryDatabase((repositories) => repositories.gallery.exportSnapshot());
        if (snapshot.photos.length === 0) throw new Error('There are no photos to back up.');
        const manifest: Omit<GalleryBackupManifest, 'photos'> & { photos: Array<Omit<GalleryBackupPhoto, 'sha256'>> } = {
            format: 'stor-gallery', version: 1, exportedAt: new Date().toISOString(),
            photos: snapshot.photos.map((photo) => ({
                id: photo.id, fileVersionId: photo.file_version_id, filename: photo.filename,
                contentType: photo.content_type, byteSize: photo.byte_size, width: photo.width,
                height: photo.height, capturedAt: photo.captured_at, importedAt: photo.imported_at,
                timelineDay: photo.timeline_day, caption: photo.caption, favorite: Boolean(photo.favorite),
                cameraMake: photo.camera_make, cameraModel: photo.camera_model,
                lensModel: photo.lens_model, focalLength: photo.focal_length, fNumber: photo.f_number,
                exposureTime: photo.exposure_time, iso: photo.iso,
                latitude: photo.latitude, longitude: photo.longitude,
            })),
            albums: snapshot.albums.map((album) => ({
                id: album.id, title: album.title, description: album.description,
                coverPhotoId: album.cover_photo_id,
            })),
            memberships: snapshot.memberships.map((member) => ({
                albumId: member.album_id, photoId: member.photo_id, addedAt: member.added_at,
            })),
        };
        const parts: Blob[] = [];
        let bytes = 0;
        let completed = 0;
        for await (const part of createGalleryArchive(manifest, async (photo) => {
            onProgress(`Backing up ${completed + 1} of ${manifest.photos.length} photos…`);
            const blob = await galleryOriginal({
                tenantId: context.tenantId, logId: context.logId,
                photoId: photo.id, fileVersionId: photo.fileVersionId,
            }, { cache: false });
            completed += 1;
            return blob;
        })) {
            if (writer) await writer.write(part);
            else {
                bytes += part.size;
                if (bytes > BLOB_DOWNLOAD_LIMIT) {
                    throw new Error('This backup is too large for a browser download. Use a browser with Save file support.');
                }
                parts.push(part);
            }
        }
        if (writer) await writer.close();
        else {
            const url = URL.createObjectURL(new Blob(parts, { type: 'application/x-tar' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = backupName();
            link.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        }
        return completed;
    } catch (cause) {
        await writer?.abort().catch(() => undefined);
        throw cause;
    }
}

/** Validate all bytes first, then append fresh events into the active log. */
export async function restoreGalleryBackup(file: File, onProgress: (message: string) => void): Promise<{
    photos: number; albums: number;
}> {
    const archive = await readGalleryArchive(file);
    const { manifest } = archive;
    if (manifest.photos.length === 0) throw new Error('This backup contains no photos.');
    for (let index = 0; index < manifest.photos.length; index += 1) {
        onProgress(`Checking ${index + 1} of ${manifest.photos.length} originals…`);
        await archive.original(manifest.photos[index]);
    }
    const context = await requireActiveContext();
    const photoIds = new Map(manifest.photos.map((photo) => [photo.id, crypto.randomUUID()]));
    const albumIds = new Map(manifest.albums.map((album) => [album.id, crypto.randomUUID()]));
    let restored = 0;
    try {
        for (const photo of manifest.photos) {
            onProgress(`Restoring ${restored + 1} of ${manifest.photos.length} photos…`);
            const id = photoIds.get(photo.id)!;
            const fileVersionId = crypto.randomUUID();
            const scope = { tenantId: context.tenantId, logId: context.logId, photoId: id, fileVersionId };
            const blob = await archive.original(photo);
            await stageGalleryOriginal(scope, new File([blob], photo.filename, { type: photo.contentType }));
            try {
                const { sha256: _digest, ...metadata } = photo;
                await galleryPhotoCommands.create({ ...metadata, id, fileVersionId }, { submissionId: crypto.randomUUID() });
            } catch (cause) {
                await discardStagedGalleryOriginal(scope);
                throw cause;
            }
            restored += 1;
        }
        for (const album of manifest.albums) {
            await galleryAlbumCommands.create({
                id: albumIds.get(album.id)!, title: album.title,
                description: album.description, coverPhotoId: photoIds.get(album.coverPhotoId) ?? '',
            }, { submissionId: crypto.randomUUID() });
        }
        for (const member of manifest.memberships) {
            await galleryAlbumPhotoCommands.create({
                id: crypto.randomUUID(), albumId: albumIds.get(member.albumId)!,
                photoId: photoIds.get(member.photoId)!, addedAt: member.addedAt,
            }, { submissionId: crypto.randomUUID() });
        }
    } catch (cause) {
        throw new Error(`${restored} photos were restored before the backup stopped. ${cause instanceof Error ? cause.message : 'Restore failed.'}`);
    } finally {
        triggerGalleryTransfers();
    }
    return { photos: restored, albums: manifest.albums.length };
}
