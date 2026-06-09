import { Module } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { D1Module } from '../d1/d1.module';

@Module({
  imports: [D1Module],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
