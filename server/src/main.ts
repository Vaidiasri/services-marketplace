// First import, deliberately: PrismaClient throws at construction if DATABASE_URL
// is absent, and @prisma/client does not read .env itself (only the Prisma CLI does).
// On Render the platform injects the real values and this is a no-op.
import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

// Comma-separated exact origins. Never '*': a wildcard cannot carry credentials,
// and the refresh cookie in M1 depends on credentialed cross-origin requests.
function allowedOrigins(): string[] {
  return (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const origins = allowedOrigins();

  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  });

  const port = Number(process.env.PORT ?? 3000);
  // 0.0.0.0, not localhost - Render's proxy cannot reach a loopback-only bind.
  await app.listen(port, '0.0.0.0');
  console.log(`[api] listening on ${port}, cors: ${origins.join(', ')}`);
}

void bootstrap();
