import type { PublicGalleryPhotoDetails } from '../../public/contract.js';
import { formatCamera, type PhotoDetailSource } from './format.js';

/** What a published gallery shows about each photo; every switch starts on. */
export interface PublicDetailSwitches {
    camera: boolean;
    date: boolean;
    location: boolean;
}

export const SHARE_ALL_DETAILS: PublicDetailSwitches = { camera: true, date: true, location: true };

type PrivateDetails = Pick<PhotoDetailSource,
    'captured_at' | 'timeline_day' | 'camera_make' | 'camera_model' | 'lens_model'
    | 'f_number' | 'exposure_time' | 'iso' | 'focal_length' | 'latitude' | 'longitude'>;

const CAPTURED = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/;

/**
 * The details a photo publishes under the owner's switches. The date is the
 * camera's capture time, or the day the photo sits on the private timeline.
 */
export function publicPhotoDetails(photo: PrivateDetails, switches: PublicDetailSwitches): PublicGalleryPhotoDetails {
    const details: PublicGalleryPhotoDetails = {};
    if (switches.date) {
        const captured = CAPTURED.exec(photo.captured_at || '');
        const takenAt = captured ? (captured[2] ? `${captured[1]}T${captured[2]}` : captured[1]) : CAPTURED.exec(photo.timeline_day)?.[1];
        if (takenAt) details.takenAt = takenAt;
    }
    if (switches.camera) {
        const camera = formatCamera(photo).slice(0, 120);
        if (camera) details.camera = camera;
        if (photo.lens_model) details.lens = photo.lens_model.slice(0, 120);
        if (photo.f_number > 0) details.fNumber = photo.f_number;
        if (photo.exposure_time > 0) details.exposureTime = photo.exposure_time;
        if (photo.iso > 0) details.iso = photo.iso;
        if (photo.focal_length > 0) details.focalLength = photo.focal_length;
    }
    if (switches.location && photo.latitude !== null && photo.longitude !== null) {
        details.latitude = photo.latitude;
        details.longitude = photo.longitude;
    }
    return details;
}

/** The switches an earlier review used, read from what its photos published. */
export function detailSwitchesFrom(photos: readonly PublicGalleryPhotoDetails[]): PublicDetailSwitches {
    return {
        camera: photos.some((photo) => photo.camera || photo.lens || photo.fNumber || photo.exposureTime || photo.iso || photo.focalLength),
        date: photos.some((photo) => photo.takenAt),
        location: photos.some((photo) => photo.latitude !== undefined),
    };
}

/** Published details in the shape the shared formatters read. */
export function publicDetailSource(photo: PublicGalleryPhotoDetails & { width: number; height: number }): PhotoDetailSource {
    return {
        captured_at: photo.takenAt?.includes('T') ? photo.takenAt : '',
        timeline_day: photo.takenAt?.slice(0, 10) ?? '',
        camera_make: '',
        camera_model: photo.camera ?? '',
        lens_model: photo.lens ?? '',
        focal_length: photo.focalLength ?? 0,
        f_number: photo.fNumber ?? 0,
        exposure_time: photo.exposureTime ?? 0,
        iso: photo.iso ?? 0,
        latitude: photo.latitude ?? null,
        longitude: photo.longitude ?? null,
        width: photo.width,
        height: photo.height,
        byte_size: 0,
    };
}
