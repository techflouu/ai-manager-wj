import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { D1Response } from './interfaces/d1response';

export interface PendingMessage {
  jid: string;
  senderName: string;
  chatName?: string;
  chatType: string;
  receivedAtISO: string;
  deadlineISO: string;
  notified: boolean;
}

@Injectable()
export class D1Service implements OnModuleInit {
  private readonly logger = new Logger(D1Service.name);
  private accountId: string;
  private apiToken: string;
  private dbId: string;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    this.accountId = this.configService.get<string>(
      'CLOUDFLARE_ACCOUNT_ID',
      '',
    );
    this.apiToken = this.configService.get<string>('CLOUDFLARE_API_TOKEN', '');
    this.dbId = this.configService.get<string>('CLOUDFLARE_D1_DB_ID', '');

    if (!this.accountId || !this.apiToken || !this.dbId) {
      this.logger.warn(
        'Cloudflare D1 credentials are not fully configured in .env',
      );
    }
  }

  async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
    if (!this.accountId || !this.apiToken || !this.dbId) {
      this.logger.error('Cannot execute query: missing D1 credentials.');
      return [];
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.dbId}/query`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiToken}`,
        },
        body: JSON.stringify({
          sql,
          params,
        }),
      });

      const data = (await response.json()) as D1Response;

      if (!response.ok || !data.success) {
        this.logger.error(`D1 Query failed: ${JSON.stringify(data.errors)}`);
        return [];
      }

      return data.result?.[0]?.results || [];
    } catch (error) {
      this.logger.error('Failed to communicate with Cloudflare D1 API', error);
      return [];
    }
  }

  async createTableIfNotExists() {
    const sql = `
      CREATE TABLE IF NOT EXISTS pending_messages (
        jid TEXT PRIMARY KEY,
        senderName TEXT,
        chatName TEXT,
        chatType TEXT,
        receivedAtISO TEXT,
        deadlineISO TEXT,
        notified INTEGER
      );
    `;
    await this.query(sql);
    this.logger.log('Ensured pending_messages table exists in D1.');

    const sqlHrPhones = `
      CREATE TABLE IF NOT EXISTS hr_phones (
        phone TEXT PRIMARY KEY
      );
    `;
    await this.query(sqlHrPhones);
    this.logger.log('Ensured hr_phones table exists in D1.');
  }

  async getAllPendingMessages(): Promise<PendingMessage[]> {
    const rows = await this.query(`SELECT * FROM pending_messages`);
    return rows.map((row) => {
      const r = row as {
        jid: string;
        senderName: string;
        chatName?: string;
        chatType: string;
        receivedAtISO: string;
        deadlineISO: string;
        notified: number;
      };

      return {
        jid: r.jid,
        senderName: r.senderName,
        chatName: r.chatName,
        chatType: r.chatType,
        receivedAtISO: r.receivedAtISO,
        deadlineISO: r.deadlineISO,
        notified: Boolean(r.notified),
      };
    });
  }

  async insertPendingMessage(msg: PendingMessage) {
    const sql = `
      INSERT INTO pending_messages (jid, senderName, chatName, chatType, receivedAtISO, deadlineISO, notified)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        senderName=excluded.senderName,
        chatName=excluded.chatName,
        chatType=excluded.chatType,
        receivedAtISO=excluded.receivedAtISO,
        deadlineISO=excluded.deadlineISO,
        notified=excluded.notified
    `;
    const params = [
      msg.jid,
      msg.senderName,
      msg.chatName || '',
      msg.chatType,
      msg.receivedAtISO,
      msg.deadlineISO,
      msg.notified ? 1 : 0,
    ];
    await this.query(sql, params);
  }

  async deletePendingMessage(jid: string) {
    await this.query(`DELETE FROM pending_messages WHERE jid = ?`, [jid]);
  }

  async deleteAllPendingMessages() {
    await this.query(`DELETE FROM pending_messages`);
  }

  async markAsNotified(jid: string) {
    await this.query(`UPDATE pending_messages SET notified = 1 WHERE jid = ?`, [
      jid,
    ]);
  }

  async getAllHrPhones(): Promise<string[]> {
    const rows = await this.query(`SELECT phone FROM hr_phones`);
    return rows.map((row) => {
      const r = row as { phone: string };
      return r.phone;
    });
  }

  async addHrPhone(phone: string) {
    await this.query(
      `INSERT INTO hr_phones (phone) VALUES (?) ON CONFLICT(phone) DO NOTHING`,
      [phone],
    );
  }

  async removeHrPhone(phone: string) {
    await this.query(`DELETE FROM hr_phones WHERE phone = ?`, [phone]);
  }
}
