import { Global, Module } from '@nestjs/common';
import { PermissionResolver } from './permission-resolver.service';
import { PermissionsGuard } from './permissions.guard';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

// Global so every feature module can use the guard and the resolver without
// re-importing - a module that forgets the import would otherwise fail at runtime with
// an injection error rather than at compile time.
@Global()
@Module({
  controllers: [RolesController],
  providers: [PermissionResolver, PermissionsGuard, RolesService],
  exports: [PermissionResolver, PermissionsGuard, RolesService],
})
export class RbacModule {}
