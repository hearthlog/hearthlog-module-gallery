import { fetchAccessProtected } from '@hearthlog/sdk/runtime';
import type { PublicGalleryPhotoDetails } from '../../public/contract.js';

/** A photo as reviewed, with the details the owner kept switched on. */
export interface PublicationReviewPhoto extends PublicGalleryPhotoDetails {
    photoId: string;
    fileVersionId: string;
    caption: string;
    alt: string;
    width: number;
    height: number;
}

export interface PublicationReview {
    title: string;
    description: string;
    photos: PublicationReviewPhoto[];
}

export interface PublicationStatus {
    publicationId: string;
    activeRevision: string | null;
    publicUrl: string;
    cleanupRevisions?: string[];
}

function endpoint(logId: string, publicationId: string): string {
    return `/api/gallery-publications/v1/logs/${encodeURIComponent(logId)}/publications/${encodeURIComponent(publicationId)}`;
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchAccessProtected(url, init);
    const value = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) throw new Error(value?.error ?? 'The public gallery request failed.');
    if (!value || typeof value !== 'object') throw new Error('The public gallery response was unavailable.');
    return value as T;
}

export function publicationStatus(logId: string, publicationId: string): Promise<PublicationStatus> {
    return request(endpoint(logId, publicationId));
}

export function publicationRevision(logId: string, publicationId: string, revision: string): Promise<PublicationReview> {
    return request(`${endpoint(logId, publicationId)}/revisions/${encodeURIComponent(revision)}`);
}

export async function publishGallery(
    logId: string, publicationId: string, revision: string, review: PublicationReview,
    onProgress?: (completed: number, total: number) => void,
): Promise<PublicationStatus> {
    const base = `${endpoint(logId, publicationId)}/revisions/${encodeURIComponent(revision)}`;
    const staged = await request<{ chunks: number }>(base, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(review),
    });
    for (let chunk = 0; chunk < staged.chunks; chunk += 1) {
        await request(`${base}/chunks/${chunk}`, { method: 'POST' });
        onProgress?.(chunk + 1, staged.chunks);
    }
    return request(`${base}/activate`, { method: 'POST' });
}

export function unpublishGallery(logId: string, publicationId: string): Promise<PublicationStatus> {
    return request(`${endpoint(logId, publicationId)}/unpublish`, { method: 'POST' });
}

export function cleanupPublicRevision(logId: string, publicationId: string, revision: string): Promise<{ remaining: boolean; deleted: number }> {
    return request(`${endpoint(logId, publicationId)}/revisions/${encodeURIComponent(revision)}/cleanup`, { method: 'POST' });
}
