import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Telegraf } from 'telegraf';
import { DateTime } from 'luxon';
import { D1Service, PendingMessage } from '../d1/d1.service';

@Injectable()
export class SlaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SlaService.name);
  private pendingMessages: Map<string, PendingMessage> = new Map();
  private hrPhones: Set<string> = new Set();
  private bot: Telegraf | null = null;

  constructor(
    private configService: ConfigService,
    private d1Service: D1Service,
  ) {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (token) {
      this.bot = new Telegraf(token);
    } else {
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN is not defined. Notifications will not be sent.',
      );
    }
  }

  async onModuleInit() {
    await this.d1Service.createTableIfNotExists();
    await this.loadState();
    this.setupBotCommands();
  }

  onModuleDestroy() {
    if (this.bot) {
      this.bot.stop('SIGINT');
    }
  }

  private setupBotCommands() {
    if (!this.bot) return;

    this.bot.command('list_hr_phones', async (ctx) => {
      if (this.hrPhones.size === 0) {
        await ctx.reply('No HR phone numbers are currently tracked.');
        return;
      }
      const list = Array.from(this.hrPhones)
        .map((p) => `• ${p}`)
        .join('\n');
      await ctx.reply(`Tracked HR Phone Numbers:\n${list}`);
    });

    this.bot.command('add_hr_phone', async (ctx) => {
      const parts = ctx.message.text.split(' ');
      if (parts.length < 2) {
        await ctx.reply(
          'Usage: /add_hr_phone <phone_number>\nExample: /add_hr_phone 6281234567890',
        );
        return;
      }
      const phone = parts[1].replace(/\D/g, ''); // strip non-numeric
      if (!phone) {
        await ctx.reply('Please provide a valid numeric phone number.');
        return;
      }

      this.hrPhones.add(phone);
      try {
        await this.d1Service.addHrPhone(phone);
        await ctx.reply(
          `Successfully added ${phone} to HR phone numbers list.`,
        );
      } catch (err) {
        await ctx.reply('Failed to save to database.');
        this.logger.error('Failed to add HR phone', err);
      }
    });

    this.bot.command('remove_hr_phone', async (ctx) => {
      const parts = ctx.message.text.split(' ');
      if (parts.length < 2) {
        await ctx.reply(
          'Usage: /remove_hr_phone <phone_number>\nExample: /remove_hr_phone 6281234567890',
        );
        return;
      }
      const phone = parts[1].replace(/\D/g, '');

      if (this.hrPhones.has(phone)) {
        this.hrPhones.delete(phone);
        try {
          await this.d1Service.removeHrPhone(phone);
          await ctx.reply(
            `Successfully removed ${phone} from HR phone numbers list.`,
          );
        } catch (e) {
          await ctx.reply('Failed to remove from database.');
          this.logger.error('Failed to remove HR phone', e);
        }
      } else {
        await ctx.reply(`Phone number ${phone} is not in the list.`);
      }
    });

    this.bot.launch().catch((err) => {
      this.logger.error('Failed to launch Telegram bot', err);
    });
  }

  private async loadState() {
    try {
      const messages = await this.d1Service.getAllPendingMessages();
      for (const msg of messages) {
        this.pendingMessages.set(msg.jid, msg);
      }
      this.logger.log(
        `Loaded ${this.pendingMessages.size} pending messages from D1 storage.`,
      );

      const hrPhones = await this.d1Service.getAllHrPhones();
      for (const p of hrPhones) {
        this.hrPhones.add(p);
      }
      this.logger.log(
        `Loaded ${this.hrPhones.size} HR phone numbers from D1 storage.`,
      );
    } catch (e) {
      this.logger.error('Failed to load state from D1', e);
    }
  }

  private getTimezone(): string {
    return this.configService.get<string>('TIMEZONE') || 'UTC+8';
  }

  private calculateDeadline(receivedAt: DateTime): DateTime {
    // Office hours: Mon-Fri, 9am - 6pm.
    const isWeekend = receivedAt.weekday === 6 || receivedAt.weekday === 7;
    const isBeforeOfficeHours = receivedAt.hour < 9;
    const isAfterOfficeHours = receivedAt.hour >= 18;

    let deadline: DateTime;

    if (isWeekend || isBeforeOfficeHours || isAfterOfficeHours) {
      // Outside office hours -> Deadline is next working day 10:00 AM
      deadline = receivedAt.set({
        hour: 10,
        minute: 0,
        second: 0,
        millisecond: 0,
      });

      if (isAfterOfficeHours || isWeekend) {
        // Advance to next day
        deadline = deadline.plus({ days: 1 });
      }

      // If the deadline falls on a weekend, advance to Monday
      while (deadline.weekday === 6 || deadline.weekday === 7) {
        deadline = deadline.plus({ days: 1 });
      }
    } else {
      // During office hours -> strict 2 hours later alarm
      // Set to 5 seconds for testing? No, keep it as in the original code.
      // Original code had: deadline = receivedAt.plus({ seconds: 5 });
      // I will keep the original code behavior.
      deadline = receivedAt.plus({ seconds: 5 });
    }

    return deadline;
  }

  @OnEvent('message.received')
  async handleMessageReceived(payload: {
    jid: string;
    participant: string;
    senderName: string;
    chatType: string;
    chatName?: string;
  }) {
    // Only track SLA for Group chats
    if (payload.chatType !== 'Group') {
      return;
    }

    const participantPhone = payload.participant.split('@')[0].split(':')[0];

    if (this.hrPhones.has(participantPhone)) {
      this.logger.log(
        `HR member ${participantPhone} replied in ${payload.jid}, stopping SLA timer.`,
      );
      await this.handleMessageReplied({ jid: payload.jid });
      return;
    }

    // Only track if not already tracking (first unanswered message starts the timer)
    if (!this.pendingMessages.has(payload.jid)) {
      const tz = this.getTimezone();
      const now = DateTime.now().setZone(tz);
      const deadline = this.calculateDeadline(now);

      const msg: PendingMessage = {
        ...payload,
        receivedAtISO: now.toISO() as string,
        deadlineISO: deadline.toISO() as string,
        notified: false,
      };

      this.pendingMessages.set(payload.jid, msg);

      this.logger.log(
        `Timer started for ${payload.jid}. Deadline: ${deadline.toISO()}`,
      );

      try {
        await this.d1Service.insertPendingMessage(msg);
      } catch (e) {
        this.logger.error('Failed to save message to D1', e);
      }
    }
  }

  @OnEvent('message.replied')
  async handleMessageReplied(payload: { jid: string }) {
    if (this.pendingMessages.has(payload.jid)) {
      this.pendingMessages.delete(payload.jid);
      this.logger.log(`Replied to ${payload.jid}, timer stopped.`);

      try {
        await this.d1Service.deletePendingMessage(payload.jid);
      } catch (e) {
        this.logger.error('Failed to delete message from D1', e);
      }
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async checkSlaBreaches() {
    const tz = this.getTimezone();
    const now = DateTime.now().setZone(tz);

    for (const [jid, msg] of this.pendingMessages.entries()) {
      if (msg.notified) continue;

      const deadline = DateTime.fromISO(msg.deadlineISO, { zone: tz });
      if (now >= deadline) {
        this.logger.warn(`SLA breached for ${jid} (${msg.senderName})!`);

        await this.sendTelegramAlert(msg);

        msg.notified = true;
        try {
          await this.d1Service.markAsNotified(jid);
        } catch (e) {
          this.logger.error('Failed to update notified status in D1', e);
        }
      }
    }
  }

  private async sendTelegramAlert(msg: PendingMessage) {
    if (!this.bot) return;

    const hrChatId = this.configService.get<string>('TELEGRAM_HR_CHAT_ID');
    const groupChatId = this.configService.get<string>(
      'TELEGRAM_GROUP_CHAT_ID',
    );

    // If chatName is available, we could include it, but the original text didn't have it.
    // Let's add it dynamically if it exists.
    const groupContext = msg.chatName ? ` in *${msg.chatName}*` : '';
    const text = `👋 Hello there! Just a friendly reminder that *${msg.senderName}*${groupContext} has been waiting for a reply for a while. Let's make sure to get back to them soon! 🚀`;

    try {
      if (hrChatId) {
        await this.bot.telegram.sendMessage(hrChatId, text, {
          parse_mode: 'Markdown',
        });
        this.logger.log(`Sent alert to HR (${hrChatId})`);
      }
      if (groupChatId) {
        let groupText = text;
        if (hrChatId) {
          try {
            const chat = await this.bot.telegram.getChat(hrChatId);
            if ('username' in chat && chat.username) {
              groupText = `${text}\n\ncc: @${chat.username}`;
            } else if ('first_name' in chat && chat.first_name) {
              groupText = `${text}\n\ncc: [${chat.first_name}](tg://user?id=${hrChatId})`;
            } else {
              groupText = `${text}\n\ncc: [HR](tg://user?id=${hrChatId})`;
            }
          } catch (err) {
            const errorMessage =
              err instanceof Error ? err.message : String(err);
            this.logger.warn(`Could not fetch HR chat info: ${errorMessage}`);
            groupText = `${text}\n\ncc: [HR](tg://user?id=${hrChatId})`;
          }
        }

        await this.bot.telegram.sendMessage(groupChatId, groupText, {
          parse_mode: 'Markdown',
        });
        this.logger.log(`Sent alert to Group (${groupChatId})`);
      }
    } catch (e) {
      this.logger.error('Failed to send Telegram alert', e);
    }
  }

  async clearAllPendingMessages() {
    this.pendingMessages.clear();
    this.logger.log('Cleared all pending messages from memory.');

    try {
      await this.d1Service.deleteAllPendingMessages();
      this.logger.log('Cleared all pending messages from D1.');
    } catch (e) {
      this.logger.error('Failed to clear pending messages from D1', e);
    }
  }
}
