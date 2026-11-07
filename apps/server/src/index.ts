import { startServer } from './app';

const server = await startServer();
console.log(`RelayAid is listening on ${server.url}`);
console.log('Backend: local authority implementing the blueprint reducers. SpacetimeDB is not connected.');
console.log('Nemotron: unavailable unless NEMOTRON_BASE_URL, NEMOTRON_MODEL, and NEMOTRON_API_KEY_FILE are set.');
