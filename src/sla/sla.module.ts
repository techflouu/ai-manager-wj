import { Module } from '@nestjs/common';
import { SlaService } from './sla.service';
import { D1Module } from '../d1/d1.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [D1Module, WhatsappModule],
  providers: [SlaService],
  exports: [SlaService],
})
export class SlaModule {}
