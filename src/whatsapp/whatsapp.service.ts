import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as qrcode from 'qrcode-terminal';
import pino from 'pino';
import * as fs from 'fs';

@Injectable()
export class WhatsappService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappService.name);
  private sock: ReturnType<typeof makeWASocket>;
  // Toggle this flag to true if you want to see the full JSON of the incoming message
  private readonly logFullMessageJson = false;
  // Toggle this flag to false if you don't want to log the display name
  private readonly logDisplayName = true;

  constructor(private eventEmitter: EventEmitter2) {}

  async onModuleInit() {
    await this.connectToWhatsApp();
  }

  async logout() {
    if (this.sock) {
      this.logger.log('Logging out from WhatsApp...');
      try {
        await this.sock.logout();
      } catch (err) {
        this.logger.error('Error during logout', err);
      }
      this.logger.log('Logged out. You can now scan a new QR code.');
    }
    return { message: 'Disconnected and logged out successfully' };
  }

  async connectToWhatsApp() {
    const { state, saveCreds } =
      await useMultiFileAuthState('auth_info_baileys');

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: false, // We handle it manually with qrcode-terminal
      logger: pino({ level: 'silent' }), // Suppress verbose logs unless needed
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrcode.generate(qr, { small: true });
        this.logger.log('Please scan the QR code above to login to WhatsApp.');
      }

      if (connection === 'close') {
        const shouldReconnect =
          (lastDisconnect?.error as Boom)?.output?.statusCode !==
          Number(DisconnectReason.loggedOut);
        this.logger.log(
          `Connection closed due to ${lastDisconnect?.error}, reconnecting: ${shouldReconnect}`,
        );

        if (shouldReconnect) {
          setTimeout(() => {
            void this.connectToWhatsApp();
          }, 3000); // 3 second delay to prevent stream conflict spam
        } else {
          this.logger.log(
            'Logged out. Clearing session and generating new QR code...',
          );
          try {
            fs.rmSync('auth_info_baileys', { recursive: true, force: true });
          } catch (e) {
            this.logger.error('Failed to delete auth_info_baileys folder', e);
          }

          setTimeout(() => {
            void this.connectToWhatsApp();
          }, 3000);
        }
      } else if (connection === 'open') {
        this.logger.log('WhatsApp connected successfully!');
      }
    });

    this.sock.ev.on('creds.update', () => {
      void saveCreds();
    });

    this.sock.ev.on('messages.upsert', (m) => {
      void (async () => {
        if (m.type === 'notify') {
          for (const msg of m.messages) {
            const jid = msg.key.remoteJid || '';

            if (msg.key.fromMe) {
              // It's a reply from us
              this.eventEmitter.emit('message.replied', { jid });
            } else if (!msg.key.fromMe && msg.message) {
              // Incoming message
              const isGroup = jid.endsWith('@g.us');
              const chatType = isGroup ? 'Group' : 'Private';
              const senderName = msg.pushName || 'Unknown';
              // Prefer participantAlt if it exists (contains real phone number instead of @lid)
              const participantAlt = msg.key.participantAlt;
              const participant = isGroup
                ? participantAlt || msg.key.participant || jid
                : jid;
              const displayString = this.logDisplayName
                ? `${senderName} (${participant})`
                : `${participant}`;

              let chatName = '';
              if (isGroup) {
                try {
                  const groupMetadata = await this.sock.groupMetadata(jid);
                  chatName = groupMetadata.subject;
                } catch (err) {
                  this.logger.warn(
                    `Could not fetch group metadata for ${jid}`,
                    err,
                  );
                }
              }

              // Emit the event to the SLA service
              this.eventEmitter.emit('message.received', {
                jid,
                participant,
                senderName,
                chatType,
                chatName,
              });

              if (this.logFullMessageJson) {
                this.logger.log(
                  `Received [${chatType}] message from ${displayString}: ${JSON.stringify(msg, null, 2)}`,
                );
              } else {
                // Extract the actual text content from the message object
                const textMessage =
                  msg.message.conversation ||
                  msg.message.extendedTextMessage?.text ||
                  msg.message.imageMessage?.caption ||
                  msg.message.videoMessage?.caption ||
                  '[Non-text message]';

                this.logger.log(
                  `Received [${chatType}] message from ${displayString}: ${textMessage}`,
                );
              }
            }
          }
        }
      })();
    });
  }
}
