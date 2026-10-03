import mongoose from 'mongoose';
import { getModels } from '../../getModels';
import { FeatureKeys, resolveStoreEffectiveFeatures } from '../featureCatalog';
import { buildFeieyunReceiptContent } from './buildFeieyunReceipt';
import {
  CLOUD_PRINT_AUTO_KEY,
  CLOUD_PRINT_COPIES_KEY,
  CLOUD_PRINT_ENABLED_KEY,
  parseCloudPrintAutoCheckout,
  parseCloudPrintCopies,
  parseCloudPrintEnabled,
} from './config';
import { feieyunPrintMsg, isFeieyunConfigured } from './feieyunClient';
import { loadCloudPrintOrderTicket, loadCloudPrintReceipt } from './loadReceipt';

export type CloudPrintTrigger = 'checkout' | 'reprint' | 'placement' | 'append';

export type CloudPrintJobResult = {
  skipped?: string;
  printed?: Array<{ sn: string; ok: boolean; msg: string; orderId?: string }>;
};

export async function runStoreCloudPrint(opts: {
  storeId: mongoose.Types.ObjectId;
  checkoutId?: mongoose.Types.ObjectId;
  orderId?: mongoose.Types.ObjectId;
  trigger: CloudPrintTrigger;
  onlyLineIds?: string[];
}): Promise<CloudPrintJobResult> {
  if (!isFeieyunConfigured()) {
    return { skipped: 'feieyun_unconfigured' };
  }

  const features = await resolveStoreEffectiveFeatures(opts.storeId);
  if (!features.has(FeatureKeys.CloudPrint)) {
    return { skipped: 'feature_off' };
  }

  const { CloudPrinter, SystemConfig } = getModels() as {
    CloudPrinter: mongoose.Model<any>;
    SystemConfig: mongoose.Model<any>;
  };

  const printers = await CloudPrinter.find({ storeId: opts.storeId }).sort({ createdAt: 1 }).lean() as unknown as Array<{ sn: string }>;
  if (printers.length === 0) {
    return { skipped: 'no_printer' };
  }

  const cfgRows = await SystemConfig.find({
    storeId: opts.storeId,
    key: { $in: [CLOUD_PRINT_ENABLED_KEY, CLOUD_PRINT_COPIES_KEY, CLOUD_PRINT_AUTO_KEY] },
  }).lean() as unknown as Array<{ key: string; value: string }>;
  const cfg: Record<string, string> = {};
  for (const r of cfgRows) cfg[r.key] = r.value;

  if (!parseCloudPrintEnabled(cfg[CLOUD_PRINT_ENABLED_KEY])) {
    return { skipped: 'disabled' };
  }
  if (opts.trigger === 'checkout' && !parseCloudPrintAutoCheckout(cfg[CLOUD_PRINT_AUTO_KEY])) {
    return { skipped: 'auto_off' };
  }

  let receipt;
  if (opts.trigger === 'placement' || opts.trigger === 'append') {
    receipt = opts.orderId
      ? await loadCloudPrintOrderTicket(opts.storeId, opts.orderId, {
          ticketKind: opts.trigger,
          onlyLineIds: opts.onlyLineIds,
        })
      : null;
  } else {
    receipt = opts.checkoutId ? await loadCloudPrintReceipt(opts.storeId, opts.checkoutId) : null;
  }
  if (!receipt) {
    return { skipped: (opts.trigger === 'placement' || opts.trigger === 'append') ? 'order_not_found' : 'checkout_not_found' };
  }

  const content = buildFeieyunReceiptContent(receipt);
  const copies = parseCloudPrintCopies(cfg[CLOUD_PRINT_COPIES_KEY]);
  const printed: CloudPrintJobResult['printed'] = [];
  for (const p of printers) {
    const sn = String(p.sn || '').trim();
    if (!sn) continue;
    const r = await feieyunPrintMsg(sn, content, copies);
    printed.push({ sn, ok: r.ok, msg: r.msg, orderId: r.orderId });
    if (!r.ok) {
      console.error(`[cloud-print] sn=${sn} ret=${r.ret} ${r.msg}`);
    }
  }
  return { printed };
}

export function scheduleStoreCloudPrint(storeId: mongoose.Types.ObjectId, checkoutId: mongoose.Types.ObjectId, trigger: CloudPrintTrigger): void {
  void runStoreCloudPrint({ storeId, checkoutId, trigger }).catch((err) => {
    console.error('[cloud-print]', err);
  });
}

/** 手持下单/加菜：不走结账自动开关，店铺开了云打印即推飞鹅。 */
export function scheduleOrderCloudPrint(
  storeId: mongoose.Types.ObjectId,
  orderId: mongoose.Types.ObjectId,
  trigger: 'placement' | 'append',
  onlyLineIds?: string[],
): void {
  void runStoreCloudPrint({ storeId, orderId, trigger, onlyLineIds }).catch((err) => {
    console.error('[cloud-print]', err);
  });
}
