import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { WhatsappService } from './whatsapp/whatsapp.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly whatsappService: WhatsappService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('disconnect')
  async disconnect() {
    return this.whatsappService.logout();
  }
}
