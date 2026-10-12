import { format } from 'date-fns';
import { formatNumber } from '@hearthlog/sdk/format';
import { formatFileSize } from '@hearthlog/sdk/format';

export interface PhotoDetailSource {
    captured_at: string;
    timeline_day: string;
    camera_make: string;
    camera_model: string;
    lens_model: string;
    focal_length: number;
    f_number: number;
    exposure_time: number;
    iso: number;
    latitude: number | null;
    longitude: number | null;
    width: number;
    height: number;
    byte_size: number;
}

/** Capture time in the camera's own wall-clock time; the import day without one. */
export function formatPhotoDate(photo: Pick<PhotoDetailSource, 'captured_at' | 'timeline_day'>): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(photo.captured_at || photo.timeline_day);
    if (!match) return '';
    const [, year, month, day, hour, minute] = match;
    const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0));
    return hour === undefined ? format(date, 'd MMMM yyyy') : format(date, 'd MMMM yyyy, HH:mm');
}

export function formatCamera(photo: Pick<PhotoDetailSource, 'camera_make' | 'camera_model'>): string {
    return [photo.camera_make, photo.camera_model].filter(Boolean).join(' ');
}

/** `ƒ/1.8 · 1/120 s · ISO 50 · 26 mm` from whichever values the camera recorded. */
export function formatExposure(photo: Pick<PhotoDetailSource, 'f_number' | 'exposure_time' | 'iso' | 'focal_length'>): string {
    const parts: string[] = [];
    if (photo.f_number > 0) parts.push(`ƒ/${formatNumber(photo.f_number, 1)}`);
    if (photo.exposure_time > 0) {
        parts.push(photo.exposure_time >= 1
            ? `${formatNumber(photo.exposure_time, 1)} s`
            : `1/${Math.round(1 / photo.exposure_time)} s`);
    }
    if (photo.iso > 0) parts.push(`ISO ${photo.iso}`);
    if (photo.focal_length > 0) parts.push(`${formatNumber(photo.focal_length, 1)} mm`);
    return parts.join(' · ');
}

export function formatPhotoFile(photo: Pick<PhotoDetailSource, 'width' | 'height' | 'byte_size'>): string {
    const dimensions = photo.width > 0 && photo.height > 0 ? `${photo.width} × ${photo.height}` : '';
    return [dimensions, photo.byte_size > 0 ? formatFileSize(photo.byte_size) : ''].filter(Boolean).join(' · ');
}

export function formatCoordinates(photo: Pick<PhotoDetailSource, 'latitude' | 'longitude'>): string {
    if (photo.latitude === null || photo.longitude === null) return '';
    const latitude = `${Math.abs(photo.latitude).toFixed(4)}° ${photo.latitude < 0 ? 'S' : 'N'}`;
    const longitude = `${Math.abs(photo.longitude).toFixed(4)}° ${photo.longitude < 0 ? 'W' : 'E'}`;
    return `${latitude}, ${longitude}`;
}

export function mapHref(photo: Pick<PhotoDetailSource, 'latitude' | 'longitude'>): string {
    if (photo.latitude === null || photo.longitude === null) return '';
    return `https://www.openstreetmap.org/?mlat=${photo.latitude}&mlon=${photo.longitude}#map=15/${photo.latitude}/${photo.longitude}`;
}

export interface PhotoDetailRow {
    label: string;
    value: string;
    /** A link that opens the value elsewhere, such as a map. */
    href?: string;
}

/** The camera, exposure, file, and location lines the viewer lists, leaving out any it lacks. */
export function photoDetailRows(photo: PhotoDetailSource, options: { file?: boolean } = {}): PhotoDetailRow[] {
    const rows: PhotoDetailRow[] = [];
    const camera = [formatCamera(photo), photo.lens_model].filter(Boolean).join(' · ');
    if (camera) rows.push({ label: 'Camera', value: camera });
    const exposure = formatExposure(photo);
    if (exposure) rows.push({ label: 'Exposure', value: exposure });
    if (options.file ?? true) {
        const file = formatPhotoFile(photo);
        if (file) rows.push({ label: 'File', value: file });
    }
    const location = formatCoordinates(photo);
    if (location) rows.push({ label: 'Location', value: location, href: mapHref(photo) });
    return rows;
}

/** `June` and `2024` for a `2024-06` month. */
export function formatMonthParts(month: string): { name: string; year: string } {
    return { name: format(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1), 'MMMM'), year: month.slice(0, 4) };
}

export function formatPhotoCount(count: number): string {
    return `${formatNumber(count)} ${count === 1 ? 'photo' : 'photos'}`;
}

/** `Sat 14 Jun` for a `yyyy-MM-dd` day. */
export function formatTileDay(day: string): string {
    return format(new Date(`${day.slice(0, 10)}T12:00:00`), 'EEE d MMM');
}
