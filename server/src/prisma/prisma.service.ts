import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit(): Promise<void> {
    // Deliberately not fatal. A cold Neon instance can refuse the first
    // connection, and an API that refuses to boot because the database was
    // asleep is the "deployed application that errors on load" deduction.
    // /health reports db: "down" instead.
    try {
      await this.$connect();
    } catch (err) {
      console.error('[prisma] initial connect failed', err);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
