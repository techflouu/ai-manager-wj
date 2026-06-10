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
import { WhatsappService } from '../whatsapp/whatsapp.service';

@Injectable()
export class SlaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SlaService.name);
  private pendingMessages: Map<string, PendingMessage> = new Map();
  private hrRecords: Map<string, string | null> = new Map();
  private bot: Telegraf | null = null;

  constructor(
    private configService: ConfigService,
    private d1Service: D1Service,
    private whatsappService: WhatsappService,
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

    this.bot.command('list_hr', async (ctx) => {
      let text = '';
      if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
        text += `Group Chat ID: ${ctx.chat.id}\n`;
        if (ctx.from) {
          text += `Your Personal User ID: ${ctx.from.id}\n\n`;
        } else {
          text += '\n';
        }
      } else {
        text += `Your Telegram Chat ID: ${ctx.chat.id}\n\n`;
      }

      if (this.hrRecords.size === 0) {
        text += 'No HR phone numbers are currently tracked.';
        await ctx.reply(text);
        return;
      }

      const list = Array.from(this.hrRecords.entries())
        .map(
          ([p, t]) => `• Phone: ${p} | Telegram ID: ${t ? t : '(Not Added)'}`,
        )
        .join('\n');
      text += `Tracked HR Records:\n${list}`;
      await ctx.reply(text);
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

      if (!this.hrRecords.has(phone)) {
        this.hrRecords.set(phone, null);
      }
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

      if (this.hrRecords.has(phone)) {
        this.hrRecords.delete(phone);
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

    this.bot.command('add_hr_telegram', async (ctx) => {
      const parts = ctx.message.text.split(' ');
      if (parts.length < 2) {
        await ctx.reply(
          'Usage: /add_hr_telegram <phone_number> [chat_id]\nExample: /add_hr_telegram 6281234567890\nIf chat_id is omitted, your current chat ID is used.',
        );
        return;
      }
      const phone = parts[1].replace(/\D/g, '');

      let chatId = parts[2] ? parts[2].trim() : '';
      if (!chatId) {
        if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
          if (!ctx.from) {
            await ctx.reply(
              'Could not determine your user ID. Please provide it explicitly.',
            );
            return;
          }
          chatId = String(ctx.from.id);
          await ctx.reply(
            `Detected group chat. Using your personal user ID (${chatId}) instead of the group ID.\n\n*Important:* Make sure you have sent at least one private message to me, otherwise I won't be able to send you SLA alerts!`,
            { parse_mode: 'Markdown' },
          );
        } else {
          chatId = String(ctx.chat.id);
        }
      }

      if (!this.hrRecords.has(phone)) {
        await ctx.reply(
          `Phone number ${phone} is not tracked. Please add it first using /add_hr_phone.`,
        );
        return;
      }

      this.hrRecords.set(phone, chatId);
      try {
        await this.d1Service.updateHrTelegramId(phone, chatId);
        await ctx.reply(
          `Successfully linked Telegram ID ${chatId} to HR phone ${phone}.`,
        );
      } catch (err) {
        await ctx.reply('Failed to save to database.');
        this.logger.error('Failed to link HR telegram id', err);
      }
    });

    this.bot.command('remove_hr_telegram', async (ctx) => {
      const parts = ctx.message.text.split(' ');
      if (parts.length < 2) {
        await ctx.reply(
          'Usage: /remove_hr_telegram <phone_number>\nExample: /remove_hr_telegram 6281234567890',
        );
        return;
      }
      const phone = parts[1].replace(/\D/g, '');

      if (!this.hrRecords.has(phone)) {
        await ctx.reply(`Phone number ${phone} is not tracked.`);
        return;
      }

      this.hrRecords.set(phone, null);
      try {
        await this.d1Service.updateHrTelegramId(phone, null);
        await ctx.reply(
          `Successfully removed Telegram ID from HR phone ${phone}.`,
        );
      } catch (err) {
        await ctx.reply('Failed to update database.');
        this.logger.error('Failed to remove HR telegram id', err);
      }
    });

    this.bot.command('weekly_report', async (ctx) => {
      await this.sendWeeklyReport(ctx.chat.id);
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

      const hrRecords = await this.d1Service.getAllHrRecords();
      for (const r of hrRecords) {
        this.hrRecords.set(r.phone, r.telegramChatId);
      }
      this.logger.log(
        `Loaded ${this.hrRecords.size} HR records from D1 storage.`,
      );
    } catch (e) {
      this.logger.error('Failed to load state from D1', e);
    }
  }

  private getTimezone(): string {
    return this.configService.get<string>('TIMEZONE') || 'UTC+8';
  }

  private calculateDeadline(receivedAt: DateTime): DateTime {
    // strict 2 hours later alarm even outside office hours
    return receivedAt.plus({ hours: 2 });
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

    try {
      await this.d1Service.upsertTrackedGroup(
        payload.jid,
        payload.chatName || '',
      );
    } catch (e) {
      this.logger.error('Failed to upsert tracked group in D1', e);
    }

    const participantPhone = payload.participant.split('@')[0].split(':')[0];

    if (this.hrRecords.has(participantPhone)) {
      this.logger.log(
        `HR member ${participantPhone} replied in ${payload.jid}, stopping SLA timer.`,
      );
      const tz = this.getTimezone();
      const nowISO = DateTime.now().setZone(tz).toISO() as string;
      try {
        await this.d1Service.updateGroupHrMessageTime(payload.jid, nowISO);
      } catch (e) {
        this.logger.error('Failed to update group HR message time in D1', e);
      }
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
  async handleMessageReplied(payload: {
    jid: string;
    isGroup?: boolean;
    chatName?: string;
  }) {
    if (payload.isGroup) {
      try {
        await this.d1Service.upsertTrackedGroup(
          payload.jid,
          payload.chatName || '',
        );
        const tz = this.getTimezone();
        const nowISO = DateTime.now().setZone(tz).toISO() as string;
        await this.d1Service.updateGroupHrMessageTime(payload.jid, nowISO);
      } catch (e) {
        this.logger.error(
          'Failed to update group HR message time on bot reply in D1',
          e,
        );
      }
    }

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
      const deadline = DateTime.fromISO(msg.deadlineISO, { zone: tz });
      if (now >= deadline) {
        this.logger.warn(`SLA breached for ${jid} (${msg.senderName})!`);

        const isWeekend = now.weekday === 6 || now.weekday === 7;
        const isBeforeOfficeHours = now.hour < 9;
        const isAfterOfficeHours = now.hour >= 18;
        const isOutsideWorkingHours =
          isWeekend || isBeforeOfficeHours || isAfterOfficeHours;

        await this.sendTelegramAlert(msg, isOutsideWorkingHours);

        // Update the deadline for the next alert instead of marking as permanently notified
        const nextDeadline = this.calculateDeadline(now);
        msg.deadlineISO = nextDeadline.toISO() as string;
        msg.notified = false;

        try {
          await this.d1Service.insertPendingMessage(msg);
        } catch (e) {
          this.logger.error(
            'Failed to update pending message deadline in D1',
            e,
          );
        }
      }
    }
  }

  private async sendTelegramAlert(
    msg: PendingMessage,
    isOutsideWorkingHours: boolean = false,
  ) {
    if (!this.bot) return;

    const allHrPhones = Array.from(this.hrRecords.keys());
    let groupParticipants: {
      id: string;
      lid?: string;
      phoneNumber?: string;
    }[] = [];
    if (msg.chatType === 'Group') {
      groupParticipants = await this.whatsappService.getGroupParticipants(
        msg.jid,
      );
    }

    const targetedHrChatIds: string[] = [];
    const missingHrTelegramPhones: string[] = [];
    for (const phone of allHrPhones) {
      // Check id, lid, and phoneNumber fields for the phone number
      const isInGroup = groupParticipants.some((participant) => {
        const pId = participant.id || '';
        const pLid = participant.lid || '';
        const pPhone = participant.phoneNumber || '';
        return (
          pId.startsWith(phone + '@') ||
          pLid.startsWith(phone + '@') ||
          pPhone.startsWith(phone + '@')
        );
      });
      const tgId = this.hrRecords.get(phone);
      this.logger.log(`HR Phone ${phone}: inGroup=${isInGroup}, tgId=${tgId}`);
      if (isInGroup) {
        if (tgId) {
          targetedHrChatIds.push(tgId);
        } else {
          missingHrTelegramPhones.push(phone);
        }
      }
    }
    this.logger.log(
      `Targeted HR Chat IDs: ${JSON.stringify(targetedHrChatIds)}`,
    );

    const groupChatId = this.configService.get<string>(
      'TELEGRAM_GROUP_CHAT_ID',
    );

    // If chatName is available, we could include it, but the original text didn't have it.
    // Let's add it dynamically if it exists.
    const groupContext = msg.chatName ? ` in *${msg.chatName}*` : '';
    let text = `👋 Hello there! Just a friendly reminder that *${msg.senderName}*${groupContext} has been waiting for a reply for a while. Let's make sure to get back to them soon! 🚀`;

    if (isOutsideWorkingHours) {
      text += `\n\n_Note: It is currently outside working hours. Please reply tomorrow during working hours._`;
    }

    try {
      for (const hrChatId of targetedHrChatIds) {
        try {
          await this.bot.telegram.sendMessage(hrChatId, text, {
            parse_mode: 'Markdown',
          });
          this.logger.log(`Sent alert to HR (${hrChatId})`);
        } catch (e) {
          this.logger.error(`Failed to send alert to HR (${hrChatId})`, e);
        }
      }

      if (groupChatId) {
        let groupText = text;
        if (targetedHrChatIds.length > 0) {
          const ccs: string[] = [];
          for (const hrChatId of targetedHrChatIds) {
            try {
              const chat = await this.bot.telegram.getChat(hrChatId);
              if ('username' in chat && chat.username) {
                ccs.push(`@${chat.username}`);
              } else if ('first_name' in chat && chat.first_name) {
                ccs.push(`[${chat.first_name}](tg://user?id=${hrChatId})`);
              } else {
                ccs.push(`[HR](tg://user?id=${hrChatId})`);
              }
            } catch (err) {
              const errorMessage =
                err instanceof Error ? err.message : String(err);
              this.logger.warn(`Could not fetch HR chat info: ${errorMessage}`);
              ccs.push(`[HR](tg://user?id=${hrChatId})`);
            }
          }
          groupText = `${text}\n\ncc: ${ccs.join(', ')}`;
        } else if (missingHrTelegramPhones.length > 0) {
          const missingList = missingHrTelegramPhones
            .map((p) => `• ${p}`)
            .join('\n');
          groupText = `${text}\n\n⚠️ The following HR numbers in this group do not have Telegram IDs linked:\n${missingList}`;
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

  @Cron('0 17 * * *', { timeZone: process.env.TIMEZONE || 'Asia/Singapore' })
  async dailyGroupReport() {
    const groupChatId = this.configService.get<string>(
      'TELEGRAM_GROUP_CHAT_ID',
    );
    if (groupChatId) {
      await this.sendWeeklyReport(groupChatId);
    }
  }

  private async sendWeeklyReport(chatId: string | number) {
    if (!this.bot) return;

    try {
      const groups = await this.d1Service.getAllTrackedGroups();
      const tz = this.getTimezone();
      const now = DateTime.now().setZone(tz);
      const startOfWeek = now.startOf('week');

      const messaged: string[] = [];
      const notMessaged: string[] = [];

      for (const g of groups) {
        const name = g.chatName || g.jid;
        if (g.lastHrMessageAtISO) {
          const lastTime = DateTime.fromISO(g.lastHrMessageAtISO, { zone: tz });
          if (lastTime >= startOfWeek) {
            messaged.push(`✅ ${name}`);
          } else {
            notMessaged.push(
              `❌ ${name} (Last: ${lastTime.toFormat('dd MMM')})`,
            );
          }
        } else {
          notMessaged.push(`❌ ${name} (Never)`);
        }
      }

      let text = `📊 *Daily HR Group Activity Report*\n_Week starting: ${startOfWeek.toFormat('dd MMM yyyy')}_\n\n`;
      text += `*Needs Attention (${notMessaged.length}):*\n`;
      text += notMessaged.length > 0 ? notMessaged.join('\n') : 'All good! 🎉';
      text += `\n\n*Messaged This Week (${messaged.length}):*\n`;
      text += messaged.length > 0 ? messaged.join('\n') : 'None yet.';

      await this.bot.telegram.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
      });
    } catch (e) {
      this.logger.error('Failed to generate weekly report', e);
    }
  }
}
