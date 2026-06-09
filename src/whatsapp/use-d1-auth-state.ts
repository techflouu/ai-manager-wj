/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

import {
  initAuthCreds,
  BufferJSON,
  proto,
  AuthenticationState,
  AuthenticationCreds,
  SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { D1Service } from '../d1/d1.service';

export const useD1AuthState = async (
  d1Service: D1Service,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
  const writeData = async (data: any, key: string) => {
    const str = JSON.stringify(data, BufferJSON.replacer);
    await d1Service.query(
      `INSERT INTO baileys_auth (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data=excluded.data`,
      [key, str],
    );
  };

  const readData = async (key: string) => {
    const rows = await d1Service.query(
      `SELECT data FROM baileys_auth WHERE key = ?`,
      [key],
    );
    if (rows.length > 0) {
      const str = (rows[0] as { data: string }).data;
      try {
        return JSON.parse(str, BufferJSON.reviver);
      } catch {
        return null;
      }
    }
    return null;
  };

  const readDataBatch = async (keys: string[]) => {
    if (keys.length === 0) return {};

    const results: { [key: string]: any } = {};
    const chunkSize = 80;

    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = await d1Service.query(
        `SELECT key, data FROM baileys_auth WHERE key IN (${placeholders})`,
        chunk,
      );

      for (const row of rows) {
        const r = row as { key: string; data: string };
        try {
          results[r.key] = JSON.parse(r.data, BufferJSON.reviver);
        } catch {
          // ignore parsing error
        }
      }
    }
    return results;
  };

  let creds: AuthenticationCreds = await readData('creds');
  if (!creds) {
    creds = initAuthCreds();
    await writeData(creds, 'creds');
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: { [_: string]: SignalDataTypeMap[typeof type] } = {};
          const keysToFetch = ids.map((id) => `${type}-${id}`);
          const fetchedData = await readDataBatch(keysToFetch);

          for (const id of ids) {
            let value = fetchedData[`${type}-${id}`];
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }

          return data;
        },
        set: async (data) => {
          const insertKeys: string[] = [];
          const insertData: string[] = [];
          const deleteKeys: string[] = [];

          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) {
                insertKeys.push(key);
                insertData.push(JSON.stringify(value, BufferJSON.replacer));
              } else {
                deleteKeys.push(key);
              }
            }
          }

          if (insertKeys.length > 0) {
            const chunkSize = 40;
            for (let i = 0; i < insertKeys.length; i += chunkSize) {
              const keysChunk = insertKeys.slice(i, i + chunkSize);
              const dataChunk = insertData.slice(i, i + chunkSize);

              const placeholders = keysChunk.map(() => '(?, ?)').join(', ');
              const params: unknown[] = [];
              for (let j = 0; j < keysChunk.length; j++) {
                params.push(keysChunk[j], dataChunk[j]);
              }

              await d1Service.query(
                `INSERT INTO baileys_auth (key, data) VALUES ${placeholders} ON CONFLICT(key) DO UPDATE SET data=excluded.data`,
                params,
              );
            }
          }

          if (deleteKeys.length > 0) {
            const chunkSize = 80;
            for (let i = 0; i < deleteKeys.length; i += chunkSize) {
              const keysChunk = deleteKeys.slice(i, i + chunkSize);
              const placeholders = keysChunk.map(() => '?').join(', ');
              await d1Service.query(
                `DELETE FROM baileys_auth WHERE key IN (${placeholders})`,
                keysChunk,
              );
            }
          }
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds'),
  };
};
