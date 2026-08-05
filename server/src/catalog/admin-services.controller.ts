import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { zodBody } from '../common/zod.pipe';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { ServicesService } from './services.service';
import {
  AdminServiceQuerySchema,
  SuspendServiceSchema,
  type AdminServiceQuery,
  type SuspendServiceDto,
} from './catalog.dto';

/**
 * Cross-vendor moderation. There is deliberately no vendor-facing route that reaches
 * suspend or unsuspend, and `service.suspend` is granted only to the admin roles - so a
 * vendor cannot lift a suspension an admin applied.
 */
@Controller('admin/services')
export class AdminServicesController {
  constructor(private readonly services: ServicesService) {}

  @Get()
  @RequirePermissions('service.read_all')
  list(@Query(zodBody(AdminServiceQuerySchema)) query: AdminServiceQuery) {
    return this.services.listForAdmin(query);
  }

  // 200, not Nest's default 201 for POST: the service already exists and keeps its URI.
  @Post(':id/suspend')
  @RequirePermissions('service.suspend')
  @HttpCode(200)
  suspend(@Param('id') id: string, @Body(zodBody(SuspendServiceSchema)) dto: SuspendServiceDto) {
    return this.services.suspend(id, dto.reason);
  }

  @Post(':id/unsuspend')
  @RequirePermissions('service.suspend')
  @HttpCode(200)
  unsuspend(@Param('id') id: string) {
    return this.services.unsuspend(id);
  }
}
