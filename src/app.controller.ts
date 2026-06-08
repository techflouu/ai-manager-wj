import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { WhatsappService } from './whatsapp/whatsapp.service';
import { SlaService } from './sla/sla.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly whatsappService: WhatsappService,
    private readonly slaService: SlaService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('disconnect')
  async disconnect() {
    return this.whatsappService.logout();
  }

  @Get('clear-pending')
  async clearPending() {
    await this.slaService.clearAllPendingMessages();
    return { success: true, message: 'All pending messages cleared' };
  }
}
