import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';

const app = new Elysia()
  .use(cors())
  .get('/health', () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }))
  .listen(Number(process.env.PORT) ?? 3000);

console.log(`Ledger API running on :${app.server?.port}`);
