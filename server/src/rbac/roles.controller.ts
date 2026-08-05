import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { zodBody } from '../common/zod.pipe';
import { Errors } from '../common/errors';
import { RequirePermissions } from './require-permissions.decorator';
import { RolesService } from './roles.service';
import {
  AssignRoleSchema,
  CreateRoleSchema,
  UpdateRoleSchema,
  type AssignRoleDto,
  type CreateRoleDto,
  type UpdateRoleDto,
} from './rbac.dto';

@Controller()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('permissions')
  @RequirePermissions('permission.read')
  listPermissions() {
    return this.roles.listPermissions();
  }

  @Get('roles')
  @RequirePermissions('role.read')
  list() {
    return this.roles.list();
  }

  @Get('roles/:id')
  @RequirePermissions('role.read')
  get(@Param('id') id: string) {
    return this.roles.get(id);
  }

  @Post('roles')
  @RequirePermissions('role.create')
  @HttpCode(201)
  create(@Body(zodBody(CreateRoleSchema)) dto: CreateRoleDto, @Req() req: Request) {
    return this.roles.create(dto, caller(req));
  }

  @Patch('roles/:id')
  @RequirePermissions('role.update')
  update(
    @Param('id') id: string,
    @Body(zodBody(UpdateRoleSchema)) dto: UpdateRoleDto,
    @Req() req: Request,
  ) {
    return this.roles.update(id, dto, caller(req));
  }

  /**
   * The route the brief's revocation demo uses: revoke one slug, then the affected
   * user's very next request behaves differently with no redeploy.
   */
  @Delete('roles/:id/permissions/:slug')
  @RequirePermissions('role.update')
  revoke(@Param('id') id: string, @Param('slug') slug: string, @Req() req: Request) {
    return this.roles.revokePermission(id, slug, caller(req));
  }

  @Delete('roles/:id')
  @RequirePermissions('role.delete')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.roles.remove(id);
  }

  @Put('users/:id/role')
  @RequirePermissions('role.assign')
  @HttpCode(204)
  async assign(
    @Param('id') id: string,
    @Body(zodBody(AssignRoleSchema)) dto: AssignRoleDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.roles.assignRole(id, dto.roleId, caller(req));
  }
}

function caller(req: Request) {
  if (!req.caller) throw Errors.unauthenticated();
  return req.caller;
}
