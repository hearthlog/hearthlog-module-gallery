/** A file of the browser bundle, served by the Worker from memory. */
export interface ClientAsset {
    path: string;
    body: string;
    type: string;
}

export interface ClientAssets {
    script: ClientAsset | null;
    styles: ClientAsset[];
}

/**
 * The browser bundle. The Worker build replaces this module with the built
 * files; without them (in unit tests) pages render without scripts.
 */
export const clientAssets: ClientAssets = { script: null, styles: [] };
