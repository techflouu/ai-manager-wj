import { Module } from '@nestjs/common';
import { SlaService } from './sla.service';

@Module({
  providers: [SlaService],
  exports: [SlaService],
})
export class SlaModule {}
