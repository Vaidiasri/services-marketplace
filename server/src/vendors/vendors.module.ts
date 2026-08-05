import { Module } from '@nestjs/common';
import { AdminVendorsController } from './admin-vendors.controller';
import { ApprovedVendorGuard } from './approved-vendor.guard';
import { VendorsController } from './vendors.controller';
import { VendorsService } from './vendors.service';

@Module({
  controllers: [VendorsController, AdminVendorsController],
  // ApprovedVendorGuard is provided here and registered globally in AppModule, so any
  // future module can use @RequireApprovedVendor() without importing anything.
  providers: [VendorsService, ApprovedVendorGuard],
  exports: [VendorsService, ApprovedVendorGuard],
})
export class VendorsModule {}
