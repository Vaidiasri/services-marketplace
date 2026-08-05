import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { RequestScopeMiddleware } from './common/request-scope.middleware';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { PermissionsGuard } from './rbac/permissions.guard';
import { RbacModule } from './rbac/rbac.module';

@Module({
  imports: [
    PrismaModule,
    RbacModule,
    AuthModule,
    ThrottlerModule.forRoot([{ name: 'default', limit: 120, ttl: 60_000 }]),
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Order is load-bearing, not cosmetic. Nest runs global guards in registration
    // order: throttle first so a flood is rejected before any database work, then
    // JwtAuthGuard to attach the caller, then PermissionsGuard which needs that caller.
    // Reversed, PermissionsGuard sees no caller and 401s everything.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestScopeMiddleware).forRoutes('*');
  }
}
