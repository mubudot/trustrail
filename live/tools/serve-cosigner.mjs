import { loadCosignerConfig } from '../src/cosigner-config.mjs';
import { createCosignerService } from '../src/cosigner-service.mjs';

const server = createCosignerService({ config: loadCosignerConfig(process.env.TRUSTRAIL_COSIGNER_CONFIG),
  token: process.env.TRUSTRAIL_COSIGNER_TOKEN });
server.listen(Number(process.env.TRUSTRAIL_COSIGNER_PORT ?? 4410), process.env.TRUSTRAIL_COSIGNER_HOST ?? '127.0.0.1', () => {
  console.error('TrustRail co-signer listening');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeIdleConnections(); });
