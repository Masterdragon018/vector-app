import pkg from '../../package.json';

/* Versión de la app: única fuente de verdad = package.json (bump en cada cambio). */
export const APP_VERSION: string = pkg.version;
