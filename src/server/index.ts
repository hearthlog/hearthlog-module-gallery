import type { ServerModule } from '@hearthlog/sdk/server';
import { handleGalleryFileRequest } from './files.js';
import { handleGalleryPublicationRequest, sweepGalleryPublications } from './publications.js';

/** Gallery's part of the gateway Worker: private photo files, publications, and the daily sweep of public copies. */
const gallery: ServerModule<Env> = {
    id: 'org.stor.gallery',
    routes: [
        { prefix: '/api/gallery-files/v1', handle: handleGalleryFileRequest },
        { prefix: '/api/gallery-publications/v1', handle: handleGalleryPublicationRequest },
    ],
    async scheduled(env) {
        const result = await sweepGalleryPublications(env);
        console.log('[Gallery] Publication sweep', result);
    },
};

export default gallery;
