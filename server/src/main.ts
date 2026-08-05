// First import, deliberately: PrismaClient throws at construction if DATABASE_URL
// is absent, and @prisma/client does not read .env itself (only the Prisma CLI does).
// On Render the platform injects the real values and this is a no-op.
import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { isOriginAllowed } from './common/cors';
import { ensureUploadDir } from './vendors/upload.config';

// Comma-separated origins. Never a bare '*': that cannot carry credentials, and the
// refresh cookie in M1 depends on credentialed cross-origin requests.
//
// A single '*' inside an entry is allowed and matches one DNS label, so
// "https://*.vercel.app" covers every alias of the deployed client. Vercel mints a
// new per-deployment hostname on every push, so an exact-only allowlist breaks the
// client each time the API is not also redeployed.
function allowedOrigins(): string[] {
  return (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const origins = allowedOrigins();

  // Needed to read the httpOnly refresh cookie on /auth/refresh and /auth/logout.
  app.use(cookieParser());
  // Render and Vercel both terminate TLS upstream, so without this Express sees the
  // request as http and refuses to set a `secure` cookie - the refresh cookie would
  // silently never reach the browser in production.
  app.set('trust proxy', 1);

  app.enableCors({
    // A callback rather than the array form, so wildcard entries work. An absent
    // Origin (curl, server-to-server, same-origin) is allowed through; the browser
    // only enforces this for cross-origin requests anyway.
    origin: (origin: string | undefined, cb: (e: Error | null, ok?: boolean) => void) =>
      cb(null, !origin || isOriginAllowed(origin, origins)),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  });

  // Created at boot rather than on first upload, so a permissions problem on the volume
  // surfaces in the deploy log instead of as a 500 for the first vendor who tries.
  ensureUploadDir();

  const port = Number(process.env.PORT ?? 3000);
  // 0.0.0.0, not localhost - Render's proxy cannot reach a loopback-only bind.
  await app.listen(port, '0.0.0.0');
  console.log(`[api] listening on ${port}, cors: ${origins.join(', ')}`);
}

void bootstrap();
