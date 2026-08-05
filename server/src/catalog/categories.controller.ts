import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Public } from '../auth/jwt-auth.guard';
import { zodBody } from '../common/zod.pipe';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CategoriesService } from './categories.service';
import {
  CategoryQuerySchema,
  CreateCategorySchema,
  UpdateCategorySchema,
  type CategoryQuery,
  type CreateCategoryDto,
  type UpdateCategoryDto,
} from './catalog.dto';

/**
 * Categories are admin-owned; vendors only ever reference them. That is what keeps a
 * vendor from creating categories inside another vendor's part of the taxonomy - there is
 * no such thing as a vendor's part of it.
 */
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  /**
   * Public and unfiltered by `isActive`: the admin console needs to see inactive
   * categories to reactivate them, and an inactive category is not confidential. The
   * client filters for display; only *creating a service* rejects an inactive one.
   */
  @Get()
  @Public()
  list(@Query(zodBody(CategoryQuerySchema)) query: CategoryQuery) {
    return this.categories.list(query.flat);
  }

  @Post()
  @RequirePermissions('category.create')
  @HttpCode(201)
  create(@Body(zodBody(CreateCategorySchema)) dto: CreateCategoryDto) {
    return this.categories.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('category.update')
  update(
    @Param('id') id: string,
    @Body(zodBody(UpdateCategorySchema)) dto: UpdateCategoryDto,
  ) {
    return this.categories.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('category.delete')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.categories.remove(id);
  }
}
