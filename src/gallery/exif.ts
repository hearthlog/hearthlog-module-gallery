/**
 * Minimal EXIF reader for Gallery imports. It reads only the capture and
 * camera fields the Gallery stores, from JPEG, PNG, WebP, and HEIC/HEIF
 * originals. Malformed or missing metadata yields empty fields, never an error.
 */

export interface PhotoMetadata {
    /** `YYYY-MM-DDTHH:mm:ss`, with a UTC offset when the camera recorded one. */
    capturedAt: string;
    /** Calendar day of the capture in the camera's local time. */
    capturedDay: string;
    cameraMake: string;
    cameraModel: string;
    lensModel: string;
    /** Millimetres. */
    focalLength: number;
    fNumber: number;
    /** Seconds. */
    exposureTime: number;
    iso: number;
    latitude: number | null;
    longitude: number | null;
}

export const EMPTY_PHOTO_METADATA: PhotoMetadata = {
    capturedAt: '', capturedDay: '', cameraMake: '', cameraModel: '', lensModel: '',
    focalLength: 0, fNumber: 0, exposureTime: 0, iso: 0, latitude: null, longitude: null,
};

const TAGS = {
    make: 0x010f,
    model: 0x0110,
    dateTime: 0x0132,
    exifIfd: 0x8769,
    gpsIfd: 0x8825,
    exposureTime: 0x829a,
    fNumber: 0x829d,
    iso: 0x8827,
    dateTimeOriginal: 0x9003,
    dateTimeDigitized: 0x9004,
    offsetTimeOriginal: 0x9011,
    focalLength: 0x920a,
    lensModel: 0xa434,
    gpsLatitudeRef: 1,
    gpsLatitude: 2,
    gpsLongitudeRef: 3,
    gpsLongitude: 4,
} as const;

const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

type TagValue = string | number[];

export function readPhotoMetadata(bytes: Uint8Array): PhotoMetadata {
    try {
        const tiff = findTiff(bytes);
        return tiff === null ? { ...EMPTY_PHOTO_METADATA } : parseTiff(bytes, tiff);
    } catch {
        return { ...EMPTY_PHOTO_METADATA };
    }
}

function findTiff(bytes: Uint8Array): number | null {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return findJpegTiff(bytes);
    if (ascii(bytes, 1, 'PNG')) return findChunkTiff(bytes, 8, 'eXIf', 'big');
    if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return findChunkTiff(bytes, 12, 'EXIF', 'little');
    // HEIC/HEIF store an `Exif` item whose payload is `Exif\0\0` + TIFF.
    const marker = [0x45, 0x78, 0x69, 0x66, 0, 0];
    for (let index = 0; index + 10 <= bytes.length; index += 1) {
        if (marker.every((byte, offset) => bytes[index + offset] === byte) && isTiffHeader(bytes, index + 6)) {
            return index + 6;
        }
    }
    return null;
}

function findJpegTiff(bytes: Uint8Array): number | null {
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
        const marker = bytes[offset + 1];
        if (marker === 0xda || marker === 0xd9) return null;
        const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
        if (marker === 0xe1 && ascii(bytes, offset + 4, 'Exif\0\0') && isTiffHeader(bytes, offset + 10)) {
            return offset + 10;
        }
        offset += 2 + length;
    }
    return null;
}

function findChunkTiff(bytes: Uint8Array, start: number, type: string, sizeOrder: 'big' | 'little'): number | null {
    // PNG chunks are length + type + data + CRC; RIFF chunks are type + length + data (+ pad).
    let offset = start;
    while (offset + 8 <= bytes.length) {
        const png = sizeOrder === 'big';
        const size = png ? readUint32(bytes, offset, false) : readUint32(bytes, offset + 4, true);
        const chunkType = png ? offset + 4 : offset;
        const data = offset + 8;
        if (ascii(bytes, chunkType, type)) {
            if (isTiffHeader(bytes, data)) return data;
            if (ascii(bytes, data, 'Exif\0\0') && isTiffHeader(bytes, data + 6)) return data + 6;
            return null;
        }
        offset = data + size + (png ? 4 : size % 2);
    }
    return null;
}

function parseTiff(bytes: Uint8Array, tiff: number): PhotoMetadata {
    const little = bytes[tiff] === 0x49;
    const ifd0 = readIfd(bytes, tiff, readUint32(bytes, tiff + 4, little), little);
    const exifOffset = numberAt(ifd0.get(TAGS.exifIfd));
    const gpsOffset = numberAt(ifd0.get(TAGS.gpsIfd));
    const exif = exifOffset ? readIfd(bytes, tiff, exifOffset, little) : new Map<number, TagValue>();
    const gps = gpsOffset ? readIfd(bytes, tiff, gpsOffset, little) : new Map<number, TagValue>();

    const captured = exifDate(
        text(exif.get(TAGS.dateTimeOriginal)) || text(exif.get(TAGS.dateTimeDigitized)) || text(ifd0.get(TAGS.dateTime)),
        text(exif.get(TAGS.offsetTimeOriginal)),
    );
    const make = text(ifd0.get(TAGS.make));
    let model = text(ifd0.get(TAGS.model));
    // Many cameras repeat the make inside the model ("Canon Canon EOS R6").
    if (make && model.toLowerCase().startsWith(make.toLowerCase())) model = model.slice(make.length).trim();

    return {
        capturedAt: captured.at,
        capturedDay: captured.day,
        cameraMake: make,
        cameraModel: model,
        lensModel: text(exif.get(TAGS.lensModel)),
        focalLength: rounded(numberAt(exif.get(TAGS.focalLength)), 1),
        fNumber: rounded(numberAt(exif.get(TAGS.fNumber)), 1),
        exposureTime: rounded(numberAt(exif.get(TAGS.exposureTime)), 6),
        iso: Math.round(numberAt(exif.get(TAGS.iso))),
        latitude: coordinate(gps.get(TAGS.gpsLatitude), text(gps.get(TAGS.gpsLatitudeRef)), 'S', 90),
        longitude: coordinate(gps.get(TAGS.gpsLongitude), text(gps.get(TAGS.gpsLongitudeRef)), 'W', 180),
    };
}

function readIfd(bytes: Uint8Array, tiff: number, offset: number, little: boolean): Map<number, TagValue> {
    const values = new Map<number, TagValue>();
    const start = tiff + offset;
    if (offset <= 0 || start + 2 > bytes.length) return values;
    const count = readUint16(bytes, start, little);
    for (let index = 0; index < count; index += 1) {
        const entry = start + 2 + index * 12;
        if (entry + 12 > bytes.length) break;
        const tag = readUint16(bytes, entry, little);
        const type = readUint16(bytes, entry + 2, little);
        const items = readUint32(bytes, entry + 4, little);
        const size = TYPE_SIZES[type];
        if (!size || items > 1024) continue;
        const valueOffset = size * items <= 4 ? entry + 8 : tiff + readUint32(bytes, entry + 8, little);
        if (valueOffset + size * items > bytes.length) continue;
        values.set(tag, readValue(bytes, valueOffset, type, items, little));
    }
    return values;
}

function readValue(bytes: Uint8Array, offset: number, type: number, items: number, little: boolean): TagValue {
    if (type === 2) {
        let value = '';
        for (let index = 0; index < items && bytes[offset + index] !== 0; index += 1) {
            value += String.fromCharCode(bytes[offset + index]);
        }
        return value.trim();
    }
    const values: number[] = [];
    for (let index = 0; index < items; index += 1) {
        const at = offset + index * TYPE_SIZES[type];
        if (type === 1 || type === 7) values.push(bytes[at]);
        else if (type === 3) values.push(readUint16(bytes, at, little));
        else if (type === 4) values.push(readUint32(bytes, at, little));
        else if (type === 9) values.push(readUint32(bytes, at, little) | 0);
        else {
            const signed = type === 10;
            const numerator = signed ? readUint32(bytes, at, little) | 0 : readUint32(bytes, at, little);
            const denominator = signed ? readUint32(bytes, at + 4, little) | 0 : readUint32(bytes, at + 4, little);
            values.push(denominator === 0 ? 0 : numerator / denominator);
        }
    }
    return values;
}

function exifDate(value: string, offset: string): { at: string; day: string } {
    const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value);
    if (!match) return { at: '', day: '' };
    const [, year, month, day, hour, minute, second] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
    if (Number(year) < 1900 || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) {
        return { at: '', day: '' };
    }
    const zone = /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : '';
    return { at: `${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`, day: `${year}-${month}-${day}` };
}

function coordinate(value: TagValue | undefined, ref: string, negative: string, limit: number): number | null {
    if (!Array.isArray(value) || value.length === 0) return null;
    const [degrees = 0, minutes = 0, seconds = 0] = value;
    const decimal = degrees + minutes / 60 + seconds / 3600;
    if (!Number.isFinite(decimal) || decimal > limit || (decimal === 0 && !ref)) return null;
    return rounded(ref.toUpperCase() === negative ? -decimal : decimal, 6);
}

function text(value: TagValue | undefined): string {
    return typeof value === 'string' ? value : '';
}

function numberAt(value: TagValue | undefined): number {
    return Array.isArray(value) && Number.isFinite(value[0]) ? value[0] : 0;
}

function rounded(value: number, digits: number): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function isTiffHeader(bytes: Uint8Array, offset: number): boolean {
    return (bytes[offset] === 0x49 && bytes[offset + 1] === 0x49 && bytes[offset + 2] === 0x2a && bytes[offset + 3] === 0)
        || (bytes[offset] === 0x4d && bytes[offset + 1] === 0x4d && bytes[offset + 2] === 0 && bytes[offset + 3] === 0x2a);
}

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        if (bytes[offset + index] !== value.charCodeAt(index)) return false;
    }
    return true;
}

function readUint16(bytes: Uint8Array, offset: number, little: boolean): number {
    return little ? bytes[offset] | (bytes[offset + 1] << 8) : (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32(bytes: Uint8Array, offset: number, little: boolean): number {
    const value = little
        ? bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)
        : (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    return value >>> 0;
}
