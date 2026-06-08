import { Controller, Get, Header } from '@nestjs/common';
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

  @Get('qr')
  @Header('Content-Type', 'text/html')
  getQr(): string {
    const qr = this.whatsappService.getLatestQr();
    if (!qr) {
      return `
        <!DOCTYPE html>
        <html>
          <head>
            <title>WhatsApp QR</title>
            <meta http-equiv="refresh" content="5">
          </head>
          <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f0f2f5;">
            <div style="text-align: center; padding: 40px; background: white; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.1); max-width: 400px;">
              <h2 style="color: #1d1d1f; margin-top: 0;">WhatsApp Status</h2>
              <p style="color: #86868b; line-height: 1.5;">The system is already connected to WhatsApp, or the QR code is still generating.</p>
              <p style="color: #86868b; font-size: 0.9em; margin-bottom: 0;">This page will auto-refresh every 5 seconds.</p>
            </div>
          </body>
        </html>
      `;
    }

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Scan WhatsApp QR</title>
          <script src="https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js"></script>
        </head>
        <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f0f2f5;">
          <div style="text-align: center; padding: 40px; background: white; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.1);">
            <h2 style="color: #1d1d1f; margin-top: 0; margin-bottom: 24px;">Scan to connect WhatsApp</h2>
            <div style="padding: 16px; background: #fff; border-radius: 8px; border: 1px solid #e5e5ea; display: inline-block;">
              <canvas id="canvas"></canvas>
            </div>
            <p style="color: #86868b; margin-top: 24px; margin-bottom: 0;">Waiting for connection...</p>
            <script>
              QRCode.toCanvas(document.getElementById('canvas'), '${qr}', {
                width: 256,
                margin: 2,
                color: {
                  dark: '#000000',
                  light: '#ffffff'
                }
              }, function (error) {
                if (error) console.error(error)
              })
              
              // Auto refresh to check status every 5 seconds
              setTimeout(() => {
                window.location.reload();
              }, 5000);
            </script>
          </div>
        </body>
      </html>
    `;
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
