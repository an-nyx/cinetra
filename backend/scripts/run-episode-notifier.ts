/**
 * Local manual trigger for one new-episode notification pass (development and testing only).
 *
 *   npx ts-node scripts/run-episode-notifier.ts            # dry run: mock sender, prints payloads, records ledger rows
 *   npx ts-node scripts/run-episode-notifier.ts --send     # real Web Push to the local database's subscriptions
 *
 * Refuses to run with NODE_ENV=production or against a database that is not on this machine. Saved tracking is only
 * read. Note that a dry run still records ledger rows as "sent", so those episodes are not announced again.
 */
import 'dotenv/config';
import { prisma } from '../src/database/prisma';
import { runEpisodeNotifications } from '../src/services/notifications/episode-notifier.service';
import { defaultSender, type PushSender } from '../src/services/notifications/push-sender';

function assertLocal() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run: NODE_ENV=production');
  let host = '';
  try { host = new URL(process.env.DATABASE_URL || '').hostname; } catch { /* reported below */ }
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('Refusing to run: DATABASE_URL must point to a local database');
}

const mockSender: PushSender = {
  async send(_target, payload) {
    console.log(`[mock push] ${payload.title} — ${payload.body} (opens ${payload.url})`);
    return { statusCode: 201 };
  },
};

async function main() {
  assertLocal();
  const send = process.argv.includes('--send');
  const sender = send ? defaultSender() : mockSender;
  if (!sender) throw new Error('--send needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT');
  console.log(send ? 'Sending real Web Push notifications to local subscriptions…' : 'Dry run with a mock push sender…');
  const report = await runEpisodeNotifications({ sender });
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
