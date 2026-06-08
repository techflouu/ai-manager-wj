import { Module } from '@nestjs/common';
import { SlaService } from './sla.service';
import { D1Module } from '../d1/d1.module';

@Module({
  imports: [D1Module],
  providers: [SlaService],
  exports: [SlaService],
})
export class SlaModule {}
