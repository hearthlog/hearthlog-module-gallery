const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function gallerySelectionToken(searchParams: URLSearchParams): string {
    const token = searchParams.get('selection') ?? '';
    return UUID.test(token) ? token : '';
}

function key(tenantId: string, logId: string, token: string): string {
    return `stor:gallery-selection:${tenantId}:${logId}:${token}`;
}

export function readGallerySelection(storage: Storage, tenantId: string, logId: string, token: string): Set<string> {
    if (!UUID.test(token) || !tenantId || !logId) return new Set();
    try {
        const value: unknown = JSON.parse(storage.getItem(key(tenantId, logId, token)) ?? '[]');
        if (!Array.isArray(value) || value.length > 10_000 || value.some((id) => typeof id !== 'string' || !UUID.test(id))) return new Set();
        return new Set(value);
    } catch { return new Set(); }
}

export function writeGallerySelection(storage: Storage, tenantId: string, logId: string, token: string, photoIds: Set<string>): void {
    if (!UUID.test(token) || !tenantId || !logId || photoIds.size > 10_000) return;
    try { storage.setItem(key(tenantId, logId, token), JSON.stringify([...photoIds])); }
    catch { /* Selection remains usable in this tab when storage is unavailable. */ }
}
