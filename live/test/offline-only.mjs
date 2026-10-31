// Preloaded by the runner regression test: any accidental outbound connection fails the suite.
import { Socket } from 'node:net';
Socket.prototype.connect = () => { throw new Error('offline_network_forbidden'); };
globalThis.fetch = async () => { throw new Error('offline_network_forbidden'); };
