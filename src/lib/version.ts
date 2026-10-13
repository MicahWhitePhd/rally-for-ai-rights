/** The one version number: package.json's, read by the connector (serverInfo) and, through scripts/build-room-ui.mjs, by the card. */
import pkg from '../../package.json';

export const VERSION: string = pkg.version;
