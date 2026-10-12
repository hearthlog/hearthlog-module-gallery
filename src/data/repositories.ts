/** Gallery's read repository, added to `queryDatabase` by the composer. */

import type { ReadModelSession } from '@hearthlog/sdk/data';
import { createGalleryRepository } from './gallery.js';

export function createRepositories(session: ReadModelSession) {
    return { gallery: createGalleryRepository(session) };
}
