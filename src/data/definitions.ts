/**
 * Gallery's persisted entities. Their names, tables, event prefixes, and
 * fields are deployed data contracts: never rename them.
 */

import type { EntityDefinition } from '@hearthlog/sdk/entities';

export const ENTITY_DEFINITIONS: EntityDefinition[] = [
    {
        name: 'gallery_photo',
        feature: 'gallery',
        displayName: 'Photo',
        table: 'gallery_photos',
        fileReference: { versionField: 'file_version_id' },
        fields: [
            { name: 'file_version_id', type: 'string', required: true },
            { name: 'filename', type: 'string', required: true },
            { name: 'content_type', type: 'string', required: true },
            { name: 'byte_size', type: 'number', required: true },
            { name: 'width', type: 'number', required: true },
            { name: 'height', type: 'number', required: true },
            { name: 'captured_at', type: 'string', default: '' },
            { name: 'imported_at', type: 'string', required: true },
            { name: 'timeline_day', type: 'string', required: true },
            { name: 'caption', type: 'string', default: '' },
            { name: 'favorite', type: 'boolean', default: 0 },
            // Camera metadata read from the original's EXIF at import.
            { name: 'camera_make', type: 'string', default: '', optionalInPayload: true },
            { name: 'camera_model', type: 'string', default: '', optionalInPayload: true },
            { name: 'lens_model', type: 'string', default: '', optionalInPayload: true },
            { name: 'focal_length', type: 'number', default: 0, optionalInPayload: true },
            { name: 'f_number', type: 'number', default: 0, optionalInPayload: true },
            { name: 'exposure_time', type: 'number', default: 0, optionalInPayload: true },
            { name: 'iso', type: 'number', default: 0, optionalInPayload: true },
            { name: 'latitude', type: 'number', optionalInPayload: true },
            { name: 'longitude', type: 'number', optionalInPayload: true },
        ],
        indexes: [
            { name: 'gallery_photos_timeline_idx', columns: [
                'tenant_id', 'log_id', 'timeline_day', 'imported_at', 'id',
            ] },
            { name: 'gallery_photos_favorite_idx', columns: [
                'tenant_id', 'log_id', 'favorite', 'timeline_day', 'imported_at', 'id',
            ] },
        ],
    },
    {
        name: 'gallery_album',
        feature: 'gallery',
        displayName: 'Album',
        table: 'gallery_albums',
        fields: [
            { name: 'title', type: 'string', required: true },
            { name: 'description', type: 'string', default: '' },
            { name: 'cover_photo_id', type: 'string', default: '' },
        ],
        indexes: [
            { name: 'gallery_albums_title_idx', columns: ['tenant_id', 'log_id', 'title', 'id'] },
        ],
    },
    {
        name: 'gallery_album_photo',
        feature: 'gallery',
        displayName: 'Album photo',
        table: 'gallery_album_photos',
        fields: [
            { name: 'album_id', type: 'string', required: true },
            { name: 'photo_id', type: 'string', required: true },
            { name: 'added_at', type: 'string', required: true },
        ],
        indexes: [
            { name: 'gallery_album_photos_album_idx', columns: ['tenant_id', 'log_id', 'album_id', 'added_at', 'id'] },
            { name: 'gallery_album_photos_photo_idx', columns: ['tenant_id', 'log_id', 'photo_id', 'album_id'] },
        ],
    },
    {
        name: 'gallery_publication',
        feature: 'gallery',
        displayName: 'Gallery publication',
        table: 'gallery_publications',
        fields: [
            { name: 'owner_log_id', type: 'string', required: true },
            { name: 'title', type: 'string', required: true },
            { name: 'description', type: 'string', default: '' },
            { name: 'revision_id', type: 'string', required: true },
            { name: 'requested_at', type: 'string', required: true },
            { name: 'last_operation', type: 'string', default: 'publish' },
        ],
        indexes: [
            { name: 'gallery_publications_owner_idx', columns: ['tenant_id', 'log_id', 'owner_log_id', 'requested_at', 'id'] },
        ],
    },
];
