import { LedgerScopeError, type LedgerScopeEnv } from '@hearthlog/sdk/server';

/** Check the exact immutable file version against accepted Ledger history. */
export async function verifyGalleryPhotoReference(
    logId: string,
    photoId: string,
    fileVersionId: string,
    env: LedgerScopeEnv,
): Promise<void> {
    let response: Response;
    try {
        response = await env.LEDGER.fetch(new Request(
            `https://ledger.internal/logs/${encodeURIComponent(logId)}/gallery-photos/${encodeURIComponent(photoId)}/files/${encodeURIComponent(fileVersionId)}/reference`,
            { headers: { Authorization: `Bearer ${env.LEDGER_AUTH_TOKEN}` } },
        ));
    } catch {
        throw unavailableError();
    }
    if (response.status === 404) {
        throw new LedgerScopeError(404, 'log_not_found', 'The selected log was not found');
    }
    if (response.status === 409) {
        throw new LedgerScopeError(409, 'fork_preparing', 'The selected fork is preparing');
    }
    if (!response.ok) throw unavailableError();
    let value: unknown;
    try {
        value = await response.json();
    } catch {
        throw unavailableError();
    }
    if (!value || typeof value !== 'object' || !('present' in value) || typeof value.present !== 'boolean') {
        throw unavailableError();
    }
    if (!value.present) {
        throw new LedgerScopeError(404, 'gallery_file_not_referenced', 'Photo version not found in this log');
    }
}

function unavailableError(): LedgerScopeError {
    return new LedgerScopeError(503, 'ledger_verification_failed', 'The selected log could not be verified');
}
